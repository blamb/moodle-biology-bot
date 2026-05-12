/**
 * Per-student progress aggregation.
 *
 * Reads from progress_summary (which the quiz endpoints keep up-to-date) plus
 * the session table for tutor activity. No writes — this is a pure query layer.
 *
 * Output is designed to feed the picker (per-unit badges) and the Progress
 * view (unit × kind matrix + weak-spots highlighting).
 */

import { query } from './db.js';
import { listUnits, type UnitSummary } from './content.js';

export type QuizKind = 'mc' | 'tf' | 'fitb';
export const QUIZ_KINDS: QuizKind[] = ['mc', 'tf', 'fitb'];

export interface KindStats {
  attempts: number;
  correct: number;
  pct: number | null;
  last_at: string | null;
}

export interface TutorStats {
  sessions: number;
  turns: number;
  last_at: string | null;
}

export interface UnitProgress {
  unit_no: number;
  title: string;
  by_kind: Record<QuizKind, KindStats>;
  tutor: TutorStats;
  any_activity: boolean;
}

export interface ProgressBundle {
  units: UnitProgress[];
  totals: { attempts: number; correct: number; pct: number | null };
  last_activity: {
    unit_no: number;
    title: string;
    kind: QuizKind | 'tutor';
    at: string;
  } | null;
  weak_spots: Array<{
    unit_no: number;
    title: string;
    kind: QuizKind;
    pct: number;
    attempts: number;
  }>;
}

const WEAK_PCT_THRESHOLD = 70;
const WEAK_MIN_ATTEMPTS = 4;

function emptyKindStats(): KindStats {
  return { attempts: 0, correct: 0, pct: null, last_at: null };
}

export async function getStudentProgress(studentId: number): Promise<ProgressBundle> {
  // Quiz progress per (unit, kind)
  const quizRows = await query<{
    unit_no: number;
    kind: QuizKind;
    attempts: number;
    correct: number;
    last_at: string | null;
  }>(
    `select unit_no, kind, attempts, correct, last_at
     from progress_summary
     where student_id = $1`,
    [studentId]
  );

  // Tutor activity per unit: count distinct sessions, total turns, latest turn
  const tutorRows = await query<{
    unit_no: number;
    sessions: number;
    turns: number;
    last_at: string | null;
  }>(
    `select s.unit_no,
            count(distinct s.id) ::int as sessions,
            count(t.id)          ::int as turns,
            max(t.ts)                  as last_at
     from session s
     left join tutor_turn t on t.session_id = s.id
     where s.student_id = $1 and s.kind = 'tutor'
     group by s.unit_no`,
    [studentId]
  );

  const allUnits: UnitSummary[] = listUnits();
  const unitMap = new Map<number, UnitProgress>();
  for (const u of allUnits) {
    unitMap.set(u.unit_no, {
      unit_no: u.unit_no,
      title: u.title,
      by_kind: {
        mc: emptyKindStats(),
        tf: emptyKindStats(),
        fitb: emptyKindStats(),
      },
      tutor: { sessions: 0, turns: 0, last_at: null },
      any_activity: false,
    });
  }

  for (const row of quizRows) {
    const up = unitMap.get(row.unit_no);
    if (!up) continue;
    const stats: KindStats = {
      attempts: row.attempts,
      correct: row.correct,
      pct: row.attempts > 0 ? Math.round((row.correct / row.attempts) * 100) : null,
      last_at: row.last_at,
    };
    up.by_kind[row.kind] = stats;
    if (row.attempts > 0) up.any_activity = true;
  }

  for (const row of tutorRows) {
    const up = unitMap.get(row.unit_no);
    if (!up) continue;
    up.tutor = {
      sessions: row.sessions,
      turns: row.turns,
      last_at: row.last_at,
    };
    if (row.turns > 0) up.any_activity = true;
  }

  const units = Array.from(unitMap.values()).sort((a, b) => a.unit_no - b.unit_no);

  // Totals across all quiz kinds
  let totalAttempts = 0;
  let totalCorrect = 0;
  for (const u of units) {
    for (const k of QUIZ_KINDS) {
      totalAttempts += u.by_kind[k].attempts;
      totalCorrect += u.by_kind[k].correct;
    }
  }
  const totals = {
    attempts: totalAttempts,
    correct: totalCorrect,
    pct: totalAttempts > 0 ? Math.round((totalCorrect / totalAttempts) * 100) : null,
  };

  // Most recent activity (quiz or tutor)
  type LastCandidate = { unit_no: number; title: string; kind: QuizKind | 'tutor'; at: string };
  const candidates: LastCandidate[] = [];
  for (const u of units) {
    for (const k of QUIZ_KINDS) {
      const at = u.by_kind[k].last_at;
      if (at) candidates.push({ unit_no: u.unit_no, title: u.title, kind: k, at });
    }
    if (u.tutor.last_at) {
      candidates.push({ unit_no: u.unit_no, title: u.title, kind: 'tutor', at: u.tutor.last_at });
    }
  }
  candidates.sort((a, b) => (a.at < b.at ? 1 : -1));
  const last_activity = candidates[0] ?? null;

  // Weak spots: kind × unit with enough attempts AND below threshold
  const weak_spots: ProgressBundle['weak_spots'] = [];
  for (const u of units) {
    for (const k of QUIZ_KINDS) {
      const s = u.by_kind[k];
      if (s.attempts >= WEAK_MIN_ATTEMPTS && s.pct !== null && s.pct < WEAK_PCT_THRESHOLD) {
        weak_spots.push({
          unit_no: u.unit_no,
          title: u.title,
          kind: k,
          pct: s.pct,
          attempts: s.attempts,
        });
      }
    }
  }
  weak_spots.sort((a, b) => a.pct - b.pct);

  return { units, totals, last_activity, weak_spots };
}
