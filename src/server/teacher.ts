/**
 * Teacher / instructor data aggregation. Scoped to one LTI course context — a
 * teacher in course X only sees data for students enrolled in course X.
 *
 * The student-side progress.ts already aggregates one student's data; this
 * module aggregates across a roster.
 */

import { query } from './db.js';
import { listUnits, type UnitSummary } from './content.js';
import {
  QUIZ_KINDS,
  type KindStats,
  type QuizKind,
} from './progress.js';

export interface RosterStudent {
  id: number;
  display_name: string;
  created_at: string;
  total_attempts: number;
  total_correct: number;
  total_pct: number | null;
  tutor_turns: number;
  last_activity_at: string | null;
  weak_units: number[]; // unit_nos where ≥4 attempts at <70%
}

export interface ClassUnitStats {
  unit_no: number;
  title: string;
  students_engaged: number;
  total_attempts: number;
  total_correct: number;
  pct: number | null;
  by_kind: Record<QuizKind, { attempts: number; correct: number; pct: number | null }>;
}

export interface DashboardBundle {
  context: { iss: string; context_id: string };
  class_totals: {
    students: number;
    quiz_attempts: number;
    quiz_correct: number;
    pct: number | null;
    tutor_turns: number;
    tutor_sessions: number;
  };
  units: ClassUnitStats[];
  weak_units: ClassUnitStats[]; // sorted worst-first
  roster: RosterStudent[];      // sorted by recent activity
}

interface ProgressRow {
  student_id: number;
  unit_no: number;
  kind: QuizKind;
  attempts: number;
  correct: number;
  last_at: string | null;
}

interface StudentRow {
  id: number;
  display_name: string;
  created_at: string;
}

interface TutorRow {
  student_id: number;
  sessions: number;
  turns: number;
  last_at: string | null;
}

const WEAK_PCT_THRESHOLD = 70;
const WEAK_MIN_ATTEMPTS = 4;

