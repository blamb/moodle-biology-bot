/**
 * Post-launch API routes — all guarded by ltijs's session validator middleware
 * (because they hang off lti.app). On each request, res.locals.token has the
 * validated LTI claims.
 *
 *   GET  /api/units                         List all units with summary metadata
 *   POST /api/tutor/session                 { unit_no } -> { session, turns }
 *   POST /api/tutor/turn                    { session_id, message } -> SSE stream
 */

import express from 'express';
import type { Request, Response } from 'express';
import type { IdToken } from 'ltijs';
import { lti } from './lti.js';
import { query } from './db.js';
import { listUnits } from './content.js';
import { findOrCreateStudent } from './students.js';
import {
  getOrCreateActiveSession,
  getTurns,
  streamSocraticReply,
} from './tutor.js';
import {
  generateMC,
  generateTF,
  generateFITB,
  generateFR,
  gradeMC,
  gradeTF,
  gradeFITB,
  gradeFR,
  type Difficulty,
  type QuizKind,
  type McQuestion,
  type TfQuestion,
  type FitbQuestion,
  type FrQuestion,
  type FrGrade,
} from './quiz.js';
import { getUnit } from './content.js';
import { getStudentProgress } from './progress.js';
import {
  synthesizeQuiz,
  explainAttempt,
  type AttemptForCoaching,
} from './coach.js';

// ltijs doesn't install a JSON body parser globally; do it for our routes.
lti.app.use('/api', express.json({ limit: '256kb' }));

function tokenOf(res: Response): IdToken {
  const token = res.locals.token as IdToken | undefined;
  if (!token) throw new Error('No LTI token on request (middleware bug?)');
  return token;
}

async function studentFromToken(token: IdToken) {
  return findOrCreateStudent({
    sub: token.user,
    iss: token.iss,
    contextId: token.platformContext.contextId,
    displayName:
      token.userInfo.name ||
      [token.userInfo.given_name, token.userInfo.family_name].filter(Boolean).join(' ') ||
      'Student',
  });
}

lti.app.get('/api/units', (req: Request, res: Response) => {
  res.json({ units: listUnits() });
});

lti.app.get('/api/progress', async (req: Request, res: Response) => {
  try {
    const token = tokenOf(res);
    const student = await studentFromToken(token);
    const progress = await getStudentProgress(student.id);
    res.json(progress);
  } catch (e) {
    console.error('GET /api/progress failed:', e);
    res.status(500).json({ error: (e as Error).message });
  }
});

lti.app.post('/api/tutor/session', async (req: Request, res: Response) => {
  try {
    const token = tokenOf(res);
    const student = await studentFromToken(token);
    const unitNo = parseInt(String(req.body?.unit_no ?? ''), 10);
    if (!Number.isInteger(unitNo) || unitNo < 1 || unitNo > 17) {
      return res.status(400).json({ error: 'unit_no must be an integer 1–17' });
    }
    const session = await getOrCreateActiveSession(student.id, unitNo);
    const turns = await getTurns(session.id);
    res.json({ session, turns });
  } catch (e) {
    console.error('POST /api/tutor/session failed:', e);
    res.status(500).json({ error: (e as Error).message });
  }
});

// ─── Quiz: generate ─────────────────────────────────────────────────────────

const VALID_KINDS: QuizKind[] = ['mc', 'tf', 'fitb', 'fr'];
const VALID_DIFFICULTIES: Difficulty[] = ['introductory', 'intermediate', 'advanced'];

