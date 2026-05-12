/**
 * Practice exam orchestration.
 *
 * A practice exam is a mixed quiz that spans multiple units and includes all
 * four question types. It uses the existing per-kind generators and graders;
 * this module is just the orchestration layer:
 *   - distribute requested counts across selected units (random allocation)
 *   - call the per-kind generators per unit (in parallel where safe)
 *   - shuffle items into a single ordered exam
 *   - grade individual items via the per-kind graders
 *   - aggregate per-unit / per-kind / overall scores at the end
 *
 * Storage:
 *   - session (kind='practice_exam', unit_no=null, summary={ items, difficulty })
 *   - quiz_attempt (one per item, carrying the unit_no and kind of THAT item)
 *   - progress_summary (updated per item using its unit_no + kind)
 */

import {
  generateMC, generateTF, generateFITB, generateFR,
  gradeMC, gradeTF, gradeFITB, gradeFR,
  type Difficulty, type QuizKind,
  type McQuestion, type TfQuestion, type FitbQuestion, type FrQuestion,
} from './quiz.js';
import { getUnit, listUnits } from './content.js';

export interface ExamItem {
  unit_no: number;
  kind: QuizKind;
  question: McQuestion | TfQuestion | FitbQuestion | FrQuestion;
}

export interface ExamCounts {
  mc: number;
  tf: number;
  fitb: number;
  fr: number;
}

/**
 * Randomly allocate `total` of one kind across the given units. Returns the
 * count per unit. Some units may get 0; some may get multiple. Uses sampling
 * with replacement so the distribution is uniform random.
 */
function allocate(total: number, unitNos: number[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const u of unitNos) counts.set(u, 0);
  if (total <= 0 || unitNos.length === 0) return counts;
  for (let i = 0; i < total; i++) {
    const pick = unitNos[Math.floor(Math.random() * unitNos.length)]!;
    counts.set(pick, (counts.get(pick) ?? 0) + 1);
  }
  return counts;
}

function shuffle<T>(arr: T[]): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * Generate a practice exam. Calls each generator at most once per (unit, kind)
 * pair. Generations run in parallel; failures of individual generators are
 * surfaced as a rejected promise (the whole exam fails — partial exams are
 * confusing for the student).
 */
export async function generateExam(params: {
  unitNos: number[];
  counts: ExamCounts;
  difficulty: Difficulty;
}): Promise<ExamItem[]> {
  const { unitNos, counts, difficulty } = params;
  const valid = unitNos.length > 0 ? unitNos : listUnits().map((u) => u.unit_no);

  // Per-kind allocation across units
  const alloc = {
    mc: allocate(counts.mc, valid),
    tf: allocate(counts.tf, valid),
    fitb: allocate(counts.fitb, valid),
    fr: allocate(counts.fr, valid),
  };

  // Build a flat job list of (unit, kind, count)
  type Job = { unit: number; kind: QuizKind; count: number };
  const jobs: Job[] = [];
  for (const kind of ['mc', 'tf', 'fitb', 'fr'] as QuizKind[]) {
    for (const [unit, n] of alloc[kind]) {
      if (n > 0) jobs.push({ unit, kind, count: n });
    }
  }

  // Run jobs in parallel.
  const results = await Promise.all(
    jobs.map(async (j) => {
      let qs: ExamItem['question'][];
      if (j.kind === 'mc') qs = await generateMC(j.unit, j.count, difficulty);
      else if (j.kind === 'tf') qs = await generateTF(j.unit, j.count, difficulty);
      else if (j.kind === 'fitb') qs = await generateFITB(j.unit, j.count, difficulty);
      else qs = await generateFR(j.unit, j.count, difficulty);
      return qs.map<ExamItem>((q) => ({ unit_no: j.unit, kind: j.kind, question: q }));
    })
  );

  return shuffle(results.flat());
}

// ─── Grading dispatch ───────────────────────────────────────────────────────

export async function gradeExamItem(item: ExamItem, response: unknown): Promise<{
  correct: boolean;
  score_pct?: number;
  feedback: unknown; // shape varies by kind, see /api/exam/answer route
  explanation?: string;
  correct_answer?: unknown;
  normalized_response?: string | null;
  model_answer?: string;
}> {
  if (item.kind === 'mc') {
    const q = item.question as McQuestion;
    return {
      correct: gradeMC(q, parseInt(String(response), 10)),
      feedback: q.explanation,
      explanation: q.explanation,
      correct_answer: q.correct_index,
    };
  }
  if (item.kind === 'tf') {
    const q = item.question as TfQuestion;
    return {
      correct: gradeTF(q, response === true || response === 'true'),
      feedback: q.explanation,
      explanation: q.explanation,
      correct_answer: q.correct,
    };
  }
  if (item.kind === 'fitb') {
    const q = item.question as FitbQuestion;
    const r = gradeFITB(q, String(response ?? ''));
    return {
      correct: r.correct,
      feedback: q.explanation,
      explanation: q.explanation,
      correct_answer: q.answer,
      normalized_response: r.normalized_response,
    };
  }
  // FR
  const q = item.question as FrQuestion;
  const unit = getUnit(item.unit_no);
  const grade = await gradeFR(unit, q, String(response ?? ''));
  const pct = Math.round((grade.total_awarded / grade.total_possible) * 100);
  return {
    correct: pct >= 80,
    score_pct: pct,
    feedback: grade,
    model_answer: q.model_answer,
  };
}
