/**
 * Automated accuracy pass for the question bank (Phase 1.5).
 *
 * Cross-checks one generated question against its unit's lecture + textbook
 * grounding and returns a verdict. This is the safeguard that lets us ship an
 * AI-generated bank the instructor can't hand-review in full: it catches the
 * class of error testing surfaced — e.g. GABA mislabeled a biogenic amine
 * (contradicting the course material), a "correct" answer that isn't, or an MC
 * item with two defensible options.
 *
 * Used at bank-build time (scripts/build_question_bank.ts). Runs on a strong
 * model — pass the top model in.
 */

import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import { getAnthropic } from './anthropic.js';
import { recordApiCall } from './costs.js';
import { getUnit } from './content.js';
import {
  unitGrounding,
  type McQuestion,
  type TfQuestion,
  type FitbQuestion,
  type FrQuestion,
} from './quiz.js';
import type { BankType } from './questionBank.js';

const Verdict = z.object({
  verdict: z.enum(['pass', 'flag']),
  issue: z.string().default(''),
});

export type VerifyResult = { verified: 'pass' | 'flagged' | 'unchecked'; note: string };

const VERIFY_SYSTEM = `You are a meticulous Human Anatomy & Physiology subject-matter expert reviewing an auto-generated PRACTICE question for accuracy before it enters a student question bank.

The unit's actual course material (lecture slides + open textbook) is provided below as the authority. Judge the question against it.

Flag the question ("flag") if ANY of these hold:
- It states something biologically incorrect, or contradicts the course material — a classification, mechanism, or definition that disagrees with the lecture/textbook (e.g. calling GABA a biogenic amine when the course classifies it as an amino acid).
- (multiple choice / true-false / fill-in-blank) The answer marked correct is not actually correct.
- (multiple choice) More than one option is defensibly correct, or the intended-correct option is ambiguous — a knowledgeable student could justifiably choose another.
- (free response) A rubric criterion or the model answer is factually wrong or inconsistent with the course material.

Otherwise return "pass".

Be strict about factual accuracy and single-correct-answer. Do NOT flag a question merely for being hard, terse, or testing a peripheral-but-correct detail — only genuine errors or ambiguity. Defer to the COURSE MATERIAL for classifications and definitions; that is what the students were taught and will be graded against.

Respond with ONLY a single JSON object and nothing else — no explanation before or after, no markdown:
{ "verdict": "pass" | "flag", "issue": "<one sentence naming the specific problem, or empty string if pass>" }`;

/** Pull the JSON object out of the model's reply, tolerating stray prose/fences. */
function extractJson(text: string): string {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  return start >= 0 && end > start ? t.slice(start, end + 1) : t;
}

/** Render a question for the reviewer, type-appropriately. */
function describe(type: BankType, q: McQuestion | TfQuestion | FitbQuestion | FrQuestion): string {
  if (type === 'mc') {
    const m = q as McQuestion;
    const opts = m.options
      .map((o, i) => `  (${String.fromCharCode(65 + i)}) ${o}${i === m.correct_index ? '   ← marked correct' : ''}`)
      .join('\n');
    return `TYPE: multiple choice\nSTEM: ${m.stem}\nOPTIONS:\n${opts}`;
  }
  if (type === 'tf') {
    const t = q as TfQuestion;
    return `TYPE: true/false\nSTATEMENT: ${t.stem}\nMARKED CORRECT: ${t.correct ? 'TRUE' : 'FALSE'}`;
  }
  if (type === 'fitb') {
    const f = q as FitbQuestion;
    return `TYPE: fill-in-the-blank\nSTEM: ${f.stem}\nEXPECTED ANSWER: ${f.answer}`;
  }
  const fr = q as FrQuestion;
  return (
    `TYPE: free response\nPROMPT: ${fr.prompt}\n` +
    `RUBRIC:\n${fr.rubric.map((r, i) => `  ${i + 1}. (${r.points}) ${r.criterion}`).join('\n')}\n` +
    `MODEL ANSWER: ${fr.model_answer}`
  );
}

/**
 * Verify one question against its unit's grounding. Never throws — on any
 * failure it returns 'unchecked' (not 'pass'), so a transient error can't
 * silently certify a bad question.
 */
export async function verifyQuestion(
  unitNo: number,
  type: BankType,
  question: McQuestion | TfQuestion | FitbQuestion | FrQuestion,
  model: string
): Promise<VerifyResult> {
  try {
    const unit = getUnit(unitNo);
    const client = getAnthropic();
    const res = await client.messages.create({
      model,
      max_tokens: 512,
      system: [
        { type: 'text', text: VERIFY_SYSTEM },
        // Grounding is identical for every question in the unit → cached, so a
        // unit's verification burst mostly bills at cache-read rates.
        { type: 'text', text: unitGrounding(unit), cache_control: { type: 'ephemeral' } },
      ],
      messages: [{ role: 'user', content: `Review this question:\n\n${describe(type, question)}` }],
    });
    void recordApiCall({ endpoint: 'quiz.bank.verify', model, usage: res.usage });
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    const v = Verdict.parse(JSON.parse(extractJson(text)));
    return { verified: v.verdict === 'flag' ? 'flagged' : 'pass', note: v.issue.trim() };
  } catch (e) {
    return { verified: 'unchecked', note: `verification failed: ${(e as Error).message}` };
  }
}
