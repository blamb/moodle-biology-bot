/**
 * "Coaching" layer — LLM-generated qualitative feedback on quiz performance.
 *
 *   synthesizeQuiz()  – one paragraph naming concept patterns across a whole quiz
 *   explainAttempt()  – richer plain-English walkthrough of a single question
 *
 * Both share the per-unit grounding (prompt-cached) but use different system
 * prompts and produce different output styles.
 */

import type Anthropic from '@anthropic-ai/sdk';
import { getAnthropic, GEN_MODEL } from './anthropic.js';
import { getUnit, type UnitContent } from './content.js';
import { recordApiCall, type Attribution } from './costs.js';
import type {
  Difficulty,
  QuizKind,
  McQuestion,
  TfQuestion,
  FitbQuestion,
  FrQuestion,
  FrGrade,
} from './quiz.js';

export interface AttemptForCoaching {
  kind: QuizKind;
  question: McQuestion | TfQuestion | FitbQuestion | FrQuestion;
  response: unknown;
  correct: boolean;
  // FR-only:
  grade?: FrGrade;
  score_pct?: number;
}

function unitGrounding(unit: UnitContent): string {
  const parts = [
    `# UNIT ${unit.unit_no}: ${unit.ppt_title}`,
    `\n## Key terms`,
    unit.terms.length ? unit.terms.map((t) => `- ${t}`).join('\n') : '(no terms list)',
    `\n## Lecture slides (PPT + speaker notes)`,
    unit.ppt_markdown,
  ];
  if (unit.textbook) {
    parts.push(
      `\n## Open textbook chapter (Pressbooks A&P I)`,
      `Source: ${unit.textbook.url}`,
      unit.textbook.markdown
    );
  }
  return parts.join('\n');
}

function describeAttempt(a: AttemptForCoaching, idx: number): string {
  const prefix = `[Q${idx + 1}] ${a.correct ? '✓' : '✗'} `;
  if (a.kind === 'mc') {
    const q = a.question as McQuestion;
    const chosen = Number(a.response);
    // Pass ALL options so the explainer doesn't hallucinate distractor text.
    // Each option is labeled with whether it's correct and/or what the student chose.
    const optionsList = q.options
      .map((opt, i) => {
        const labels: string[] = [];
        if (i === q.correct_index) labels.push('← CORRECT');
        if (Number.isInteger(chosen) && i === chosen && i !== q.correct_index) labels.push('← student chose');
        return `     (${String.fromCharCode(65 + i)}) ${opt}${labels.length ? '  ' + labels.join(' ') : ''}`;
      })
      .join('\n');
    return (
      `${prefix}MC: ${q.stem}\n` +
      `   Options (these are the EXACT five options the student saw — do not invent or substitute):\n${optionsList}\n`
    );
  }
  if (a.kind === 'tf') {
    const q = a.question as TfQuestion;
    const studentBool = a.response === true || a.response === 'true';
    return (
      `${prefix}TF: "${q.stem}"  Correct: ${q.correct ? 'TRUE' : 'FALSE'}` +
      (!a.correct ? `  Student: ${studentBool ? 'TRUE' : 'FALSE'}` : '') +
      '\n'
    );
  }
  if (a.kind === 'fitb') {
    const q = a.question as FitbQuestion;
    const studentText = String(a.response ?? '');
    return (
      `${prefix}FITB: ${q.stem}\n` +
      `   Correct answer: "${q.answer}"` +
      (!a.correct ? `   Student wrote: "${studentText}"` : '') +
      '\n'
    );
  }
  // FR
  const q = a.question as FrQuestion;
  const grade = a.grade;
  const studentText = String(a.response ?? '');
  let body = `${prefix}FR (${grade?.total_awarded ?? '?'}/${grade?.total_possible ?? q.total_marks} marks): ${q.prompt}\n`;
  body += `   Student wrote: ${studentText.length > 300 ? studentText.slice(0, 297) + '…' : studentText}\n`;
  if (grade) {
    body += `   Strong: ${grade.strong || '(none noted)'}\n`;
    body += `   Missing: ${grade.missing || '(none noted)'}\n`;
    if (grade.not_needed) body += `   Off-topic content: ${grade.not_needed}\n`;
  }
  return body;
}

// ─── Synthesize whole-quiz patterns ─────────────────────────────────────────

