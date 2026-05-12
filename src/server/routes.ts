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
  gradeMC,
  gradeTF,
  gradeFITB,
  type Difficulty,
  type QuizKind,
  type McQuestion,
  type TfQuestion,
  type FitbQuestion,
} from './quiz.js';
import { getStudentProgress } from './progress.js';

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

const VALID_KINDS: QuizKind[] = ['mc', 'tf', 'fitb'];
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

    let questions: McQuestion[] | TfQuestion[] | FitbQuestion[];
    if (kind === 'mc') questions = await generateMC(unitNo, count, difficulty);
    else if (kind === 'tf') questions = await generateTF(unitNo, count, difficulty);
    else questions = await generateFITB(unitNo, count, difficulty);

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
    let q: McQuestion | TfQuestion | FitbQuestion;

    if (kind === 'mc') {
      q = question as McQuestion;
      correct = gradeMC(q, parseInt(String(response), 10));
    } else if (kind === 'tf') {
      q = question as TfQuestion;
      correct = gradeTF(q, response === true || response === 'true');
    } else {
      q = question as FitbQuestion;
      const r = gradeFITB(q, String(response ?? ''));
      correct = r.correct;
      normalized = r.normalized_response;
    }

    await query(
      `insert into quiz_attempt (session_id, unit_no, kind, question, response, scored_correct, feedback)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        sessionId,
        session.unit_no,
        kind,
        JSON.stringify(question),
        String(response ?? ''),
        correct,
        (q as { explanation: string }).explanation,
      ]
    );

    // Update progress_summary upsert
    await query(
      `insert into progress_summary (student_id, unit_no, kind, attempts, correct, last_at)
       values ($1, $2, $3, 1, $4, now())
       on conflict (student_id, unit_no, kind)
       do update set attempts = progress_summary.attempts + 1,
                     correct  = progress_summary.correct + excluded.correct,
                     last_at  = now()`,
      [student.id, session.unit_no, kind, correct ? 1 : 0]
    );

    res.json({
      correct,
      explanation: (q as { explanation: string }).explanation,
      ...(kind === 'mc' ? { correct_index: (q as McQuestion).correct_index } : {}),
      ...(kind === 'tf' ? { correct_answer: (q as TfQuestion).correct } : {}),
      ...(kind === 'fitb'
        ? { correct_answer: (q as FitbQuestion).answer, normalized_response: normalized }
        : {}),
    });
  } catch (e) {
    console.error('POST /api/quiz/answer failed:', e);
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
