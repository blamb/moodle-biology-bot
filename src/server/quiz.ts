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
import { getAnthropic, GEN_MODEL, GRADER_MODEL } from './anthropic.js';
import { getUnit, type UnitContent } from './content.js';
import { recordApiCall, type Attribution } from './costs.js';
import { query } from './db.js';

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
  // Half-marks allowed (multiples of 0.5) so partial answers earn partial credit.
  awarded: z.number().min(0),
  coverage: z.enum(['full', 'partial', 'missing']),
  rationale: z.string().min(1),
});
export type FrCriterionGrade = z.infer<typeof FrCriterionGrade>;

export const FrGrade = z.object({
  total_awarded: z.number().min(0),
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
- Prioritize the instructor's study-guide prompts: most questions should align with the topics they raise. The user prompt assigns each question a specific anchor — a study-guide prompt or a unit slide.
- Stay anchored in the unit content provided.
- Be unambiguous: each question has exactly one correct answer.
- Avoid trivia ("when was this discovered?"). Test understanding of mechanisms, structure, function, and relationships.
- Use only terminology a student in this unit would have encountered.
- Never reproduce a question verbatim from the example exam — use it only as a style anchor.

DIVERSITY — this is critical:
- When asked for multiple questions, each question MUST target a DIFFERENT slide / section / concept from the unit. Do not cluster on one topic.
- Distribute coverage across the FULL range of the unit content (early slides, middle slides, late slides, textbook chapter), not just the most salient ideas.
- If the student has previously seen questions with certain stems (a list will be supplied in the user prompt under "Avoid these stems:"), generate fresh ones that target different content from those.
- Vary question framing: mix "identify the structure that...", "predict what happens when...", "compare X and Y", "what is the role of...". Don't write five questions that all start the same way.

ANATOMICAL PRECISION — self-check every question before finalizing:
- Any anatomical cue in the stem must uniquely identify the intended answer. If a cue could honestly point to more than one structure or category, rewrite the cue or pick a different question.
- Common A&P pitfalls to watch for:
  • The CNS is the brain AND the spinal cord. "Outside the skull" does NOT mean PNS — the spinal cord is outside the skull but is CNS. Use "outside the CNS" or "in a peripheral location" when you mean PNS.
  • "Inside the brain" / "inside the spinal cord" / "outside the CNS" are precise. "Inside the skull" / "outside the skull" are not.
  • Be careful with "above"/"below" injury levels — describe the segment explicitly (e.g. "below a T6 lesion") rather than relying on the reader to infer.
  • For tract/nerve, ganglion/nucleus, and grey/white matter distinctions: the determining factor is CNS vs PNS location, not skull-vs-spine.
- Verify the correct answer is unambiguously correct given ONLY the stem (no insider context). Verify each distractor (for MC) is unambiguously wrong.

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

export function unitGrounding(unit: UnitContent): string {
  const parts = [
    `# UNIT ${unit.unit_no}: ${unit.ppt_title}`,
    `\n## Key terms for this unit`,
    unit.terms.length ? unit.terms.map((t) => `- ${t}`).join('\n') : '(no terms list)',
  ];
  if (unit.study_guide && unit.study_guide.length) {
    parts.push(
      `\n## Instructor study-guide prompts (the topics the professor most wants emphasized)`,
      `These are the instructor's own open-ended study questions. Most generated questions should align with the topics they raise (the user prompt assigns specific anchors).`,
      unit.study_guide.map((q, i) => `${i + 1}. ${q}`).join('\n')
    );
  }
  parts.push(
    `\n## Lecture slides (instructor's PPT + speaker notes)`,
    unit.ppt_markdown
  );
  if (unit.textbook) {
    parts.push(
      `\n## Open textbook chapter (Pressbooks A&P I)`,
      `Source: ${unit.textbook.url}\n`,
      unit.textbook.markdown
    );
  }
  return parts.join('\n');
}

const MC_USER = (count: number, difficulty: Difficulty) => `Generate EXACTLY ${count} multiple-choice questions at ${difficulty} difficulty. Do not return fewer than ${count}. If you struggle to think of ${count} substantively different questions, target peripheral but curriculum-relevant content rather than reducing the count.

${DIFFICULTY_NOTES[difficulty]}

Each question MUST have exactly 5 options. correct_index is 0–4 (zero-indexed).

The "explanation" field MUST be Markdown formatted exactly like this template:

**Why (X) is correct:** [one sentence explaining why the correct option is the right answer]

**Why the other options are wrong:**
- **(A)** [one short sentence — skip this bullet if A is the correct option]
- **(B)** [one short sentence — skip this bullet if B is the correct option]
- **(C)** [one short sentence — skip this bullet if C is the correct option]
- **(D)** [one short sentence — skip this bullet if D is the correct option]
- **(E)** [one short sentence — skip this bullet if E is the correct option]

(Where X is the letter A–E of the correct option. The bulleted section must include exactly the four non-correct options.)

Output JSON shape (a single array):
[
  {
    "stem": "...",
    "options": ["A", "B", "C", "D", "E"],
    "correct_index": 0,
    "explanation": "**Why (A) is correct:** ...\\n\\n**Why the other options are wrong:**\\n- **(B)** ...\\n- **(C)** ...\\n- **(D)** ...\\n- **(E)** ..."
  }
]`;

const TF_USER = (count: number, difficulty: Difficulty) => `Generate EXACTLY ${count} true/false questions at ${difficulty} difficulty. Do not return fewer than ${count}. If you struggle to think of ${count} substantively different questions, target peripheral but curriculum-relevant content rather than reducing the count.

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

// Free-response difficulty calibration. FR is the place students find hardest,
// so the introductory tier is kept deliberately gentle — a student who has just
// learned the unit and grasped the main idea should earn most of the marks.
const FR_DIFFICULTY: Record<Difficulty, { note: string; marks: string; items: string }> = {
  introductory: {
    note: 'Introductory free-response: keep the scope tight and forgiving. Ask the student to identify/define and briefly explain ONE core idea, or a simple two-part identification. Do NOT demand full mechanistic depth, multi-step reasoning, or several distinct sub-points — that belongs at higher difficulties. The question should be answerable in a few sentences by someone who understood the unit\'s main points.',
    marks: '3–4 marks total',
    items: '2–3 rubric items',
  },
  intermediate: {
    note: 'Intermediate free-response: ask the student to apply or compare two concepts, or explain a mechanism at a moderate level of detail.',
    marks: '4–6 marks total',
    items: '3–4 rubric items',
  },
  advanced: {
    note: 'Advanced free-response: ask the student to synthesize across the unit or reason through a multi-step mechanism, with several distinct points to earn.',
    marks: '6–8 marks total',
    items: '4–6 rubric items',
  },
};

const FR_USER = (count: number, difficulty: Difficulty) => `Generate ${count} free-response question(s) at ${difficulty} difficulty.

${FR_DIFFICULTY[difficulty].note}

Each question is worth ${FR_DIFFICULTY[difficulty].marks} (${FR_DIFFICULTY[difficulty].items}). The rubric breaks the marks down into specific, atomic criteria the grader can score independently — exactly how the professor's example exam does it (e.g. "Both involve ribose, phosphorous groups and adenine — 1 mark").

The model_answer should be a complete answer that would earn full marks. Keep it concise but with enough detail that a student could see where each mark was earned.

Rules:
- Each rubric item is worth 1–3 marks; the rubric points must SUM to the total_marks.
- Each rubric item describes ONE atomic concept/claim. Don't bundle.
- Match the mark count and rubric-item count to the difficulty stated above — do not make an introductory question heavier than it should be.
- The question prompt should require some explanation or comparison — not just one-word recall (that's what FITB is for) — but keep the demand appropriate to the difficulty.
- Anchor in this unit's content; questions that span multiple units are out of scope.

CRITICAL — the question must explicitly ask for everything the rubric scores:
- Every rubric criterion MUST correspond to something the question prompt EXPLICITLY asks the student to do. A student reading only the prompt must be able to tell that each scored point is required of them.
- Do NOT score any concept, comparison, direction, ranking, or detail the prompt does not ask for. (For example: if the rubric awards a mark for "which of two things happens first" or "which is more effective," the prompt must explicitly ask the student to compare or rank them — otherwise drop that criterion.)
- Before finalizing, walk the rubric and check each item against the prompt text. For any criterion the prompt does not clearly request, either (a) add that request to the prompt wording, or (b) remove the criterion and rebalance the remaining marks so they still SUM to total_marks.
- It is better to have a well-aligned 4-mark question than a 5-mark question where one mark tests something the student was never asked for.
- Rubric criteria must not smuggle in qualifiers the prompt doesn't ask for. If a criterion requires wording like "the MAIN/primary X" or a specific location, the prompt must ask for that emphasis or location explicitly — otherwise phrase the criterion so the plain fact earns the mark.
- Symmetric criteria get symmetric marks: when two rubric items make the same kind of point about two parallel things (e.g. the function of each of two neurotransmitters), they MUST carry the same number of marks. Never weight one side of a parallel pair heavier.
- The prompt must not give away any scored point. If the rubric awards a mark for classifying/identifying something, the prompt cannot state that classification in its own wording (e.g. don't open with "X and Y are both amino acid neurotransmitters" and then award a mark for saying so).

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

const FITB_USER = (count: number, difficulty: Difficulty, terms: string[]) => `Generate EXACTLY ${count} fill-in-the-blank questions at ${difficulty} difficulty. Do not return fewer than ${count}.

${DIFFICULTY_NOTES[difficulty]}

The answer MUST be drawn from this unit's terms list:
${terms.map((t) => `- ${t}`).join('\n')}

For each question:
- Use exactly one underline "____________" to mark the blank in the stem.
- The answer must be a term from the list above (exact form).
- Provide accepted_synonyms with: any plausible singular/plural variants, hyphenated/unhyphenated forms, and any common synonyms (e.g. "fight or flight" / "fight-or-flight"). Server-side normalization handles case and whitespace; you don't need to list those.

CRITICAL — each blank must have exactly ONE correct term-list answer. Before finalizing every item, self-check ALL of these:
- ONE unambiguous answer: no OTHER term from the list could plausibly fill the blank. If the sentence would also accept a different term, add enough context to force the intended one, or pick a different fact.
- The answer is NOT given away: the answer term — and any obvious form of it — must NOT appear anywhere in the stem (including in parentheses). The student must supply it, not read it off. E.g. do NOT write "...are described as ____ (all-or-none)" when the answer is "all-or-none".
- Category match: the blank must grammatically and conceptually call for exactly the answer's category. If the sentence describes an ion moving, the answer is the ION (e.g. "potassium"), not a channel; if it describes a structure, the answer is that structure; if a process, that process. Do not answer "sodium channel" for a blank that describes the Na⁺/K⁺ pump.
- The sentence points unmistakably to that one term — a student who knows the unit produces exactly it, with no guessing between near-synonyms on the list.

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

/**
 * Pulls the distinct question stems the student has already seen for this
 * (unit, kind), most-recent first, capped at 30. Used as an "avoid these"
 * hint in the generation prompt to reduce repetition across regenerations.
 */
async function fetchRecentStems(
  studentId: number | null | undefined,
  unitNo: number,
  kind: QuizKind
): Promise<string[]> {
  if (!studentId) return [];
  try {
    const rows = await query<{ stem: string }>(
      `select (question->>'stem') as stem
       from quiz_attempt qa
       join session sess on sess.id = qa.session_id
       where qa.unit_no = $1 and qa.kind = $2 and sess.student_id = $3
         and (question->>'stem') is not null
       order by qa.ts desc
       limit 60`,
      [unitNo, kind, studentId]
    );
    const seen = new Set<string>();
    const out: string[] = [];
    for (const r of rows) {
      if (r.stem && !seen.has(r.stem)) {
        seen.add(r.stem);
        out.push(r.stem);
      }
      if (out.length >= 30) break;
    }
    return out;
  } catch {
    return [];
  }
}

/** FR questions store the stem under the 'prompt' field. */
async function fetchRecentFrPrompts(
  studentId: number | null | undefined,
  unitNo: number
): Promise<string[]> {
  if (!studentId) return [];
  try {
    const rows = await query<{ p: string }>(
      `select (question->>'prompt') as p
       from quiz_attempt qa
       join session sess on sess.id = qa.session_id
       where qa.unit_no = $1 and qa.kind = 'fr' and sess.student_id = $2
         and (question->>'prompt') is not null
       order by qa.ts desc
       limit 30`,
      [unitNo, studentId]
    );
    const seen = new Set<string>();
    const out: string[] = [];
    for (const r of rows) {
      if (r.p && !seen.has(r.p)) {
        seen.add(r.p);
        out.push(r.p);
      }
      if (out.length >= 15) break;
    }
    return out;
  } catch {
    return [];
  }
}

function avoidBlock(stems: string[]): string {
  if (stems.length === 0) return '';
  const lines = stems
    .map((s) => '- ' + (s.length > 220 ? s.slice(0, 217) + '…' : s));
  return `\n\nAvoid these stems (the student has already seen them — generate questions on DIFFERENT slides/topics, with substantively different wording):\n${lines.join('\n')}\n`;
}

/**
 * Parses the unit's PPT markdown for "### Slide N: Title" headers and returns
 * a list of slide numbers + titles. Excludes typical intro/summary/reference
 * slides (slide 1, and the last two if we have enough).
 */
function listSlides(unit: UnitContent): { no: number; title: string }[] {
  const re = /^### Slide (\d+):\s*(.+)$/gm;
  const all: { no: number; title: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(unit.ppt_markdown)) !== null) {
    const n = parseInt(m[1]!, 10);
    if (n > 1) all.push({ no: n, title: m[2]!.trim() });
  }
  // Drop the last 1–2 slides when the unit has enough content (often
  // "Summary" / "References" — low-value question targets).
  if (all.length >= 8) return all.slice(0, -2);
  if (all.length >= 5) return all.slice(0, -1);
  return all;
}

/**
 * Picks `count` random distinct slides from the unit. Returns them in slide
 * order so the prompt reads naturally. Falls back to all available slides if
 * count exceeds the pool.
 */
function pickSlideAnchors(unit: UnitContent, count: number): { no: number; title: string }[] {
  const pool = listSlides(unit);
  if (pool.length === 0) return [];
  if (count >= pool.length) return pool.slice();
  const shuffled = pool.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }
  return shuffled.slice(0, count).sort((a, b) => a.no - b.no);
}

/** Fisher–Yates shuffle, returning a new array. */
function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/**
 * The share of a batch anchored to the instructor's study-guide prompts. The
 * remainder is anchored to random unit slides so questions still roam the full
 * unit — "most, but not all, align with the study guide" (professor's spec).
 */
const STUDY_GUIDE_RATIO = 0.75;

type Anchor =
  | { kind: 'guide'; text: string }
  | { kind: 'slide'; no: number; title: string };

/**
 * Builds per-question anchors that bias generation toward the study guide.
 * ~STUDY_GUIDE_RATIO of the batch maps to a study-guide prompt; the rest map
 * to random slides. Degrades gracefully:
 *   - unit with no study guide  → all slide anchors (original behavior)
 *   - unit with no parseable slides → all guide anchors
 * When the batch needs more guide-anchored questions than the guide has
 * distinct prompts, prompts are reused round-robin (each yields a different
 * facet), so the ratio is honored even for short guides.
 */
function buildAnchors(unit: UnitContent, count: number): Anchor[] {
  const guides = unit.study_guide ?? [];
  const slides = listSlides(unit);

  if (guides.length === 0) {
    return pickSlideAnchors(unit, count).map((s) => ({ kind: 'slide' as const, ...s }));
  }

  let guideCount = Math.max(0, Math.min(count, Math.round(count * STUDY_GUIDE_RATIO)));
  if (slides.length === 0) guideCount = count; // nothing to anchor the remainder
  if (guideCount === 0 && count > 0) guideCount = 1; // always lean on the guide
  const slideCount = count - guideCount;

  const shuffledGuides = shuffle(guides);
  const guideAnchors: Anchor[] = Array.from({ length: guideCount }, (_, i) => ({
    kind: 'guide' as const,
    text: shuffledGuides[i % shuffledGuides.length]!,
  }));

  const slideAnchors: Anchor[] = pickSlideAnchors(unit, slideCount).map((s) => ({
    kind: 'slide' as const,
    ...s,
  }));

  // Interleave so the batch isn't "all guide questions, then all slide".
  return shuffle([...guideAnchors, ...slideAnchors]);
}

function anchorBlock(anchors: Anchor[]): string {
  if (anchors.length === 0) return '';
  const lines = anchors.map((a, i) =>
    a.kind === 'guide'
      ? `- Question ${i + 1} must address this study-guide prompt: "${a.text}"`
      : `- Question ${i + 1} must be anchored in slide ${a.no} ("${a.title}")`
  );
  return (
    `\n\nANCHOR ASSIGNMENT — each question MUST be grounded in the item listed below. This is the primary alignment-and-diversity mechanism; do not deviate from these anchors:\n` +
    `Study-guide prompts are the instructor's own open-ended study questions. Turn each into ONE focused, objective question of the requested type — extract a specific, gradable point from it; do NOT ask the broad prompt verbatim. Slide-anchored questions roam the wider unit for breadth.\n` +
    lines.join('\n') +
    `\n\nFor each question, ground the stem, the correct answer, and (where applicable) the distractors in that specific item. You may use related context from the unit only where it supports the assigned anchor.\n`
  );
}

async function callGenerator(
  unit: UnitContent,
  userPrompt: string,
  attribution: Attribution,
  retryOnBadShape: boolean = true
): Promise<unknown> {
  const client = getAnthropic();
  const t0 = Date.now();
  const res = await client.messages.create({
    model: GEN_MODEL,
    // 16K leaves comfortable headroom for ~20 MC questions or ~30 TF/FITB.
    // Previously 4K which truncated JSON for larger counts.
    max_tokens: 16384,
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
  void recordApiCall({
    ...attribution,
    model: GEN_MODEL,
    usage: res.usage,
    durationMs: Date.now() - t0,
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
    const t1 = Date.now();
    const retry = await client.messages.create({
      model: GEN_MODEL,
      max_tokens: 16384,
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
    void recordApiCall({
      ...attribution,
      endpoint: attribution.endpoint + '.retry',
      model: GEN_MODEL,
      usage: retry.usage,
      durationMs: Date.now() - t1,
    });
    const retryText = retry.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    return JSON.parse(stripCodeFences(retryText));
  }
}

/**
 * The generator puts correct answers overwhelmingly at A/B (instructor feedback
 * Aug 11: one unit's bank had 29/30 at "A"). Shuffle every question's options
 * and remap the "(A)"…"(E)" letter references inside the explanation to match.
 */
export function shuffleMcOptions(q: McQuestion): McQuestion {
  const n = q.options.length;
  const order = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  // order[newPos] = oldIdx → invert for letter remapping
  const oldToNew = new Map<number, number>();
  order.forEach((old, newPos) => oldToNew.set(old, newPos));
  const explanation = q.explanation
    .replace(/\(([A-E])\)/g, (_, l: string) => `(\u0000${oldToNew.get(l.charCodeAt(0) - 65)}\u0000)`)
    .replace(/\u0000(\d)\u0000/g, (_, d: string) => String.fromCharCode(65 + parseInt(d, 10)));
  return {
    ...q,
    options: order.map((old) => q.options[old]!),
    correct_index: oldToNew.get(q.correct_index)!,
    explanation,
  };
}

export async function generateMC(
  unitNo: number,
  count: number,
  difficulty: Difficulty,
  attribution: Attribution = { endpoint: 'quiz.generate.mc' }
): Promise<McQuestion[]> {
  const unit = getUnit(unitNo);
  const recent = await fetchRecentStems(attribution.studentId, unitNo, 'mc');
  const anchors = buildAnchors(unit, count);
  const raw = await callGenerator(
    unit,
    MC_USER(count, difficulty) + anchorBlock(anchors) + avoidBlock(recent),
    { ...attribution, endpoint: 'quiz.generate.mc' }
  );
  const parsed = z.array(McQuestion).parse(raw);
  return parsed.slice(0, count).map(shuffleMcOptions);
}

export async function generateTF(
  unitNo: number,
  count: number,
  difficulty: Difficulty,
  attribution: Attribution = { endpoint: 'quiz.generate.tf' }
): Promise<TfQuestion[]> {
  const unit = getUnit(unitNo);
  const recent = await fetchRecentStems(attribution.studentId, unitNo, 'tf');
  const anchors = buildAnchors(unit, count);
  const raw = await callGenerator(
    unit,
    TF_USER(count, difficulty) + anchorBlock(anchors) + avoidBlock(recent),
    { ...attribution, endpoint: 'quiz.generate.tf' }
  );
  const parsed = z.array(TfQuestion).parse(raw);
  return parsed.slice(0, count);
}

// ─── FR rubric/question alignment (post-generation safety pass) ──────────────

/**
 * A second, independent pass that audits a generated FR question for
 * rubric/question alignment: every rubric criterion must be something the
 * prompt EXPLICITLY asks the student to do. The generation prompt already
 * enforces this, but a smaller model can still let one slip through; this is
 * the belt-and-suspenders check the instructor asked for. It either revises
 * the prompt to ask for a stray criterion, or drops that criterion.
 */
const FrAlignment = z.object({
  changed: z.boolean(),
  revised_prompt: z.string().min(10),
  rubric: z.array(FrRubricItem).min(1),
});

const FR_ALIGN_SYSTEM = `You audit ONE free-response exam question for alignment between its rubric and its prompt. The question is well-formed only if a student, reading ONLY the prompt, can tell that each thing the rubric scores is required of them.

Check each rubric criterion: does the prompt EXPLICITLY ask the student to produce that point?
- If EVERY criterion is already asked → return the prompt and rubric unchanged with "changed": false.
- If a criterion is NOT asked → fix it the least invasive way and set "changed": true:
  • PREFERRED: minimally revise the prompt wording so it explicitly asks for that point (e.g. append "…and state which of the two reaches threshold first"). Keep the rubric item.
  • ONLY IF the point does not belong in this question at all: drop that criterion from the rubric.

Hard rules:
- Do NOT invent new rubric criteria, and do NOT change the wording or point value of any criterion that is already aligned.
- Do NOT change a criterion's points. If you drop one, just omit it — the server recomputes the total.
- Preserve the order and exact text of every kept criterion.
- Keep the prompt's topic and difficulty; only add the missing explicit ask(s).

Output STRICTLY valid JSON — no markdown, no preamble:
{ "changed": true|false, "revised_prompt": "<the prompt to use>", "rubric": [ { "points": <int>, "criterion": "<text>" } ] }`;

const FR_ALIGN_USER = (q: FrQuestion) => `Question prompt:
${q.prompt}

Rubric (numbered):
${q.rubric.map((r, i) => `  ${i + 1}. (${r.points} mark${r.points === 1 ? '' : 's'}) ${r.criterion}`).join('\n')}

Audit for alignment and return the corrected JSON.`;

/**
 * Runs the alignment pass on one question. On ANY failure (API error, bad
 * JSON, or a degenerate result) it returns the original question unchanged —
 * this is a safety net and must never break FR generation.
 */
async function alignFrQuestion(q: FrQuestion, attribution: Attribution): Promise<FrQuestion> {
  try {
    const client = getAnthropic();
    const t0 = Date.now();
    const res = await client.messages.create({
      model: GEN_MODEL,
      max_tokens: 2048,
      // No unit grounding needed — this is a self-contained logical check of
      // "does the prompt ask for what the rubric scores?".
      system: FR_ALIGN_SYSTEM,
      messages: [{ role: 'user', content: FR_ALIGN_USER(q) }],
    });
    void recordApiCall({
      ...attribution,
      endpoint: 'quiz.generate.fr.align',
      model: GEN_MODEL,
      usage: res.usage,
      durationMs: Date.now() - t0,
    });
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    const a = FrAlignment.parse(JSON.parse(stripCodeFences(text)));
    if (!a.changed) return q;

    const total = a.rubric.reduce((acc, r) => acc + r.points, 0);
    // Reject a degenerate rewrite (e.g. everything dropped) — keep the original,
    // which the generation prompt already aligned, rather than ship a stub.
    if (a.rubric.length < 2 || total < 3 || total > 8) return q;

    return { ...q, prompt: a.revised_prompt, rubric: a.rubric, total_marks: total };
  } catch (e) {
    console.warn('quiz: FR alignment pass failed, keeping original question:', (e as Error).message);
    return q;
  }
}

export async function generateFR(
  unitNo: number,
  count: number,
  difficulty: Difficulty,
  attribution: Attribution = { endpoint: 'quiz.generate.fr' }
): Promise<FrQuestion[]> {
  const unit = getUnit(unitNo);
  // FR uses 'prompt' field for the stem, not 'stem'. Note: existing FR rows
  // in quiz_attempt store the full FrQuestion shape, so we look up prompt.
  const recent = await fetchRecentFrPrompts(attribution.studentId, unitNo);
  const anchors = buildAnchors(unit, count);
  const raw = await callGenerator(
    unit,
    FR_USER(count, difficulty) + anchorBlock(anchors) + avoidBlock(recent),
    { ...attribution, endpoint: 'quiz.generate.fr' }
  );
  const parsed = z.array(FrQuestion).parse(raw);
  // Enforce rubric-points-sum-to-total-marks (LLMs sometimes drift).
  for (const q of parsed) {
    const sum = q.rubric.reduce((acc, r) => acc + r.points, 0);
    if (sum !== q.total_marks) {
      // Trust the rubric, override total_marks to match.
      q.total_marks = sum;
    }
  }
  // Second pass: verify each rubric only scores what the prompt asks. Runs in
  // parallel so it adds ~one call of latency, not one per question.
  const aligned = await Promise.all(parsed.map((q) => alignFrQuestion(q, attribution)));
  return aligned.slice(0, count);
}

export async function generateFITB(
  unitNo: number,
  count: number,
  difficulty: Difficulty,
  attribution: Attribution = { endpoint: 'quiz.generate.fitb' }
): Promise<FitbQuestion[]> {
  const unit = getUnit(unitNo);
  if (unit.terms.length === 0) {
    throw new Error(`Unit ${unitNo} has no terms list; cannot generate FITB.`);
  }
  const recent = await fetchRecentStems(attribution.studentId, unitNo, 'fitb');
  const anchors = buildAnchors(unit, count);
  const raw = await callGenerator(
    unit,
    FITB_USER(count, difficulty, unit.terms) + anchorBlock(anchors) + avoidBlock(recent),
    { ...attribution, endpoint: 'quiz.generate.fitb' }
  );
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

/**
 * Internal schema for the LLM's grading response. The model only judges per
 * rubric index — the server reconstructs the full per_criterion list using
 * the rubric's own text and point values. This eliminates failure modes
 * where the model produced duplicate placeholder entries to pad the array.
 */
// LENIENT ON PURPOSE — this validates raw LLM output. Smaller models (Haiku)
// intermittently omit a field or return it empty; a strict schema turns that
// into a thrown parse error that surfaces to the student as "Submit failed".
// Every field therefore has a safe default so an omission degrades the grade
// slightly rather than failing the whole submission. Missing/garbled entries
// simply don't match a rubric index and reconcile fills a "missing" row.
const FrLlmCriterionJudgment = z.object({
  // Off-by-one, out-of-range, or a defaulted -1 just means reconcile won't
  // match it, and the rubric item gets a default "missing" row.
  rubric_index: z.number().int().default(-1),
  // Half-marks allowed (multiples of 0.5); reconcile snaps to the nearest 0.5.
  awarded: z.number().min(0).default(0),
  coverage: z.enum(['full', 'partial', 'missing']).default('missing'),
  rationale: z.string().default(''),
});

const FrLlmGrade = z.object({
  per_criterion: z.array(FrLlmCriterionJudgment).default([]),
  strong: z.string().default(''),
  missing: z.string().default(''),
  not_needed: z.string().default(''),
});

const FR_GRADER_SYSTEM = `You are an experienced TA grading free-response answers for an undergraduate Human Anatomy & Physiology course (BIOL 1592). You grade strictly against the provided rubric — not against your own impression of completeness.

How the rubric works in your output:
- Each rubric item is numbered (1, 2, 3, …) in the user prompt.
- For each rubric item, return ONE judgment entry referring to it by "rubric_index" (1-based, matching the numbering in the prompt).
- Do NOT include the rubric text itself in your judgment — only the index. The server has the rubric text and will fill it in.
- Do NOT return more entries than the rubric has items. Do NOT return placeholder or duplicate entries — if you can't make a judgment about a rubric item, return it with coverage "missing" and a rationale that says so.
- It's fine (and expected) to omit a rubric item if the student clearly didn't address it AND you have nothing else to say — the server will fill in a default "not addressed" entry. But it's better to include it explicitly when you have something specific to note.

Grading philosophy — grade GENEROUSLY. This is formative practice, not a final exam. Reward demonstrated understanding over exact wording. When in doubt, give the student the mark.

Grading rules:
1. Award points for any criterion the student's response addresses in substance. Do NOT require the student's phrasing to match the rubric's or the model answer's — credit equivalent wording, partial wording, and correct ideas expressed simply.
2. CREDIT IMPLIED CONTENT. If what the student wrote logically entails the required point, award the marks — do not dock them for not spelling out what their answer already implies. (E.g. "currents converge" implies the inputs originate at different locations; "builds over time" implies accumulation before decay.) Read for understanding, not for keywords.
3. For each rubric item you judge, choose coverage and award marks (half-marks allowed — use multiples of 0.5):
   - "full"    = the student conveyed the core idea, even if briefly, informally, or with a minor omission. Award the FULL points. Do not withhold full marks just because a textbook detail is absent if the main idea is clearly there.
   - "partial" = the student showed some real understanding but missed a meaningful part. Award AT LEAST HALF the criterion's marks (e.g. 0.5 of 1, 1 of 2, 1.5 of 3), and more when they are most of the way there. Never give 0 to an answer that shows partial understanding.
   - "missing" = the student genuinely did not address the criterion, OR what they wrote about it is incorrect. Only this earns 0.
4. When you are unsure between two coverage levels, choose the MORE GENEROUS one (full over partial, partial over missing).
4b. GRADE THE PROMPT, NOT THE RUBRIC'S EXTRA WORDS. If a rubric criterion contains a qualifier or detail the question prompt never asked the student for (e.g. the rubric says "the MAIN excitatory neurotransmitter" but the prompt only asked for the function, or the rubric names a location the prompt didn't request), award full marks when the student got right what the prompt actually asked. Never deduct for a word or detail the student had no way of knowing was required.
5. The rationale must quote or paraphrase specific phrases from the student's response when awarding points, and name what was missing when not awarding.
6. "Missing" describes content the RUBRIC required but the student did not provide. Do NOT use it to introduce concepts the rubric never asked for, even if you think they're relevant. Empty string if all rubric items were addressed.
7. "Not_needed" is ONLY for content that is factually wrong OR genuinely off-topic in a way that suggests the student misread the question. Do NOT flag biology that is correct and adjacent — students often raise related material as part of thinking through a problem, and that's not a problem. Empty string in the common case.
8. "Strong" names 1–2 things the student clearly nailed, drawn from the student's actual words. Empty string if nothing rose to that bar.
9. Be encouraging but factual. The student will read this.

Output STRICTLY valid JSON. No markdown, no preamble.`;

const FR_GRADER_USER = (q: FrQuestion, response: string) => `Question (worth ${q.total_marks} marks):
${q.prompt}

Rubric (numbered for your reference — refer to each item by its number in your "rubric_index" field):
${q.rubric.map((r, i) => `  ${i + 1}. (${r.points} mark${r.points === 1 ? '' : 's'}) ${r.criterion}`).join('\n')}

Model answer (for reference — do NOT show this in your output):
${q.model_answer}

Student's response:
"""
${response}
"""

Grade this response. Output JSON in this shape:
{
  "per_criterion": [
    { "rubric_index": 1, "awarded": <number, may be a multiple of 0.5 — e.g. 0.5, 1, 1.5>, "coverage": "full"|"partial"|"missing", "rationale": "<one sentence>" }
  ],
  "strong": "<1-sentence summary, or empty string>",
  "missing": "<1-2 sentences on what the rubric required but was absent, or empty string>",
  "not_needed": "<only for factually wrong or genuinely off-topic content; empty string otherwise>"
}`;

export async function gradeFR(
  unit: UnitContent,
  question: FrQuestion,
  response: string,
  attribution: Attribution = { endpoint: 'quiz.grade.fr' }
): Promise<FrGrade> {
  const client = getAnthropic();

  // Run one grading call and return the model's raw text. Records cost.
  async function callGrader(messages: Anthropic.MessageParam[]): Promise<string> {
    const t0 = Date.now();
    const res = await client.messages.create({
      model: GRADER_MODEL, // GRADER_MODEL (default Haiku); raise via env if grading quality drops
      max_tokens: 2048,
      system: [
        { type: 'text', text: FR_GRADER_SYSTEM },
        {
          type: 'text',
          text: unitGrounding(unit),
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages,
    });
    void recordApiCall({
      ...attribution,
      endpoint: 'quiz.grade.fr',
      model: GRADER_MODEL,
      usage: res.usage,
      durationMs: Date.now() - t0,
    });
    return res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
  }

  const baseMessages: Anthropic.MessageParam[] = [
    { role: 'user', content: FR_GRADER_USER(question, response) },
  ];

  // Parse the grade, retrying once on malformed JSON. A student's submission
  // must not fail just because the model returned bad JSON on the first pass
  // (more likely on Haiku). Field-level omissions are already absorbed by the
  // lenient FrLlmGrade defaults; this handles the invalid-JSON case.
  let llm: z.infer<typeof FrLlmGrade>;
  const firstText = await callGrader(baseMessages);
  try {
    llm = FrLlmGrade.parse(JSON.parse(stripCodeFences(firstText)));
  } catch {
    const retryText = await callGrader([
      ...baseMessages,
      { role: 'assistant', content: firstText },
      {
        role: 'user',
        content:
          'Your previous response was not valid JSON in the required shape. Return ONLY the JSON object — no other text, no code fences.',
      },
    ]);
    llm = FrLlmGrade.parse(JSON.parse(stripCodeFences(retryText)));
  }

  // Reconcile: walk the rubric in order. For each item, find the LLM's
  // judgment (first match wins; duplicates are silently dropped). Items the
  // LLM didn't address get filled in as "missing/0" so the displayed grade
  // always shows one row per rubric item — no duplicates, no placeholders.
  const seenIndices = new Set<number>();
  const per_criterion: FrCriterionGrade[] = question.rubric.map((rubricItem, i) => {
    const idx = i + 1;
    const judgment = llm.per_criterion.find(
      (j) => j.rubric_index === idx && !seenIndices.has(idx)
    );
    if (judgment) {
      seenIndices.add(idx);
      // Snap to the nearest half-mark, then clamp into [0, max_points].
      const snapped = Math.round(judgment.awarded * 2) / 2;
      const awarded = Math.max(0, Math.min(rubricItem.points, snapped));
      return {
        criterion: rubricItem.criterion,
        max_points: rubricItem.points,
        awarded,
        coverage: judgment.coverage,
        // FrCriterionGrade.rationale is min(1); a lenient/empty LLM rationale
        // would fail the final FrGrade.parse, so fall back to a placeholder.
        rationale: judgment.rationale.trim() || 'No rationale provided by the grader.',
      };
    }
    return {
      criterion: rubricItem.criterion,
      max_points: rubricItem.points,
      awarded: 0,
      coverage: 'missing' as const,
      rationale: 'The grader did not assess this criterion in the student response.',
    };
  });

  const total_awarded = per_criterion.reduce((a, c) => a + c.awarded, 0);
  const total_possible = question.rubric.reduce((a, r) => a + r.points, 0);

  return FrGrade.parse({
    total_awarded,
    total_possible,
    per_criterion,
    strong: llm.strong,
    missing: llm.missing,
    not_needed: llm.not_needed,
  });
}

