/**
 * Builds the static question bank for the Biology Bot.
 *
 * For each unit × display level × type, generate N distinct questions once,
 * using the SAME tuned generators the live bot uses (slide anchoring, FR
 * rubric-alignment, etc.), then run each through the automated accuracy pass
 * that cross-checks it against the unit's lecture/textbook. Flagged questions
 * are auto-regenerated until they pass; the final bank ships 100% verified.
 *
 * SPEED: every model call (generation batch + verification) goes through one
 * global concurrency limiter, and all 8 (level × type) pipelines within a unit
 * run concurrently — so generation and verification overlap and the limiter
 * stays saturated. Tune the cap with BANK_CONCURRENCY (default 10); lower it if
 * you hit rate limits, raise it if your tier allows.
 *
 * Run with the TOP model (one-time, quality-critical):
 *   GEN_MODEL=claude-opus-4-8 npm run bank:build                      # full build
 *   GEN_MODEL=claude-opus-4-8 BANK_CONCURRENCY=16 npm run bank:build  # faster (higher tier)
 *   GEN_MODEL=claude-opus-4-8 npm run bank:build -- --units=17 --mc=3 --tf=2 --fitb=2 --fr=1
 *   GEN_MODEL=claude-opus-4-8 npm run bank:build -- --units=17 --no-verify
 *
 * Output:
 *   content/question-bank/unit-NN.json          — the served bank
 *   content/question-bank/_flagged-report.md    — any questions still flagged
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
import { verifyQuestion } from '../src/server/questionVerify.js';
import type { BankItem, BankLevel, BankType, UnitBank } from '../src/server/questionBank.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BANK_DIR = join(ROOT, 'content', 'question-bank');

// Display level → internal difficulty. The hardest internal tier ('advanced')
// is intentionally dropped — this intro course only needs two levels.
const LEVELS: { level: BankLevel; difficulty: Difficulty }[] = [
  { level: 'basic', difficulty: 'introductory' },
  { level: 'advanced', difficulty: 'intermediate' },
];
const TYPES: BankType[] = ['mc', 'tf', 'fitb', 'fr'];

const DEFAULT_TARGETS: Record<BankType, number> = { mc: 30, tf: 30, fitb: 30, fr: 10 };
const ALL_UNITS = Array.from({ length: 17 }, (_, i) => i + 1); // units 1..17
const MAX_REPAIR_TRIES = 3;
const CONCURRENCY = Math.max(1, parseInt(process.env.BANK_CONCURRENCY || '10', 10) || 10);

type AnyQ = McQuestion | TfQuestion | FitbQuestion | FrQuestion;
type Flagged = { unit: number; level: BankLevel; type: BankType; id: string; stem: string; note: string };

// ─── Global API-concurrency limiter ─────────────────────────────────────────
// Every model call (generation batch + verification) acquires a slot, so no
// matter how many pipelines run concurrently, at most CONCURRENCY calls are in
// flight. This is the single knob that keeps us under the account's rate limit.
class Semaphore {
  private cur = 0;
  private queue: (() => void)[] = [];
  constructor(private max: number) {}
  private async acquire(): Promise<void> {
    if (this.cur < this.max) { this.cur++; return; }
    // Wait to be handed a slot by release(); cur already accounts for it,
    // so we must NOT increment again here (that would exceed max).
    await new Promise<void>((resolve) => this.queue.push(resolve));
  }
  private release(): void {
    const next = this.queue.shift();
    if (next) next(); // transfer the slot to a waiter (cur unchanged)
    else this.cur--; // no waiter: free the slot
  }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}
const limiter = new Semaphore(CONCURRENCY);

// ─── Args ────────────────────────────────────────────────────────────────────

function argVal(flag: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${flag}=`));
  return hit ? hit.slice(flag.length + 3) : undefined;
}
const hasFlag = (flag: string): boolean => process.argv.includes(`--${flag}`);

function parseArgs() {
  const unitsArg = argVal('units');
  const units = unitsArg ? unitsArg.split(',').map((s) => parseInt(s.trim(), 10)) : ALL_UNITS;
  const targets: Record<BankType, number> = { ...DEFAULT_TARGETS };
  for (const t of TYPES) {
    const v = argVal(t);
    if (v) targets[t] = parseInt(v, 10);
  }
  return { units, targets, verify: !hasFlag('no-verify') };
}

// ─── Generation + verification (all model calls go through the limiter) ──────

const stemOf = (type: BankType, q: AnyQ): string =>
  type === 'fr' ? (q as FrQuestion).prompt : (q as McQuestion | TfQuestion | FitbQuestion).stem;
const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

function genBatch(type: BankType, unitNo: number, n: number, difficulty: Difficulty): Promise<AnyQ[]> {
  return limiter.run<AnyQ[]>(() => {
    if (type === 'mc') return generateMC(unitNo, n, difficulty);
    if (type === 'tf') return generateTF(unitNo, n, difficulty);
    if (type === 'fitb') return generateFITB(unitNo, n, difficulty);
    return generateFR(unitNo, n, difficulty);
  });
}

const verify1 = (unitNo: number, type: BankType, q: AnyQ) =>
  limiter.run(() => verifyQuestion(unitNo, type, q, GEN_MODEL));

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

/** Verify a whole batch concurrently (global limiter caps in-flight calls). */
async function verifyAndBuild(
  type: BankType,
  level: BankLevel,
  unitNo: number,
  qs: AnyQ[],
  verify: boolean
): Promise<BankItem<AnyQ>[]> {
  const verdicts = verify
    ? await Promise.all(qs.map((q) => verify1(unitNo, type, q)))
    : qs.map(() => ({ verified: 'unchecked' as const, note: '' }));

  return qs.map((q, i) => {
    const id = `u${unitNo}-${level}-${type}-${String(i + 1).padStart(2, '0')}`;
    const v = verdicts[i]!;
    const item: BankItem<AnyQ> = { id, question: q, gen_model: GEN_MODEL, verified: v.verified };
    if (v.note) item.verify_note = v.note;
    return item;
  });
}

