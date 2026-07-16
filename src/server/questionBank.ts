/**
 * Reads the pre-generated question bank produced by scripts/build_question_bank.ts.
 *
 * Files live at `content/question-bank/unit-NN.json` (committed, like the unit
 * content). Each file holds every stored question for one unit, grouped by
 * display level (basic / advanced) and type (mc / tf / fitb / fr). Every stored
 * question carries a STABLE id (e.g. "u17-basic-mc-01") so a student's attempts
 * and completion state can reference a specific bank question over time.
 *
 * This replaces on-the-fly generation for students: the server serves fixed
 * questions from here instead of calling the model per request. Live generation
 * (quiz.ts) is retained only for the instructor's own ad-hoc use.
 *
 * Cached in memory because the files are stable — rebuild the bank to refresh.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { McQuestion, TfQuestion, FitbQuestion, FrQuestion } from './quiz.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BANK_DIR = join(ROOT, 'content', 'question-bank');

/** Student-facing difficulty labels. Map to internal difficulties at build time. */
export type BankLevel = 'basic' | 'advanced';
export type BankType = 'mc' | 'tf' | 'fitb' | 'fr';

export const BANK_LEVELS: BankLevel[] = ['basic', 'advanced'];
export const BANK_TYPES: BankType[] = ['mc', 'tf', 'fitb', 'fr'];

/** A stored question: the question body plus a stable id and provenance. */
export interface BankItem<Q> {
  /** Stable, unique within the bank — referenced by attempts/completion. */
  id: string;
  question: Q;
  /** Model that generated it, for auditing (e.g. "claude-opus-4-8"). */
  gen_model: string;
  /** Result of the automated accuracy pass (Phase 1.5). */
  verified: 'pass' | 'flagged' | 'unchecked';
  /** Reviewer/verifier note when flagged. */
  verify_note?: string;
}

export interface LevelBank {
  mc: BankItem<McQuestion>[];
  tf: BankItem<TfQuestion>[];
  fitb: BankItem<FitbQuestion>[];
  fr: BankItem<FrQuestion>[];
}

export interface UnitBank {
  unit_no: number;
  generated_at: string | null;
  levels: Record<BankLevel, LevelBank>;
}

const cache = new Map<number, UnitBank | null>();

function bankPath(unitNo: number): string {
  return join(BANK_DIR, `unit-${String(unitNo).padStart(2, '0')}.json`);
}

/** Returns the unit's bank, or null if it hasn't been generated yet. */
export function getUnitBank(unitNo: number): UnitBank | null {
  if (cache.has(unitNo)) return cache.get(unitNo)!;
  const file = bankPath(unitNo);
  const data = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as UnitBank) : null;
  cache.set(unitNo, data);
  return data;
}

/** All questions for one (unit, level, type) — the list a student picks from. */
export function getBankList(
  unitNo: number,
  level: BankLevel,
  type: BankType
): BankItem<McQuestion | TfQuestion | FitbQuestion | FrQuestion>[] {
  const bank = getUnitBank(unitNo);
  return bank ? bank.levels[level][type] : [];
}

/** Look up one stored question by its stable id (for answering / grading). */
export function getBankItem(
  unitNo: number,
  level: BankLevel,
  type: BankType,
  id: string
): BankItem<McQuestion | TfQuestion | FitbQuestion | FrQuestion> | undefined {
  return getBankList(unitNo, level, type).find((it) => it.id === id);
}

/**
 * The student-facing view of a stored question: everything needed to DISPLAY
 * and answer it, with the answer/explanation stripped so it never travels to
 * the browser before the student submits. The full item (with answer) stays
 * server-side and is used for grading in the bank/answer route.
 */
export function publicQuestion(
  type: BankType,
  q: McQuestion | TfQuestion | FitbQuestion | FrQuestion
): Record<string, unknown> {
  switch (type) {
    case 'mc': {
      const m = q as McQuestion;
      return { stem: m.stem, options: m.options };
    }
    case 'tf': {
      const t = q as TfQuestion;
      return { stem: t.stem };
    }
    case 'fitb': {
      const f = q as FitbQuestion;
      return { stem: f.stem };
    }
    case 'fr': {
      const fr = q as FrQuestion;
      return { prompt: fr.prompt, total_marks: fr.total_marks };
    }
  }
}

/** Which units currently have a generated bank on disk. */
export function listBankUnits(): number[] {
  if (!existsSync(BANK_DIR)) return [];
  return readdirSync(BANK_DIR)
    .map((f) => /^unit-(\d{2})\.json$/.exec(f))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => parseInt(m[1]!, 10))
    .sort((a, b) => a - b);
}
