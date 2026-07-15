/**
 * Builds the static question bank for the Biology Bot.
 *
 * For each unit × display level × type, generate N distinct questions once,
 * using the SAME tuned generators the live bot uses (slide anchoring, FR
 * rubric-alignment, etc.), then run each through the automated accuracy pass
 * (Phase 1.5) that cross-checks it against the unit's lecture/textbook.
 *
 * Run with the TOP model — generation and verification quality are paramount
 * and this is one-time:
 *
 *   GEN_MODEL=claude-opus-4-8 npm run bank:build                     # full build (17 units)
 *   GEN_MODEL=claude-opus-4-8 npm run bank:build -- --units=17 --mc=3 --tf=2 --fitb=2 --fr=1
 *   GEN_MODEL=claude-opus-4-8 npm run bank:build -- --units=17 --no-verify   # skip accuracy pass
 *
 * Output:
 *   content/question-bank/unit-NN.json          — the served bank
 *   content/question-bank/_flagged-report.md    — questions the accuracy pass flagged
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
import { verifyQuestion, type VerifyResult } from '../src/server/questionVerify.js';
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
const VERIFY_CONCURRENCY = 6; // parallel verify calls per (unit, level, type)

type AnyQ = McQuestion | TfQuestion | FitbQuestion | FrQuestion;
type Flagged = { unit: number; level: BankLevel; type: BankType; id: string; stem: string; note: string };

function argVal(flag: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${flag}=`));
  return hit ? hit.slice(flag.length + 3) : undefined;
}
const hasFlag = (flag: string): boolean => process.argv.includes(`--${flag}`);

function parseArgs() {
  const unitsArg = argVal('units');
  const units = unitsArg ? unitsArg.split(',').map((s) => parseInt(s.trim(), 10)) : ALL_UNITS;
  const targets: Record<BankType, number> = { ...DEFAULT_TARGETS };
  for (const t of ['mc', 'tf', 'fitb', 'fr'] as BankType[]) {
    const v = argVal(t);
    if (v) targets[t] = parseInt(v, 10);
  }
  return { units, targets, verify: !hasFlag('no-verify') };
}

const stemOf = (type: BankType, q: AnyQ): string =>
  type === 'fr' ? (q as FrQuestion).prompt : (q as McQuestion | TfQuestion | FitbQuestion).stem;

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** Run `fn` over items with at most `limit` in flight. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let idx = 0;
  async function worker(): Promise<void> {
    while (idx < items.length) {
      const cur = idx++;
      out[cur] = await fn(items[cur]!, cur);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) || 1 }, () => worker()));
  return out;
}

async function genBatch(type: BankType, unitNo: number, n: number, difficulty: Difficulty): Promise<AnyQ[]> {
  if (type === 'mc') return generateMC(unitNo, n, difficulty);
  if (type === 'tf') return generateTF(unitNo, n, difficulty);
  if (type === 'fitb') return generateFITB(unitNo, n, difficulty);
  return generateFR(unitNo, n, difficulty);
}

/**
 * Generate `target` DISTINCT questions by calling the generator in batches
 * (slide anchors vary per call → diversity) and deduping by normalized stem.
 * Bounded attempts so a thin unit can't loop forever.
 */