const SYNTHESIS_SYSTEM = `You write a short study guidance paragraph for an undergraduate Human Anatomy & Physiology student who just finished a practice quiz.

Rules:
- 2–4 sentences. Plain English. Warm and concrete.
- Focus on CONCEPT patterns ("you're solid on neurotransmitter receptor types but slipping on signal propagation timing"), not question numbers or generic praise.
- If the student aced everything, name what they've consolidated and suggest one direction to push further into.
- If they struggled, name the one or two specific concepts that need a re-read or a tutor pass.
- End with one actionable next step framed around a concept, e.g. "Re-read the section on negative feedback loops" or "Revisit how tonicity drives osmosis" — name the topic, not a location.
- Do NOT cite slide numbers or point to specific slides (e.g. "Unit 8, slide 12"). Students may be using a different version of the deck, so slide numbers can mislead. Point them to concepts, not source locations.
- Do NOT just restate the score. Do NOT list every wrong question — synthesize.`;

export async function synthesizeQuiz(
  unitNo: number,
  kind: QuizKind,
  difficulty: Difficulty,
  attempts: AttemptForCoaching[],
  attribution: Attribution = { endpoint: 'coach.synthesize' }
): Promise<string> {
  if (attempts.length === 0) return '';
  const unit = getUnit(unitNo);
  const body = attempts.map((a, i) => describeAttempt(a, i)).join('\n');
  const total = attempts.length;
  const correct = attempts.filter((a) => a.correct).length;
  const summary = kind === 'fr'
    ? `Free-response quiz, ${total} question(s) at ${difficulty} difficulty. ` +
      `Average score: ${Math.round(attempts.reduce((s, a) => s + (a.score_pct ?? 0), 0) / total)}%.`
    : `${kind.toUpperCase()} quiz, ${total} questions at ${difficulty} difficulty. ` +
      `Score: ${correct}/${total} (${Math.round((correct / total) * 100)}%).`;

  const client = getAnthropic();
  const t0 = Date.now();
  const res = await client.messages.create({
    model: GEN_MODEL,
    max_tokens: 384,
    system: [
      { type: 'text', text: SYNTHESIS_SYSTEM },
      { type: 'text', text: unitGrounding(unit), cache_control: { type: 'ephemeral' } },
    ],
    messages: [
      {
        role: 'user',
        content: `${summary}\n\nPer-question results:\n${body}\n\nWrite the study guidance paragraph now.`,
      },
    ],
  });
  void recordApiCall({
    ...attribution,
    endpoint: 'coach.synthesize',
    model: GEN_MODEL,
    usage: res.usage,
    durationMs: Date.now() - t0,
  });
  return res.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

// ─── Explain a single attempt in depth ──────────────────────────────────────

const EXPLAIN_SYSTEM = `You give a tight plain-English walkthrough of a practice question for an undergraduate Human Anatomy & Physiology student.

Rules:
- 3–5 sentences total. One paragraph. Be terse.
- Walk through WHY the correct answer is correct, in plain English. Anchor in the unit content.
- CRITICAL — option fidelity for multiple-choice questions:
  • Only discuss the EXACT five options listed in the prompt under "Options:". Each option label (A, B, C, D, E) MUST refer to the literal text shown there.
  • Do NOT invent, substitute, or imagine alternative distractors. If you say "option B confuses X with Y", option B must actually mention X or Y.
  • If you discuss why a wrong option is wrong, paraphrase or quote the actual option text shown in the prompt.
  • You may skip a distractor if there's nothing useful to say, but do NOT replace it with a fabricated alternative.
- For free response: name the rubric criteria the student met and missed in concrete terms.
- Do NOT cite slide numbers or point to specific slides (e.g. "Unit 17, slide 44"). Students may be using a different version of the deck, so slide numbers can mislead. Explain the concept directly instead, without any source-location citation.
- Do NOT repeat content the student already saw in the short explanation. Add something new (a mechanism, a comparison, a memory hook).
- Do NOT lecture beyond what the question tests. No "great question!" filler.`;

export async function explainAttempt(
  unitNo: number,
  attempt: AttemptForCoaching,
  attribution: Attribution = { endpoint: 'coach.explain' }
): Promise<string> {
  const unit = getUnit(unitNo);
  const description = describeAttempt(attempt, 0);

  const client = getAnthropic();
  const t0 = Date.now();
  const res = await client.messages.create({
    model: GEN_MODEL,
    max_tokens: 400,
    system: [
      { type: 'text', text: EXPLAIN_SYSTEM },
      { type: 'text', text: unitGrounding(unit), cache_control: { type: 'ephemeral' } },
    ],
    messages: [
      {
        role: 'user',
        content: `Question and result:\n${description}\nWrite the richer walkthrough.`,
      },
    ],
  });
  void recordApiCall({
    ...attribution,
    endpoint: 'coach.explain',
    model: GEN_MODEL,
    usage: res.usage,
    durationMs: Date.now() - t0,
  });
  return res.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}
