/**
 * AI-generated practice questions: MC, TF, FITB.
 *
 * Each generator:
 *   1. Sends a prompt to Claude with the unit's content as a cached system block.
 *   2. Parses Claude's strict-JSON output via zod.
 *   3. Retries once on malformed output.
 *
 * Grading is local — no LLM round-trip for objective questions:
 *   - MC: compare integer index.
 *   - TF: compare boolean.
 *   - FITB: normalize student response and the answer, accept hyphen-/plural-/
 *     case-insensitive variants and any synonyms the LLM provided.
 *
 * Per the professor's spec:
 *   - MC always has 5 options. Intro difficulty must NOT use meta-options
 *     ("two of the above", "all of the above", "None of the above").
 *     Intermediate/advanced may include them.
 *   - FITB draws on the terms list for the chosen unit so the answer set
 *     is curriculum-aligned, not invented by the LLM.
 */

import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import { getAnthropic, GEN_MODEL, TUTOR_MODEL } from './anthropic.js';
import { getUnit, type UnitContent } from './content.js';

// ─── Question schemas ───────────────────────────────────────────────────────

export const McQuestion = z.object({
  stem: z.string().min(8),
  options: z.array(z.string().min(1)).length(5),
  correct_index: z.number().int().min(0).max(4),
  explanation: z.string().min(1),
});
export type McQuestion = z.infer<typeof McQuestion>;

export const TfQuestion = z.object({
  stem: z.string().min(4),
  correct: z.boolean(),
  explanation: z.string().min(1),
});
export type TfQuestion = z.infer<typeof TfQuestion>;

export const FitbQuestion = z.object({
  stem: z.string().min(4),
  answer: z.string().min(1),
  accepted_synonyms: z.array(z.string()).default([]),
  explanation: z.string().min(1),
});
export type FitbQuestion = z.infer<typeof FitbQuestion>;

export const FrRubricItem = z.object({
  points: z.number().int().min(1).max(3),
  criterion: z.string().min(8),
});
export type FrRubricItem = z.infer<typeof FrRubricItem>;

export const FrQuestion = z.object({
  prompt: z.string().min(10),
  total_marks: z.number().int().min(3).max(8),
  rubric: z.array(FrRubricItem).min(2).max(8),
  model_answer: z.string().min(20),
});
export type FrQuestion = z.infer<typeof FrQuestion>;

export const FrCriterionGrade = z.object({
  criterion: z.string(),
  max_points: z.number().int(),
  awarded: z.number().int().min(0),
  coverage: z.enum(['full', 'partial', 'missing']),
  rationale: z.string().min(1),
});
export type FrCriterionGrade = z.infer<typeof FrCriterionGrade>;

export const FrGrade = z.object({
  total_awarded: z.number().int().min(0),
  total_possible: z.number().int().min(1),
  per_criterion: z.array(FrCriterionGrade).min(1),
  strong: z.string(),
  missing: z.string(),
  not_needed: z.string(),
});
export type FrGrade = z.infer<typeof FrGrade>;

export type Difficulty = 'introductory' | 'intermediate' | 'advanced';
export type QuizKind = 'mc' | 'tf' | 'fitb' | 'fr';

// ─── Prompt building ────────────────────────────────────────────────────────

const SYSTEM_PREAMBLE = `You generate practice questions for an undergraduate Human Anatomy & Physiology course (BIOL 1592, Thompson Rivers University). Your questions must:
- Match the professor's voice and difficulty profile from the example exam below.
- Stay anchored in the unit content provided.
- Be unambiguous: each question has exactly one correct answer.
- Avoid trivia ("when was this discovered?"). Test understanding of mechanisms, structure, function, and relationships.
- Use only terminology a student in this unit would have encountered.
- Never reproduce a question verbatim from the example exam — use it only as a style anchor.

Output STRICTLY valid JSON. No markdown fences, no preamble, no trailing commentary.
Your entire response must be a single JSON array (or object as specified per question type).`;

