/**
 * Crowd-sourced question quality: students rate bank questions 👍/👎 after
 * answering, the instructor scans the aggregate to find questions worth
 * reviewing.
 *
 * The scoring here is deliberately simple enough to explain in one sentence:
 * each 👎 is weighted by the reason the student gave, and doubled if that
 * student had actually answered the question correctly. "Just found it hard"
 * is weighted near zero — that's the bucket that would otherwise send the
 * instructor on wild goose chases.
 */

import { query } from './db.js';
import { getBankItem, BANK_LEVELS, BANK_TYPES, type BankLevel, type BankType } from './questionBank.js';
import { listUnits } from './content.js';

export const FEEDBACK_REASONS = [
  'wrong_answer',
  'confusing',
  'off_syllabus',
  'too_hard',
] as const;
export type FeedbackReason = (typeof FEEDBACK_REASONS)[number];

/** Student-facing labels — kept here so the report can echo the exact wording. */
export const REASON_LABELS: Record<FeedbackReason, string> = {
  wrong_answer: 'Answer looks wrong',
  confusing: 'Confusing wording',
  off_syllabus: "Not covered in our course",
  too_hard: 'Just found it hard',
};

/**
 * How much a single 👎 contributes to a question's concern score.
 * `unspecified` covers a 👎 where the student closed the panel without picking
 * a reason. `too_hard` is deliberately near-zero: it's a statement about the
 * student's preparation, not about the question.
 */
const REASON_WEIGHT: Record<FeedbackReason | 'unspecified', number> = {
  wrong_answer: 4,
  confusing: 2,
  off_syllabus: 1.5,
  unspecified: 1,
  too_hard: 0.25,
};

/** A 👎 from a student who answered the question CORRECTLY counts double. */
const CORRECT_ANSWERER_MULTIPLIER = 2;

/** At or above this score a question lands in the instructor's "needs review" list. */
const FLAG_THRESHOLD = 4;

/** Notes longer than this are truncated on the way in. */
export const MAX_NOTE_LEN = 400;

export interface RecordFeedbackParams {
  studentId: number;
  bankQuestionId: string;
  unitNo: number;
  level: BankLevel;
  kind: BankType;
  /** 1 = 👍, -1 = 👎, 0 = withdraw a previous rating. */
  rating: 1 | -1 | 0;
  reason?: FeedbackReason | null;
  note?: string | null;
}

export interface StoredFeedback {
  rating: 1 | -1;
  reason: FeedbackReason | null;
  note: string | null;
}

/**
 * Upsert one student's rating of one question. Returns the stored row, or null
 * if the rating was withdrawn.
 *
 * `was_correct` is resolved server-side from the student's latest attempt on
 * this bank id — never taken from the client.
 */
export async function recordFeedback(p: RecordFeedbackParams): Promise<StoredFeedback | null> {
  if (p.rating === 0) {
    await query(`delete from question_feedback where student_id=$1 and bank_question_id=$2`, [
      p.studentId,
      p.bankQuestionId,
    ]);
    return null;
  }

  // A reason and a note only mean anything attached to a 👎.
  const reason = p.rating === -1 ? (p.reason ?? null) : null;
  const rawNote = p.rating === -1 ? (p.note ?? null) : null;
  const note = rawNote ? rawNote.trim().slice(0, MAX_NOTE_LEN) || null : null;

  const latest = await query<{ scored_correct: boolean | null }>(
    `select qa.scored_correct
       from quiz_attempt qa
       join session s on s.id = qa.session_id
      where s.student_id = $1 and qa.bank_question_id = $2
      order by qa.ts desc, qa.id desc
      limit 1`,
    [p.studentId, p.bankQuestionId]
  );
  const wasCorrect = latest.length ? latest[0]!.scored_correct : null;

  const rows = await query<{ rating: number; reason: FeedbackReason | null; note: string | null }>(
    `insert into question_feedback
       (student_id, bank_question_id, unit_no, level, kind, rating, reason, note, was_correct)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     on conflict (student_id, bank_question_id)
     do update set rating      = excluded.rating,
                   reason      = excluded.reason,
                   note        = excluded.note,
                   was_correct = excluded.was_correct,
                   updated_at  = now()
     returning rating, reason, note`,
    [
      p.studentId,
      p.bankQuestionId,
      p.unitNo,
      p.level,
      p.kind,
      p.rating,
      reason,
      note,
      wasCorrect,
    ]
  );
  const r = rows[0]!;
  return { rating: r.rating as 1 | -1, reason: r.reason, note: r.note };
}