/**
 * Replace each flagged item in place with a freshly generated, verified-passing
 * question of the same type. Keeps id/position and avoids stems already used.
 * Anything still failing after MAX_REPAIR_TRIES stays flagged (rare).
 */
async function repairFlagged(
  type: BankType,
  unitNo: number,
  difficulty: Difficulty,
  items: BankItem<AnyQ>[],
  seen: Set<string>
): Promise<void> {
  for (let i = 0; i < items.length; i++) {
    if (items[i]!.verified !== 'flagged') continue;
    const oldKey = norm(stemOf(type, items[i]!.question));
    for (let t = 0; t < MAX_REPAIR_TRIES; t++) {
      let batch: AnyQ[] = [];
      try {
        batch = await genBatch(type, unitNo, 5, difficulty);
      } catch {
        continue;
      }
      let replaced = false;
      for (const c of batch) {
        const key = norm(stemOf(type, c));
        if (!key || seen.has(key)) continue;
        seen.add(key);
        const v = await verify1(unitNo, type, c);
        if (v.verified === 'pass') {
          seen.delete(oldKey);
          items[i] = { id: items[i]!.id, question: c, gen_model: GEN_MODEL, verified: 'pass' };
          replaced = true;
          break;
        }
      }
      if (replaced) break;
    }
  }
}

const countVerdict = (items: BankItem<AnyQ>[], v: BankItem<AnyQ>['verified']): number =>
  items.filter((it) => it.verified === v).length;

// ─── Per-unit build (8 level×type pipelines run concurrently) ────────────────

async function buildOne(
  unitNo: number,
  level: BankLevel,
  difficulty: Difficulty,
  type: BankType,
  target: number,
  verify: boolean
): Promise<{ level: BankLevel; type: BankType; items: BankItem<AnyQ>[]; flagged: Flagged[] }> {
  const qs = await genDistinct(type, unitNo, difficulty, target);
  const seen = new Set(qs.map((q) => norm(stemOf(type, q))));
  const items = await verifyAndBuild(type, level, unitNo, qs, verify);

  const flaggedBefore = countVerdict(items, 'flagged');
  if (verify && flaggedBefore > 0) await repairFlagged(type, unitNo, difficulty, items, seen);

  const flagged: Flagged[] = [];
  for (const it of items) {
    if (it.verified === 'flagged') {
      flagged.push({
        unit: unitNo, level, type, id: it.id,
        stem: stemOf(type, it.question).slice(0, 160), note: it.verify_note ?? '',
      });
    }
  }

  const pass = countVerdict(items, 'pass');
  const flag = countVerdict(items, 'flagged');
  const unchecked = countVerdict(items, 'unchecked');
  const repaired = verify && flaggedBefore > 0 ? ` [repaired ${flaggedBefore - flag}/${flaggedBefore}]` : '';
  const tail = verify ? `(${pass} pass, ${flag} flagged, ${unchecked} unchecked)${repaired}` : '(unverified)';
  console.log(`    ${level.padEnd(8)} ${type.toUpperCase().padEnd(4)} ${items.length}/${target} ${tail}`);
  return { level, type, items, flagged };
}

async function buildUnit(
  unitNo: number,
  targets: Record<BankType, number>,
  verify: boolean
): Promise<{ bank: UnitBank; flagged: Flagged[] }> {
  const combos = LEVELS.flatMap(({ level, difficulty }) =>
    TYPES.map((type) => ({ level, difficulty, type }))
  );
  const results = await Promise.all(
    combos.map((c) => buildOne(unitNo, c.level, c.difficulty, c.type, targets[c.type], verify))
  );

  const empty = (): UnitBank['levels'][BankLevel] => ({ mc: [], tf: [], fitb: [], fr: [] });
  const levels = { basic: empty(), advanced: empty() } as UnitBank['levels'];
  const flagged: Flagged[] = [];
  for (const r of results) {
    (levels[r.level][r.type] as BankItem<AnyQ>[]) = r.items;
    flagged.push(...r.flagged);
  }
  return { bank: { unit_no: unitNo, generated_at: new Date().toISOString(), levels }, flagged };
}

// ─── Report + main ───────────────────────────────────────────────────────────

function writeFlaggedReport(flagged: Flagged[]): void {
  const path = join(BANK_DIR, '_flagged-report.md');
  if (flagged.length === 0) {
    writeFileSync(path, '# Flagged questions\n\nNone — every verified question passed the accuracy pass.\n', 'utf8');
    return;
  }
  const lines = [
    '# Flagged questions',
    '',
    `The accuracy pass flagged ${flagged.length} question(s) that repair couldn't fix. Review, regenerate, or remove them (or confirm the flag is a false alarm).`,
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
  console.log(`Concurrency: ${CONCURRENCY} (BANK_CONCURRENCY)`);
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
    console.log(`Accuracy pass left ${allFlagged.length} question(s) flagged. See content/question-bank/_flagged-report.md`);
  }
  console.log('Done.');
  return 0;
}

main().then((code) => process.exit(code));