const DIFFICULTY_NOTES: Record<Difficulty, string> = {
  introductory:
    'Introductory: tests direct recall of definitions, structures, and named concepts the student should learn first in this unit. Plain factual recognition. For MC, options should be plausibly close but each clearly distinguishable; DO NOT use meta-options ("two of the above", "all of the above", "None of the above").',
  intermediate:
    'Intermediate: tests application and comparison. The student should have to relate two concepts, predict an outcome from a mechanism, or distinguish between similar processes. MC may use one meta-option per question if useful (e.g. "two of the above", "None of the above" when correct).',
  advanced:
    'Advanced: tests synthesis across the unit and edge cases. The student should have to reason through a multi-step mechanism or evaluate a scenario. MC may use meta-options including "two of the above", "all of the above", and "None of the above" when appropriate.',
};

function unitGrounding(unit: UnitContent): string {
  const parts = [
    `# UNIT ${unit.unit_no}: ${unit.ppt_title}`,
    `\n## Key terms for this unit`,
    unit.terms.length ? unit.terms.map((t) => `- ${t}`).join('\n') : '(no terms list)',
    `\n## Lecture slides (instructor's PPT + speaker notes)`,
    unit.ppt_markdown,
  ];
  if (unit.textbook) {
    parts.push(
      `\n## Open textbook chapter (Pressbooks A&P I)`,
      `Source: ${unit.textbook.url}\n`,
      unit.textbook.markdown
    );
  }
  return parts.join('\n');
}

const MC_USER = (count: number, difficulty: Difficulty) => `Generate ${count} multiple-choice questions at ${difficulty} difficulty.

${DIFFICULTY_NOTES[difficulty]}

Each question MUST have exactly 5 options. correct_index is 0–4 (zero-indexed).

Output JSON shape (a single array):
[
  {
    "stem": "...",
    "options": ["A", "B", "C", "D", "E"],
    "correct_index": 0,
    "explanation": "Why the correct one is correct AND why each incorrect one is wrong (one short sentence per distractor)."
  }
]`;

const TF_USER = (count: number, difficulty: Difficulty) => `Generate ${count} true/false questions at ${difficulty} difficulty.

${DIFFICULTY_NOTES[difficulty]}

Mix true and false roughly evenly. The explanation should make clear *why* — and if false, what the correct version of the statement would be.

Output JSON shape (a single array):
[
  {
    "stem": "Statement, written as a positive declaration.",
    "correct": true,
    "explanation": "Why."
  }
]`;

const FR_USER = (count: number, difficulty: Difficulty) => `Generate ${count} free-response question(s) at ${difficulty} difficulty.

${DIFFICULTY_NOTES[difficulty]}

Each question is worth 5–6 marks total. The rubric breaks the marks down into specific, atomic criteria the grader can score independently — exactly how the professor's example exam does it (e.g. "Both involve ribose, phosphorous groups and adenine — 1 mark").

The model_answer should be a complete answer that would earn full marks. Keep it concise but with enough detail that a student could see where each mark was earned.

Rules:
- Each rubric item is worth 1–3 marks; the rubric points must SUM to the total_marks.
- Each rubric item describes ONE atomic concept/claim. Don't bundle.
- The question prompt should require synthesis or comparison — not just recall (that's what FITB is for).
- Anchor in this unit's content; questions that span multiple units are out of scope.

Output JSON shape (a single array):
[
  {
    "prompt": "Compare and contrast …",
    "total_marks": 5,
    "rubric": [
      { "points": 1, "criterion": "Identifies both X and Y as having structural feature Z." },
      { "points": 2, "criterion": "Explains the mechanism by which …" },
      { "points": 2, "criterion": "Distinguishes how they differ in …" }
    ],
    "model_answer": "Both X and Y share … but differ in …"
  }
]`;

const FITB_USER = (count: number, difficulty: Difficulty, terms: string[]) => `Generate ${count} fill-in-the-blank questions at ${difficulty} difficulty.

${DIFFICULTY_NOTES[difficulty]}

The answer MUST be drawn from this unit's terms list:
${terms.map((t) => `- ${t}`).join('\n')}

For each question:
- Use exactly one underline "____________" to mark the blank in the stem.
- The answer must be a term from the list above (exact form).
- Provide accepted_synonyms with: any plausible singular/plural variants, hyphenated/unhyphenated forms, and any common synonyms (e.g. "fight or flight" / "fight-or-flight"). Server-side normalization handles case and whitespace; you don't need to list those.

Output JSON shape (a single array):
[
  {
    "stem": "Sentence with ____________ blank.",
    "answer": "the term",
    "accepted_synonyms": ["variant1", "variant2"],
    "explanation": "Why this term."
  }
]`;