export async function getCourseDashboard(params: {
  iss: string;
  contextId: string;
}): Promise<DashboardBundle> {
  const { iss, contextId } = params;

  const students = await query<StudentRow>(
    `select id, display_name, created_at::text
     from student
     where lti_iss = $1 and lti_context_id = $2`,
    [iss, contextId]
  );
  const studentIds = students.map((s) => s.id);
  if (studentIds.length === 0) {
    return emptyBundle(iss, contextId);
  }

  const progress = await query<ProgressRow>(
    `select student_id, unit_no, kind, attempts, correct, last_at::text
     from progress_summary
     where student_id = any($1::bigint[])`,
    [studentIds]
  );

  const tutorActivity = await query<TutorRow>(
    `select s.student_id,
            count(distinct s.id) ::int as sessions,
            count(t.id)          ::int as turns,
            max(t.ts)::text            as last_at
     from session s
     left join tutor_turn t on t.session_id = s.id
     where s.student_id = any($1::bigint[]) and s.kind = 'tutor'
     group by s.student_id`,
    [studentIds]
  );
  const tutorByStudent = new Map(tutorActivity.map((t) => [t.student_id, t]));

  // Per-student aggregation
  const perStudent = new Map<number, {
    attempts: number; correct: number; lastAt: string | null;
    weakByUnit: Map<number, { attempts: number; correct: number }>;
  }>();
  for (const s of students) {
    perStudent.set(s.id, {
      attempts: 0, correct: 0, lastAt: null,
      weakByUnit: new Map(),
    });
  }
  for (const row of progress) {
    const ps = perStudent.get(row.student_id);
    if (!ps) continue;
    ps.attempts += row.attempts;
    ps.correct += row.correct;
    if (row.last_at && (!ps.lastAt || row.last_at > ps.lastAt)) {
      ps.lastAt = row.last_at;
    }
    const wu = ps.weakByUnit.get(row.unit_no) ?? { attempts: 0, correct: 0 };
    wu.attempts += row.attempts;
    wu.correct += row.correct;
    ps.weakByUnit.set(row.unit_no, wu);
  }

  const roster: RosterStudent[] = students.map((s) => {
    const ps = perStudent.get(s.id)!;
    const tutor = tutorByStudent.get(s.id);
    const weak: number[] = [];
    for (const [unitNo, wu] of ps.weakByUnit) {
      if (wu.attempts >= WEAK_MIN_ATTEMPTS) {
        const pct = (wu.correct / wu.attempts) * 100;
        if (pct < WEAK_PCT_THRESHOLD) weak.push(unitNo);
      }
    }
    weak.sort((a, b) => a - b);

    // Combine quiz and tutor last_at for "most recent"
    const candidates: string[] = [];
    if (ps.lastAt) candidates.push(ps.lastAt);
    if (tutor?.last_at) candidates.push(tutor.last_at);
    candidates.sort();
    const lastActivity = candidates.length ? candidates[candidates.length - 1]! : null;

    return {
      id: s.id,
      display_name: s.display_name,
      created_at: s.created_at,
      total_attempts: ps.attempts,
      total_correct: ps.correct,
      total_pct: ps.attempts > 0 ? Math.round((ps.correct / ps.attempts) * 100) : null,
      tutor_turns: tutor?.turns ?? 0,
      last_activity_at: lastActivity,
      weak_units: weak,
    };
  });
  roster.sort((a, b) => {
    if (a.last_activity_at && b.last_activity_at) return a.last_activity_at < b.last_activity_at ? 1 : -1;
    if (a.last_activity_at) return -1;
    if (b.last_activity_at) return 1;
    return a.display_name.localeCompare(b.display_name);
  });

  // Per-unit aggregation across the class
  const unitTitles: UnitSummary[] = listUnits();
  const titleByUnit = new Map(unitTitles.map((u) => [u.unit_no, u.title]));
  type UnitAgg = {
    attempts: number; correct: number;
    by_kind: Record<QuizKind, { attempts: number; correct: number }>;
    students: Set<number>;
  };
  const unitAggs = new Map<number, UnitAgg>();
  for (const row of progress) {
    let agg = unitAggs.get(row.unit_no);
    if (!agg) {
      agg = {
        attempts: 0, correct: 0,
        by_kind: { mc: { attempts: 0, correct: 0 }, tf: { attempts: 0, correct: 0 }, fitb: { attempts: 0, correct: 0 }, fr: { attempts: 0, correct: 0 } },
        students: new Set(),
      };
      unitAggs.set(row.unit_no, agg);
    }
    agg.attempts += row.attempts;
    agg.correct += row.correct;
    agg.by_kind[row.kind].attempts += row.attempts;
    agg.by_kind[row.kind].correct += row.correct;
    if (row.attempts > 0) agg.students.add(row.student_id);
  }

  const units: ClassUnitStats[] = unitTitles.map((u) => {
    const agg = unitAggs.get(u.unit_no);
    if (!agg) {
      return {
        unit_no: u.unit_no,
        title: u.title,
        students_engaged: 0,
        total_attempts: 0,
        total_correct: 0,
        pct: null,
        by_kind: { mc: { attempts: 0, correct: 0, pct: null }, tf: { attempts: 0, correct: 0, pct: null }, fitb: { attempts: 0, correct: 0, pct: null }, fr: { attempts: 0, correct: 0, pct: null } },
      };
    }
    const by_kind = {} as ClassUnitStats['by_kind'];
    for (const k of QUIZ_KINDS) {
      const bk = agg.by_kind[k];
      by_kind[k] = {
        attempts: bk.attempts,
        correct: bk.correct,
        pct: bk.attempts > 0 ? Math.round((bk.correct / bk.attempts) * 100) : null,
      };
    }
    return {
      unit_no: u.unit_no,
      title: u.title,
      students_engaged: agg.students.size,
      total_attempts: agg.attempts,
      total_correct: agg.correct,
      pct: agg.attempts > 0 ? Math.round((agg.correct / agg.attempts) * 100) : null,
      by_kind,
    };
  });

  const weak_units = units
    .filter((u) => u.total_attempts >= WEAK_MIN_ATTEMPTS && u.pct !== null && u.pct < WEAK_PCT_THRESHOLD)
    .sort((a, b) => (a.pct ?? 100) - (b.pct ?? 100));

  // Class totals
  let totalAttempts = 0, totalCorrect = 0;
  for (const u of units) {
    totalAttempts += u.total_attempts;
    totalCorrect += u.total_correct;
  }
  const totalTutorTurns = Array.from(tutorByStudent.values()).reduce((a, t) => a + t.turns, 0);
  const totalTutorSessions = Array.from(tutorByStudent.values()).reduce((a, t) => a + t.sessions, 0);

  return {
    context: { iss, context_id: contextId },
    class_totals: {
      students: students.length,
      quiz_attempts: totalAttempts,
      quiz_correct: totalCorrect,
      pct: totalAttempts > 0 ? Math.round((totalCorrect / totalAttempts) * 100) : null,
      tutor_turns: totalTutorTurns,
      tutor_sessions: totalTutorSessions,
    },
    units,
    weak_units,
    roster,
  };
}

function emptyBundle(iss: string, contextId: string): DashboardBundle {
  const unitTitles = listUnits();
  return {
    context: { iss, context_id: contextId },
    class_totals: { students: 0, quiz_attempts: 0, quiz_correct: 0, pct: null, tutor_turns: 0, tutor_sessions: 0 },
    units: unitTitles.map((u) => ({
      unit_no: u.unit_no,
      title: u.title,
      students_engaged: 0,
      total_attempts: 0,
      total_correct: 0,
      pct: null,
      by_kind: { mc: { attempts: 0, correct: 0, pct: null }, tf: { attempts: 0, correct: 0, pct: null }, fitb: { attempts: 0, correct: 0, pct: null }, fr: { attempts: 0, correct: 0, pct: null } },
    })),
    weak_units: [],
    roster: [],
  };
}

