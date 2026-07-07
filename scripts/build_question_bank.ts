/**
 * Builds the static question bank for the Biology Bot.
 *
 * For each unit × display level × type, generate N distinct questions once,
 * using the SAME tuned generators the live bot uses (slide anchoring, FR
 * rubric-alignment, etc.) — so bank questions match the quality we've dialed in.
 *
 * Run with the TOP model, since generation is one-time and quality is
 * paramount (no per-student human review):
 *
 *   GEN_MODEL=claude-opus-4-8 npm run bank:build            # full build (17 units)
 *   GEN_MODEL=claude-opus-4-8 npm run bank:build -- --units=17 --mc=3 --tf=2 --fitb=2 --fr=1   # cheap test
 *
 * Output: content/question-bank/unit-NN.json  (committed, served by questionBank.ts)
 *
 * Phase 1 scaffold: generation + storage. The automated accuracy pass
 * (verified: 'pass'|'flagged') is Phase 1.5 — every item is written 'unchecked'
 * for now and the hook is marked below.
 */

import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GEN_MODEL } from '../src/server/anthropic.js';
import {
  generateMC,
  generateTF,
  generateFITB,
  generateFR,
  type Difficulty,
  type McQuestion,
  type TfQuestion,
  type FitbQuestion,
  type FrQuestion,
} from '../src/server/quiz.js';
import type { BankItem, BankLevel, BankType, UnitBank } from '../src/server/questionBank.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BANK_DIR = join(ROOT, 'content', 'question-bank');

// Display level → internal difficulty. The hardest internal tier ('advanced')
// is intentionally dropped — this intro course only needs two levels.
const LEVELS: { level: BankLevel; difficulty: Difficulty }[] = [
  { level: 'basic', difficulty: 'introductory' },
  { level: 'advanced', difficulty: 'intermediate' },
];

const DEFAULT_TARGETS: Record<BankType, number> = { mc: 30, tf: 30, fitb: 30, fr: 10 };
const ALL_UNITS = Array.from({ length: 17 }, (_, i) => i + 1); // units 1..17

type AnyQ = McQuestion | TfQuestion | FitbQuestion | FrQuestion;

function argVal(flag: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${flag}=`));
  return hit ? hit.slice(flag.length + 3) : undefined;
}

function parseArgs() {
  const unitsArg = argVal('units');
  const units = unitsArg ? unitsArg.split(',').map((s) => parseInt(s.trim(), 10)) : ALL_UNITS;
  const targets: Record<BankType, number> = { ...DEFAULT_TARGETS };
  for (const t of ['mc', 'tf', 'fitb', 'fr'] as BankType[]) {
    const v = argVal(t);
    if (v) targets[t] = parseInt(v, 10);
  }
  return { units, targets };
}

const stemOf = (type: BankType, q: AnyQ): string =>
  type === 'fr' ? (q as FrQuestion).prompt : (q as McQuestion | TfQuestion | FitbQuestion).stem;

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

async function genBatch(type: BankType, unitNo: number, n: number, difficulty: Difficulty): Promise<AnyQ[]> {
  if (type === 'mc') return generateMC(unitNo, n, difficulty);
  if (type === 'tf') return generateTF(unitNo, n, difficulty);
  if (type === 'fitb') return generateFITB(unitNo, n, difficulty);
  return generateFR(unitNo, n, difficulty);
}

/**
 * Generate `target` DISTINCT questions by calling the generator in batches
 * (slide anchors vary per call, giving diversity) and deduping by normalized
 * stem. Bounded attempts so a thin unit can't loop forever.
 */
async function genDistinct(
  type: BankType,
  unitNo: number,
  difficulty: Difficulty,
  target: number
): Promise<AnyQ[]> {
  const seen = new Set<string>();
  const out: AnyQ[] = [];
  const maxAttempts = Math.ceil(target / 5) + 4;
  for (let attempt = 0; out.length < target && attempt < maxAttempts; attempt++) {
    const need = target - out.length;
    const n = Math.min(Math.max(need, 5), 10); // batch of 5–10
    let qs: AnyQ[] = [];
    try {
      qs = await genBatch(type, unitNo, n, difficulty);
    } catch (e) {
      console.warn(`    batch failed (${type} u${unitNo} ${difficulty}): ${(e as Error).message}`);
      continue;
    }
    for (const q of qs) {
      const key = norm(stemOf(type, q));
      if (key && !seen.has(key)) {
        seen.add(key);
        out.push(q);
        if (out.length >= target) break;
      }
    }
  }
  return out.slice(0, target);
}

function toBankItems(type: BankType, level: BankLevel, unitNo: number, qs: AnyQ[]): BankItem<AnyQ>[] {
  return qs.map((q, i) => ({
    id: `u${unitNo}-${level}-${type}-${String(i + 1).padStart(2, '0')}`,
    question: q,
    gen_model: GEN_MODEL,
    // Phase 1.5 hook: run the automated accuracy pass here and set
    // 'pass' | 'flagged' (+ verify_note). For now everything is 'unchecked'.
    verified: 'unchecked' as const,
  }));
}

async function buildUnit(unitNo: number, targets: Record<BankType, number>): Promise<UnitBank> {
  const levels = {} as UnitBank['levels'];
  for (const { level, difficulty } of LEVELS) {
    const lb = { mc: [], tf: [], fitb: [], fr: [] } as UnitBank['levels'][BankLevel];
    for (const type of ['mc', 'tf', 'fitb', 'fr'] as BankType[]) {
      const target = targets[type];
      const qs = await genDistinct(type, unitNo, difficulty, target);
      (lb[type] as BankItem<AnyQ>[]) = toBankItems(type, level, unitNo, qs);
      console.log(`    ${level.padEnd(8)} ${type.toUpperCase().padEnd(4)} ${qs.length}/${target}`);
    }
    levels[level] = lb;
  }
  return { unit_no: unitNo, generated_at: new Date().toISOString(), levels };
}

async function main(): Promise<number> {
  const { units, targets } = parseArgs();
  mkdirSync(BANK_DIR, { recursive: true });
  console.log(`Building question bank with model: ${GEN_MODEL}`);
  console.log(`Units: ${units.join(', ')}`);
  console.log(`Targets per level: MC ${targets.mc}, TF ${targets.tf}, FITB ${targets.fitb}, FR ${targets.fr}\n`);

  for (const unitNo of units) {
    console.log(`Unit ${unitNo}:`);
    const bank = await buildUnit(unitNo, targets);
    const out = join(BANK_DIR, `unit-${String(unitNo).padStart(2, '0')}.json`);
    writeFileSync(out, JSON.stringify(bank, null, 2), 'utf8');
    console.log(`  → wrote ${out}\n`);
  }
  console.log('Done.');
  return 0;
}

main().then((code) => process.exit(code));