lti.app.post('/api/quiz/generate', async (req: Request, res: Response) => {
  try {
    const token = tokenOf(res);
    const student = await studentFromToken(token);

    const unitNo = parseInt(String(req.body?.unit_no ?? ''), 10);
    const kind = String(req.body?.kind ?? '') as QuizKind;
    const count = Math.min(20, Math.max(1, parseInt(String(req.body?.count ?? '5'), 10) || 5));
    const difficulty = String(req.body?.difficulty ?? 'intermediate') as Difficulty;

    if (!Number.isInteger(unitNo) || unitNo < 1 || unitNo > 17) {
      return res.status(400).json({ error: 'unit_no must be 1–17' });
    }
    if (!VALID_KINDS.includes(kind)) {
      return res.status(400).json({ error: `kind must be one of: ${VALID_KINDS.join(', ')}` });
    }
    if (!VALID_DIFFICULTIES.includes(difficulty)) {
      return res.status(400).json({ error: `difficulty must be one of: ${VALID_DIFFICULTIES.join(', ')}` });
    }

    let questions: McQuestion[] | TfQuestion[] | FitbQuestion[] | FrQuestion[];
    if (kind === 'mc') questions = await generateMC(unitNo, count, difficulty);
    else if (kind === 'tf') questions = await generateTF(unitNo, count, difficulty);
    else if (kind === 'fitb') questions = await generateFITB(unitNo, count, difficulty);
    else questions = await generateFR(unitNo, count, difficulty);

    // Create a session and stash the generated questions in summary so the
    // student can come back to the same set without re-generating.
    const sessionKind = `quiz_${kind}`;
    const sessions = await query<{ id: number }>(
      `insert into session (student_id, kind, unit_no, summary) values ($1, $2, $3, $4) returning id`,
      [student.id, sessionKind, unitNo, JSON.stringify({ difficulty, questions })]
    );
    const sessionId = sessions[0]!.id;
    res.json({ session_id: sessionId, kind, unit_no: unitNo, difficulty, questions });
  } catch (e) {
    console.error('POST /api/quiz/generate failed:', e);
    res.status(500).json({ error: (e as Error).message });
  }
});

// ─── Quiz: answer one question ──────────────────────────────────────────────