// ─── Concept-gap analysis ───────────────────────────────────────────────────
// Sampled wrong answers from the course → LLM identifies recurring themes.

import { getAnthropic, GEN_MODEL } from './anthropic.js';
import { getUnit } from './content.js';

interface WrongSample {
  unit_no: number;
  kind: QuizKind;
  question: unknown;
  response: string;
  feedback: string | null;
}

const CONCEPT_ANALYSIS_SYSTEM = `You analyze patterns in wrong answers across a class of undergraduate Human Anatomy & Physiology students to identify where the instructor should consider extra review.

Rules:
- Output 3–6 short paragraphs, one per identified gap.
- Each paragraph must:
  1. Name the SPECIFIC concept the class is struggling with (e.g. "tonicity vs osmolarity" not "membrane stuff").
  2. Cite the unit/slide source where it lives — "(Unit N, slide M)" or "(Unit N textbook)".
  3. Quantify approximately how many students it's affecting based on the wrong-answer samples.
  4. Suggest one concrete instructor action (re-explain in lecture / share a worked example / direct students to a specific textbook section).
- Focus on patterns ACROSS multiple students or multiple questions. Skip one-off mistakes.
- Plain English. Direct. No "students are struggling" filler — name the concept.`;

export async function analyzeClassConceptGaps(params: {
  iss: string;
  contextId: string;
  unitNo?: number;
}): Promise<string> {
  const { iss, contextId, unitNo } = params;

  // Pull wrong answers, optionally scoped to a single unit. Cap at 60 to keep
  // the prompt manageable; sample evenly across units if scope is class-wide.
  const where = unitNo !== undefined
    ? `s.lti_iss = $1 and s.lti_context_id = $2 and qa.unit_no = $3 and qa.scored_correct = false`
    : `s.lti_iss = $1 and s.lti_context_id = $2 and qa.scored_correct = false`;
  const queryParams: unknown[] = unitNo !== undefined ? [iss, contextId, unitNo] : [iss, contextId];

  const rows = await query<WrongSample & { display_name: string }>(
    `select qa.unit_no, qa.kind, qa.question, qa.response, qa.feedback, s.display_name
     from quiz_attempt qa
     join session sess on sess.id = qa.session_id
     join student s on s.id = sess.student_id
     where ${where}
     order by random()
     limit 60`,
    queryParams
  );

  if (rows.length === 0) {
    return 'No wrong-answer data yet for this course context. Once students start practicing, recurring concept gaps will show up here.';
  }

  // Group by unit so the prompt is organized.
  type Group = { unit_no: number; entries: typeof rows };
  const byUnit = new Map<number, Group>();
  for (const r of rows) {
    let g = byUnit.get(r.unit_no);
    if (!g) {
      g = { unit_no: r.unit_no, entries: [] };
      byUnit.set(r.unit_no, g);
    }
    g.entries.push(r);
  }
  const groups = Array.from(byUnit.values()).sort((a, b) => b.entries.length - a.entries.length);

  // Build a structured prompt body
  const bodyParts: string[] = [];
  for (const g of groups) {
    bodyParts.push(`\n## Unit ${g.unit_no} — ${g.entries.length} wrong answer(s)`);
    for (const e of g.entries.slice(0, 15)) {
      const q = e.question as { stem?: string; prompt?: string; explanation?: string };
      const stem = q.stem ?? q.prompt ?? '';
      const short = stem.length > 140 ? stem.slice(0, 137) + '…' : stem;
      bodyParts.push(`- [${e.kind.toUpperCase()}] ${short}`);
      if (q.explanation) {
        const exp = q.explanation.length > 140 ? q.explanation.slice(0, 137) + '…' : q.explanation;
        bodyParts.push(`    correct concept: ${exp}`);
      }
    }
  }

  // Include unit content for the units in scope, prompt-cached.
  const unitContents = Array.from(byUnit.keys()).slice(0, 6).map((u) => {
    const unit = getUnit(u);
    return `# UNIT ${unit.unit_no}: ${unit.ppt_title}\n\n${unit.ppt_markdown}\n\n` +
      (unit.textbook ? `## Textbook chapter\n${unit.textbook.markdown}` : '');
  }).join('\n\n---\n\n');

  const client = getAnthropic();
  const res = await client.messages.create({
    model: GEN_MODEL,
    max_tokens: 1200,
    system: [
      { type: 'text', text: CONCEPT_ANALYSIS_SYSTEM },
      { type: 'text', text: unitContents, cache_control: { type: 'ephemeral' } },
    ],
    messages: [
      {
        role: 'user',
        content: `Wrong answers from the class (sampled, ${rows.length} total):\n${bodyParts.join('\n')}\n\nIdentify the recurring concept gaps and write the analysis now.`,
      },
    ],
  });
  return res.content
    .filter((b) => b.type === 'text')
    .map((b) => (b as { text: string }).text)
    .join('\n')
    .trim();
}