/** This student's existing ratings across a set of bank ids (for the tile grid). */
export async function getStudentFeedback(
  studentId: number,
  bankQuestionIds: string[]
): Promise<Map<string, StoredFeedback>> {
  if (bankQuestionIds.length === 0) return new Map();
  const rows = await query<{
    bank_question_id: string;
    rating: number;
    reason: FeedbackReason | null;
    note: string | null;
  }>(
    `select bank_question_id, rating, reason, note
       from question_feedback
      where student_id = $1 and bank_question_id = any($2::text[])`,
    [studentId, bankQuestionIds]
  );
  return new Map(
    rows.map((r) => [
      r.bank_question_id,
      { rating: r.rating as 1 | -1, reason: r.reason, note: r.note },
    ])
  );
}

// ─── Instructor report ──────────────────────────────────────────────────────

export interface QuestionFeedbackRow {
  bank_question_id: string;
  unit_no: number;
  unit_title: string;
  level: BankLevel;
  kind: BankType;
  up: number;
  down: number;
  /** 👎 from students who had answered this question correctly. */
  down_from_correct: number;
  reasons: Record<FeedbackReason | 'unspecified', number>;
  /** Anonymous — student identity is deliberately not carried into the report. */
  notes: string[];
  /** Class performance on this question, for context. */
  attempts: number;
  correct: number;
  accuracy_pct: number | null;
  concern: number;
  flagged: boolean;
  /** Why it's flagged, in the instructor's words. Empty when not flagged. */
  flag_reason: string;
  /** Full question INCLUDING the answer key — this view is instructor-gated. */
  question: unknown | null;
}

export interface QuestionFeedbackReport {
  totals: {
    rated_questions: number;
    flagged_questions: number;
    ratings: number;
    up: number;
    down: number;
    students_rating: number;
  };
  /** Every rated question, worst-first. */
  questions: QuestionFeedbackRow[];
}

interface RawRow {
  bank_question_id: string;
  unit_no: number;
  level: string;
  kind: string;
  rating: number;
  reason: FeedbackReason | null;
  note: string | null;
  was_correct: boolean | null;
  student_id: number;
}

function emptyReasons(): Record<FeedbackReason | 'unspecified', number> {
  return { wrong_answer: 0, confusing: 0, off_syllabus: 0, too_hard: 0, unspecified: 0 };
}

/**
 * Aggregate every rating left by students in one course.
 *
 * Only bank questions appear here — practice-exam questions are generated live
 * and have no stable id to accumulate against.
 */