// ─── Generation ─────────────────────────────────────────────────────────────

function stripCodeFences(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
}

async function callGenerator(
  unit: UnitContent,
  userPrompt: string,
  retryOnBadShape: boolean = true
): Promise<unknown> {
  const client = getAnthropic();
  const res = await client.messages.create({
    model: GEN_MODEL,
    max_tokens: 4096,
    system: [
      { type: 'text', text: SYSTEM_PREAMBLE },
      {
        type: 'text',
        text: unitGrounding(unit),
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [{ role: 'user', content: userPrompt }],
  });

  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');

  const cleaned = stripCodeFences(text);

  try {
    return JSON.parse(cleaned);
  } catch (parseErr) {
    if (!retryOnBadShape) throw parseErr;
    // One retry with a hint about the malformed output.
    const retry = await client.messages.create({
      model: GEN_MODEL,
      max_tokens: 4096,
      system: [
        { type: 'text', text: SYSTEM_PREAMBLE },
        {
          type: 'text',
          text: unitGrounding(unit),
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [
        { role: 'user', content: userPrompt },
        { role: 'assistant', content: text },
        {
          role: 'user',
          content:
            'Your previous response was not valid JSON. Return ONLY the JSON array, no other text, no code fences. Do not apologize. Just the JSON.',
        },
      ],
    });
    const retryText = retry.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    return JSON.parse(stripCodeFences(retryText));
  }
}

export async function generateMC(
  unitNo: number,
  count: number,
  difficulty: Difficulty
): Promise<McQuestion[]> {
  const unit = getUnit(unitNo);
  const raw = await callGenerator(unit, MC_USER(count, difficulty));
  const parsed = z.array(McQuestion).parse(raw);
  return parsed.slice(0, count);
}

export async function generateTF(
  unitNo: number,
  count: number,
  difficulty: Difficulty
): Promise<TfQuestion[]> {
  const unit = getUnit(unitNo);
  const raw = await callGenerator(unit, TF_USER(count, difficulty));
  const parsed = z.array(TfQuestion).parse(raw);
  return parsed.slice(0, count);
}

export async function generateFR(
  unitNo: number,
  count: number,
  difficulty: Difficulty
): Promise<FrQuestion[]> {
  const unit = getUnit(unitNo);
  const raw = await callGenerator(unit, FR_USER(count, difficulty));
  const parsed = z.array(FrQuestion).parse(raw);
  // Enforce rubric-points-sum-to-total-marks (LLMs sometimes drift).
  for (const q of parsed) {
    const sum = q.rubric.reduce((acc, r) => acc + r.points, 0);
    if (sum !== q.total_marks) {
      // Trust the rubric, override total_marks to match.
      q.total_marks = sum;
    }
  }
  return parsed.slice(0, count);
}

export async function generateFITB(
  unitNo: number,
  count: number,
  difficulty: Difficulty
): Promise<FitbQuestion[]> {
  const unit = getUnit(unitNo);
  if (unit.terms.length === 0) {
    throw new Error(`Unit ${unitNo} has no terms list; cannot generate FITB.`);
  }
  const raw = await callGenerator(unit, FITB_USER(count, difficulty, unit.terms));
  const parsed = z.array(FitbQuestion).parse(raw);
  return parsed.slice(0, count);
}

// ─── Grading ────────────────────────────────────────────────────────────────

/**
 * Normalize a string for FITB comparison:
 *   - lowercase
 *   - NFKD normalize (handles accents)
 *   - strip everything except a-z 0-9 and internal whitespace
 *   - collapse whitespace
 *   - generate variants: with/without trailing 's', with/without hyphens
 *
 * Returns a Set of variants for any input.
 */
function fitbVariants(input: string): Set<string> {
  const variants = new Set<string>();
  if (!input) return variants;
  const base = input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();

  const candidates = new Set<string>();
  // 1) plain
  candidates.add(base);
  // 2) collapse hyphens into spaces, and the inverse
  candidates.add(base.replace(/-/g, ' '));
  candidates.add(base.replace(/\s+/g, '-'));
  // 3) strip hyphens entirely
  candidates.add(base.replace(/-/g, ''));

  for (const c of candidates) {
    const norm = c.replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, ' ').trim();
    if (!norm) continue;
    variants.add(norm);
    // plural/singular toggle
    if (/[a-z]s$/.test(norm)) variants.add(norm.slice(0, -1)); // drop trailing s
    else variants.add(norm + 's');
    // ies <-> y (e.g. "antibodies" <-> "antibody")
    if (norm.endsWith('ies')) variants.add(norm.slice(0, -3) + 'y');
    else if (norm.endsWith('y')) variants.add(norm.slice(0, -1) + 'ies');
  }
  return variants;
}

export function gradeFITB(q: FitbQuestion, response: string): { correct: boolean; normalized_response: string } {
  const expected = new Set<string>();
  fitbVariants(q.answer).forEach((v) => expected.add(v));
  for (const syn of q.accepted_synonyms) {
    fitbVariants(syn).forEach((v) => expected.add(v));
  }
  const studentVariants = fitbVariants(response);
  for (const v of studentVariants) {
    if (expected.has(v)) {
      return { correct: true, normalized_response: v };
    }
  }
  // surface the canonical normalized response for storage
  const first = studentVariants.values().next().value;
  return { correct: false, normalized_response: first || response };
}

export function gradeMC(q: McQuestion, chosenIndex: number): boolean {
  return chosenIndex === q.correct_index;
}

export function gradeTF(q: TfQuestion, chosenBool: boolean): boolean {
  return chosenBool === q.correct;
}

// ─── FR grading (LLM call) ──────────────────────────────────────────────────

const FR_GRADER_SYSTEM = `You are an experienced TA grading free-response answers for an undergraduate Human Anatomy & Physiology course (BIOL 1592). You grade strictly against the provided rubric — not against your own impression of completeness.

Rules:
1. Award points only for criteria the student's response actually addresses. Be neither generous nor stingy — match the rubric.
2. For each rubric item, choose coverage:
   - "full"   = student fully addressed the criterion. Award full points.
   - "partial"= student addressed part of the criterion or got close but missed a detail. Award 1 point fewer than max if max ≥ 2, else 0.
   - "missing"= student didn't address this criterion. Award 0.
3. The rationale for each criterion must point to specific phrases in the student's response when awarding points, and name what was missing when not.
4. "Missing" describes what the student's response did NOT include that the rubric required.
5. "Not_needed" describes content in the student's response that's biology-related but outside the question's scope (off-topic detail). Empty string if the response was tight.
6. "Strong" names 1–2 things the student clearly nailed. Empty string if nothing rose to that bar.
7. Be encouraging but factual. The student will read this.

Output STRICTLY valid JSON. No markdown, no preamble.`;

const FR_GRADER_USER = (q: FrQuestion, response: string) => `Question (worth ${q.total_marks} marks):
${q.prompt}

Rubric:
${q.rubric.map((r, i) => `  ${i + 1}. (${r.points} mark${r.points === 1 ? '' : 's'}) ${r.criterion}`).join('\n')}

Model answer (for reference — do NOT show this in your output):
${q.model_answer}

Student's response:
"""
${response}
"""

Grade this response against the rubric. Output JSON in this shape:
{
  "total_awarded": <int>,
  "total_possible": ${q.total_marks},
  "per_criterion": [
    { "criterion": "<exact rubric criterion text>", "max_points": <int>, "awarded": <int>, "coverage": "full"|"partial"|"missing", "rationale": "<one sentence>" }
  ],
  "strong": "<1-sentence summary, or empty string>",
  "missing": "<1-2 sentences on what was required but absent>",
  "not_needed": "<1-2 sentences on irrelevant content, or empty string>"
}`;

export async function gradeFR(
  unit: UnitContent,
  question: FrQuestion,
  response: string
): Promise<FrGrade> {
  const client = getAnthropic();
  const res = await client.messages.create({
    model: TUTOR_MODEL, // Opus for grading — higher fidelity matters more than speed here
    max_tokens: 2048,
    system: [
      { type: 'text', text: FR_GRADER_SYSTEM },
      {
        type: 'text',
        text: unitGrounding(unit),
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [{ role: 'user', content: FR_GRADER_USER(question, response) }],
  });

  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  const raw = JSON.parse(stripCodeFences(text));
  const grade = FrGrade.parse(raw);
  // Defensive: clamp total against rubric items.
  const sumAwarded = grade.per_criterion.reduce((a, c) => a + c.awarded, 0);
  if (sumAwarded !== grade.total_awarded) grade.total_awarded = sumAwarded;
  return grade;
}