lti.app.post('/api/quiz/answer', async (req: Request, res: Response) => {
  try {
    const token = tokenOf(res);
    const student = await studentFromToken(token);

    const sessionId = parseInt(String(req.body?.session_id ?? ''), 10);
    const questionIndex = parseInt(String(req.body?.question_index ?? ''), 10);
    const response = req.body?.response;

    if (!Number.isInteger(sessionId) || !Number.isInteger(questionIndex)) {
      return res.status(400).json({ error: 'session_id and question_index required' });
    }

    const rows = await query<{
      id: number;
      student_id: number;
      kind: string;
      unit_no: number;
      summary: { difficulty: Difficulty; questions: unknown[] };
    }>(
      `select id, student_id, kind, unit_no, summary from session where id=$1`,
      [sessionId]
    );
    if (!rows.length || rows[0]!.student_id !== student.id) {
      return res.status(404).json({ error: 'session not found' });
    }
    const session = rows[0]!;
    const kind = session.kind.replace(/^quiz_/, '') as QuizKind;
    const question = session.summary.questions?.[questionIndex];
    if (!question) return res.status(400).json({ error: 'question_index out of range' });

    let correct = false;
    let normalized: string | null = null;
    let scoredScore: number | null = null;
    let feedbackText: string;
    let frGrade: FrGrade | null = null;

    if (kind === 'mc') {
      const q = question as McQuestion;
      correct = gradeMC(q, parseInt(String(response), 10));
      feedbackText = q.explanation;
    } else if (kind === 'tf') {
      const q = question as TfQuestion;
      correct = gradeTF(q, response === true || response === 'true');
      feedbackText = q.explanation;
    } else if (kind === 'fitb') {
      const q = question as FitbQuestion;
      const r = gradeFITB(q, String(response ?? ''));
      correct = r.correct;
      normalized = r.normalized_response;
      feedbackText = q.explanation;
    } else {
      // Free response — LLM-graded against the rubric.
      const q = question as FrQuestion;
      const unit = getUnit(session.unit_no);
      frGrade = await gradeFR(unit, q, String(response ?? ''));
      scoredScore = Math.round((frGrade.total_awarded / frGrade.total_possible) * 100);
      // Count as "correct" for progress purposes if ≥ 80% of total marks.
      correct = scoredScore >= 80;
      feedbackText = JSON.stringify(frGrade);
    }

    await query(
      `insert into quiz_attempt (session_id, unit_no, kind, question, response, scored_correct, scored_score, feedback)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        sessionId,
        session.unit_no,
        kind,
        JSON.stringify(question),
        typeof response === 'string' ? response : JSON.stringify(response),
        correct,
        scoredScore,
        feedbackText,
      ]
    );

    await query(
      `insert into progress_summary (student_id, unit_no, kind, attempts, correct, last_at)
       values ($1, $2, $3, 1, $4, now())
       on conflict (student_id, unit_no, kind)
       do update set attempts = progress_summary.attempts + 1,
                     correct  = progress_summary.correct + excluded.correct,
                     last_at  = now()`,
      [student.id, session.unit_no, kind, correct ? 1 : 0]
    );

    if (kind === 'mc') {
      const q = question as McQuestion;
      res.json({ correct, explanation: q.explanation, correct_index: q.correct_index });
    } else if (kind === 'tf') {
      const q = question as TfQuestion;
      res.json({ correct, explanation: q.explanation, correct_answer: q.correct });
    } else if (kind === 'fitb') {
      const q = question as FitbQuestion;
      res.json({
        correct,
        explanation: q.explanation,
        correct_answer: q.answer,
        normalized_response: normalized,
      });
    } else {
      const q = question as FrQuestion;
      res.json({
        correct,
        score_pct: scoredScore,
        grade: frGrade,
        model_answer: q.model_answer,
      });
    }
  } catch (e) {
    console.error('POST /api/quiz/answer failed:', e);
    res.status(500).json({ error: (e as Error).message });
  }
});

// ─── Quiz: synthesize patterns across the whole quiz ───────────────────────

lti.app.post('/api/quiz/synthesize', async (req: Request, res: Response) => {
  try {
    const token = tokenOf(res);
    const student = await studentFromToken(token);
    const sessionId = parseInt(String(req.body?.session_id ?? ''), 10);
    if (!Number.isInteger(sessionId)) return res.status(400).json({ error: 'session_id required' });

    const sessions = await query<{
      id: number; student_id: number; kind: string; unit_no: number;
      summary: { difficulty: Difficulty; questions: unknown[] };
    }>(
      `select id, student_id, kind, unit_no, summary from session where id=$1`,
      [sessionId]
    );
    if (!sessions.length || sessions[0]!.student_id !== student.id) {
      return res.status(404).json({ error: 'session not found' });
    }
    const session = sessions[0]!;
    const kind = session.kind.replace(/^quiz_/, '') as QuizKind;

    const rows = await query<{
      question: unknown;
      response: string;
      scored_correct: boolean;
      scored_score: number | null;
      feedback: string | null;
    }>(
      `select question, response, scored_correct, scored_score, feedback
       from quiz_attempt
       where session_id=$1
       order by ts asc, id asc`,
      [sessionId]
    );
    if (rows.length === 0) {
      return res.status(400).json({ error: 'no attempts yet for this session' });
    }

    const attempts: AttemptForCoaching[] = rows.map((r) => {
      const a: AttemptForCoaching = {
        kind,
        question: r.question as never,
        response: typeof r.response === 'string' && (kind === 'mc' || kind === 'tf')
          ? (kind === 'mc' ? parseInt(r.response, 10) : (r.response === 'true'))
          : r.response,
        correct: r.scored_correct,
      };
      if (kind === 'fr' && r.feedback) {
        try { a.grade = JSON.parse(r.feedback); } catch {}
        a.score_pct = r.scored_score ?? undefined;
      }
      return a;
    });

    const summary = await synthesizeQuiz(
      session.unit_no, kind, session.summary.difficulty, attempts
    );
    res.json({ summary });
  } catch (e) {
    console.error('POST /api/quiz/synthesize failed:', e);
    res.status(500).json({ error: (e as Error).message });
  }
});

// ─── Quiz: explain one question in depth ────────────────────────────────────

lti.app.post('/api/quiz/explain', async (req: Request, res: Response) => {
  try {
    const token = tokenOf(res);
    const student = await studentFromToken(token);
    const sessionId = parseInt(String(req.body?.session_id ?? ''), 10);
    const questionIndex = parseInt(String(req.body?.question_index ?? ''), 10);
    if (!Number.isInteger(sessionId) || !Number.isInteger(questionIndex)) {
      return res.status(400).json({ error: 'session_id and question_index required' });
    }

    const sessions = await query<{
      id: number; student_id: number; kind: string; unit_no: number;
    }>(
      `select id, student_id, kind, unit_no from session where id=$1`,
      [sessionId]
    );
    if (!sessions.length || sessions[0]!.student_id !== student.id) {
      return res.status(404).json({ error: 'session not found' });
    }
    const session = sessions[0]!;
    const kind = session.kind.replace(/^quiz_/, '') as QuizKind;

    // Pull the attempt at this question_index — attempts are inserted in order.
    const rows = await query<{
      question: unknown;
      response: string;
      scored_correct: boolean;
      scored_score: number | null;
      feedback: string | null;
    }>(
      `select question, response, scored_correct, scored_score, feedback
       from quiz_attempt
       where session_id=$1
       order by ts asc, id asc
       offset $2 limit 1`,
      [sessionId, questionIndex]
    );
    if (!rows.length) return res.status(404).json({ error: 'attempt not found' });
    const r = rows[0]!;

    const attempt: AttemptForCoaching = {
      kind,
      question: r.question as never,
      response: typeof r.response === 'string' && (kind === 'mc' || kind === 'tf')
        ? (kind === 'mc' ? parseInt(r.response, 10) : (r.response === 'true'))
        : r.response,
      correct: r.scored_correct,
    };
    if (kind === 'fr' && r.feedback) {
      try { attempt.grade = JSON.parse(r.feedback); } catch {}
      attempt.score_pct = r.scored_score ?? undefined;
    }

    const explanation = await explainAttempt(session.unit_no, attempt);
    res.json({ explanation });
  } catch (e) {
    console.error('POST /api/quiz/explain failed:', e);
    res.status(500).json({ error: (e as Error).message });
  }
});

// ─── Tutor: streaming turn ──────────────────────────────────────────────────

lti.app.post('/api/tutor/turn', async (req: Request, res: Response) => {
  // Establish SSE headers BEFORE awaiting anything — fail fast if the client
  // has disconnected. Also flush headers so the browser shows progress UI.
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const send = (event: string, data: unknown): void => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const token = tokenOf(res);
    const student = await studentFromToken(token);
    const sessionId = parseInt(String(req.body?.session_id ?? ''), 10);
    const message = String(req.body?.message ?? '').trim();
    if (!Number.isInteger(sessionId)) {
      send('error', { message: 'session_id is required' });
      return res.end();
    }
    if (!message) {
      send('error', { message: 'message is required' });
      return res.end();
    }

    // Look up the session directly to verify ownership + pull unit_no.
    const rows = await query<{
      id: number;
      student_id: number;
      unit_no: number;
      ended_at: string | null;
    }>(
      `select id, student_id, unit_no, ended_at from session where id=$1 and kind='tutor'`,
      [sessionId]
    );
    if (!rows.length || rows[0]!.student_id !== student.id) {
      send('error', { message: 'session not found' });
      return res.end();
    }
    const sessionRow = rows[0]!;

    const displayName = student.display_name;

    await streamSocraticReply({
      session: {
        id: sessionRow.id,
        student_id: sessionRow.student_id,
        unit_no: sessionRow.unit_no,
        kind: 'tutor',
        started_at: '',
        ended_at: sessionRow.ended_at,
      },
      userMessage: message,
      displayName,
      onChunk: (text) => send('chunk', { text }),
    });

    send('done', {});
    res.end();
  } catch (e) {
    console.error('POST /api/tutor/turn failed:', e);
    send('error', { message: (e as Error).message });
    res.end();
  }
});