export async function getCourseQuestionFeedback(params: {
  iss: string;
  contextId: string;
}): Promise<QuestionFeedbackReport> {
  const raw = await query<RawRow>(
    `select f.bank_question_id, f.unit_no, f.level, f.kind, f.rating,
            f.reason, f.note, f.was_correct, f.student_id
       from question_feedback f
       join student st on st.id = f.student_id
      where st.lti_iss = $1 and st.lti_context_id = $2`,
    [params.iss, params.contextId]
  );

  if (raw.length === 0) {
    return {
      totals: { rated_questions: 0, flagged_questions: 0, ratings: 0, up: 0, down: 0, students_rating: 0 },
      questions: [],
    };
  }

  // Class attempt counts for the same questions, scoped to the same course.
  const ids = [...new Set(raw.map((r) => r.bank_question_id))];
  const attemptRows = await query<{ bank_question_id: string; attempts: number; correct: number }>(
    `select qa.bank_question_id,
            count(*)::int                                        as attempts,
            count(*) filter (where qa.scored_correct)::int       as correct
       from quiz_attempt qa
       join session s  on s.id = qa.session_id
       join student st on st.id = s.student_id
      where st.lti_iss = $1 and st.lti_context_id = $2
        and qa.bank_question_id = any($3::text[])
      group by qa.bank_question_id`,
    [params.iss, params.contextId, ids]
  );
  const attemptsById = new Map(attemptRows.map((r) => [r.bank_question_id, r]));

  const unitTitles = new Map(listUnits().map((u) => [u.unit_no, u.title]));

  const byQuestion = new Map<string, QuestionFeedbackRow>();
  for (const r of raw) {
    const level = (BANK_LEVELS as string[]).includes(r.level) ? (r.level as BankLevel) : 'basic';
    const kind = (BANK_TYPES as string[]).includes(r.kind) ? (r.kind as BankType) : 'mc';

    let row = byQuestion.get(r.bank_question_id);
    if (!row) {
      const item = getBankItem(r.unit_no, level, kind, r.bank_question_id);
      const a = attemptsById.get(r.bank_question_id);
      row = {
        bank_question_id: r.bank_question_id,
        unit_no: r.unit_no,
        unit_title: unitTitles.get(r.unit_no) ?? `Unit ${r.unit_no}`,
        level,
        kind,
        up: 0,
        down: 0,
        down_from_correct: 0,
        reasons: emptyReasons(),
        notes: [],
        attempts: a?.attempts ?? 0,
        correct: a?.correct ?? 0,
        accuracy_pct: a && a.attempts > 0 ? Math.round((a.correct / a.attempts) * 100) : null,
        concern: 0,
        flagged: false,
        flag_reason: '',
        // Null when the bank has been rebuilt and this id no longer exists —
        // the ratings still show, just without the question body.
        question: item ? item.question : null,
      };
      byQuestion.set(r.bank_question_id, row);
    }

    if (r.rating === 1) {
      row.up++;
      continue;
    }
    row.down++;
    const reason: FeedbackReason | 'unspecified' = r.reason ?? 'unspecified';
    row.reasons[reason]++;
    if (r.was_correct === true) row.down_from_correct++;
    if (r.note) row.notes.push(r.note);
    row.concern +=
      REASON_WEIGHT[reason] * (r.was_correct === true ? CORRECT_ANSWERER_MULTIPLIER : 1);
  }

  const questions = [...byQuestion.values()];
  for (const q of questions) {
    q.concern = Math.round(q.concern * 100) / 100;
    q.flagged = q.concern >= FLAG_THRESHOLD;
    if (q.flagged) q.flag_reason = describeFlag(q);
  }

  // Worst first; ties broken by raw 👎 count so the bigger sample leads.
  questions.sort((a, b) => b.concern - a.concern || b.down - a.down);

  const students = new Set(raw.map((r) => r.student_id));
  return {
    totals: {
      rated_questions: questions.length,
      flagged_questions: questions.filter((q) => q.flagged).length,
      ratings: raw.length,
      up: raw.filter((r) => r.rating === 1).length,
      down: raw.filter((r) => r.rating === -1).length,
      students_rating: students.size,
    },
    questions,
  };
}

/** One line telling the instructor why this question surfaced. */
function describeFlag(q: QuestionFeedbackRow): string {
  const n = (c: number, word: string) => `${c} student${c === 1 ? '' : 's'} ${word}`;
  if (q.reasons.wrong_answer > 0) {
    return `${n(q.reasons.wrong_answer, 'reported the answer looks wrong')}.`;
  }
  if (q.down_from_correct >= 2) {
    return `${n(q.down_from_correct, 'who answered it correctly still flagged it')}.`;
  }
  if (q.reasons.confusing > 0) {
    return `${n(q.reasons.confusing, 'called the wording confusing')}.`;
  }
  if (q.reasons.off_syllabus > 0) {
    return `${n(q.reasons.off_syllabus, "said it isn't covered in the course")}.`;
  }
  return `${n(q.down, 'gave it a thumbs-down')}.`;
}