async function genDistinct(type: BankType, unitNo: number, difficulty: Difficulty, target: number): Promise<AnyQ[]> {
  const seen = new Set<string>();
  const out: AnyQ[] = [];
  const maxAttempts = Math.ceil(target / 5) + 4;
  for (let attempt = 0; out.length < target && attempt < maxAttempts; attempt++) {
    const need = target - out.length;
    const n = Math.min(Math.max(need, 5), 10);
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

/** Verify a batch (or mark unchecked when --no-verify) and assemble bank items. */
async function verifyAndBuild(
  type: BankType,
  level: BankLevel,
  unitNo: number,
  qs: AnyQ[],
  verify: boolean
): Promise<{ items: BankItem<AnyQ>[]; flagged: Flagged[] }> {
  const verdicts: VerifyResult[] = verify
    ? await mapLimit(qs, VERIFY_CONCURRENCY, (q) => verifyQuestion(unitNo, type, q, GEN_MODEL))
    : qs.map(() => ({ verified: 'unchecked' as const, note: '' }));

  const flagged: Flagged[] = [];
  const items = qs.map((q, i) => {
    const id = `u${unitNo}-${level}-${type}-${String(i + 1).padStart(2, '0')}`;
    const v = verdicts[i]!;
    if (v.verified === 'flagged') {
      flagged.push({ unit: unitNo, level, type, id, stem: stemOf(type, q).slice(0, 160), note: v.note });
    }
    const item: BankItem<AnyQ> = { id, question: q, gen_model: GEN_MODEL, verified: v.verified };
    if (v.note) item.verify_note = v.note;
    return item;
  });
  return { items, flagged };
}

async function buildUnit(
  unitNo: number,
  targets: Record<BankType, number>,
  verify: boolean
): Promise<{ bank: UnitBank; flagged: Flagged[] }> {
  const levels = {} as UnitBank['levels'];
  const flagged: Flagged[] = [];
  for (const { level, difficulty } of LEVELS) {
    const lb = { mc: [], tf: [], fitb: [], fr: [] } as UnitBank['levels'][BankLevel];
    for (const type of ['mc', 'tf', 'fitb', 'fr'] as BankType[]) {
      const target = targets[type];
      const qs = await genDistinct(type, unitNo, difficulty, target);
      const { items, flagged: f } = await verifyAndBuild(type, level, unitNo, qs, verify);
      (lb[type] as BankItem<AnyQ>[]) = items;
      flagged.push(...f);
      const pass = items.filter((it) => it.verified === 'pass').length;
      const flag = items.filter((it) => it.verified === 'flagged').length;
      const unchecked = items.filter((it) => it.verified === 'unchecked').length;
      const tail = verify ? `(${pass} pass, ${flag} flagged, ${unchecked} unchecked)` : '(unverified)';
      console.log(`    ${level.padEnd(8)} ${type.toUpperCase().padEnd(4)} ${items.length}/${target} ${tail}`);
    }
    levels[level] = lb;
  }
  return { bank: { unit_no: unitNo, generated_at: new Date().toISOString(), levels }, flagged };
}

function writeFlaggedReport(flagged: Flagged[]): void {
  const path = join(BANK_DIR, '_flagged-report.md');
  if (flagged.length === 0) {
    writeFileSync(path, '# Flagged questions\n\nNone — every verified question passed the accuracy pass.\n', 'utf8');
    return;
  }
  const lines = [
    '# Flagged questions',
    '',
    `The accuracy pass flagged ${flagged.length} question(s) for review. Regenerate or remove them (or confirm the flag is a false alarm).`,
    '',
  ];
  for (const f of flagged) {
    lines.push(`- **${f.id}** (unit ${f.unit}, ${f.level} ${f.type.toUpperCase()})`);
    lines.push(`  - Issue: ${f.note}`);
    lines.push(`  - Stem: ${f.stem}`);
  }
  writeFileSync(path, lines.join('\n') + '\n', 'utf8');
}

async function main(): Promise<number> {
  const { units, targets, verify } = parseArgs();
  mkdirSync(BANK_DIR, { recursive: true });
  console.log(`Building question bank with model: ${GEN_MODEL}`);
  console.log(`Units: ${units.join(', ')}`);
  console.log(`Targets per level: MC ${targets.mc}, TF ${targets.tf}, FITB ${targets.fitb}, FR ${targets.fr}`);
  console.log(`Accuracy pass: ${verify ? 'ON' : 'OFF (--no-verify)'}\n`);

  const allFlagged: Flagged[] = [];
  for (const unitNo of units) {
    console.log(`Unit ${unitNo}:`);
    const { bank, flagged } = await buildUnit(unitNo, targets, verify);
    allFlagged.push(...flagged);
    const out = join(BANK_DIR, `unit-${String(unitNo).padStart(2, '0')}.json`);
    writeFileSync(out, JSON.stringify(bank, null, 2), 'utf8');
    console.log(`  → wrote ${out}\n`);
  }

  if (verify) {
    writeFlaggedReport(allFlagged);
    console.log(`Accuracy pass flagged ${allFlagged.length} question(s). See content/question-bank/_flagged-report.md`);
  }
  console.log('Done.');
  return 0;
}

main().then((code) => process.exit(code));
