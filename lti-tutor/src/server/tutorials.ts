/**
 * Paski-style tutorials.
 *
 * The pattern (Next Gen Learning's "Paski"): the instructor co-designs each
 * one-on-one tutorial to mirror how they'd guide it with their best teaching
 * assistant; the tutorial sits in the core learning sequence (lecture →
 * tutorial → group debrief) rather than on the periphery; the tutor knows the
 * student's goals and context; and every run feeds a debrief back to faculty.
 *
 * This module owns:
 *   - course materials (instructor-pasted lecture notes, transcripts, readings)
 *   - tutorial briefs (CRUD, scoped to one course)
 *   - student profiles
 *   - the tutorial conversation: a staged Socratic dialogue (orient → explore →
 *     teach-back → wrap-up), grounded in the attached materials, streamed
 *   - completion: an LLM-written structured summary per run
 *   - the instructor's report and group-debrief synthesis
 *   - "draft with AI": a first-pass brief the instructor edits
 *   - personalised lecture debriefs for students, one per material
 */

import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { query } from './db.js';
import { getAnthropic, GEN_MODEL, TUTOR_MODEL } from './anthropic.js';
import { recordApiCall, type Attribution } from './costs.js';
import type { Student } from './students.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CourseCtx {
  iss: string;
  contextId: string;
  /** Course title from the LTI launch, for prompts. */
  title?: string;
}

export interface Material {
  id: number;
  lti_iss: string;
  lti_context_id: string;
  title: string;
  body: string;
  created_by: number | null;
  created_at: string;
  updated_at: string;
}

export type TutorialStatus = 'draft' | 'published' | 'archived';

export interface Tutorial {
  id: number;
  lti_iss: string;
  lti_context_id: string;
  title: string;
  learning_goal: string;
  opening_question: string;
  ta_brief: string;
  misconceptions: string;
  success_criteria: string;
  material_ids: number[];
  target_minutes: number;
  gradebook: boolean;
  status: TutorialStatus;
  created_by: number | null;
  created_at: string;
  updated_at: string;
}

export interface StudentProfile {
  student_id: number;
  program: string;
  goal: string;
  background: string;
  struggles: string;
  interests: string;
  updated_at: string;
}

export const TutorialSummary = z.object({
  mastery: z.enum(['solid', 'developing', 'needs_work']),
  understood: z.array(z.string()).max(6),
  sticking_points: z.array(z.string()).max(6),
  teachback: z.string(),
  next_step: z.string(),
  student_note: z.string(),
});
export type TutorialSummary = z.infer<typeof TutorialSummary> & { turns?: number };

export interface TutorialSession {
  id: number;
  tutorial_id: number;
  student_id: number;
  session_id: number;
  status: 'in_progress' | 'completed';
  started_at: string;
  completed_at: string | null;
  summary: TutorialSummary | null;
  nps_score: number | null;
  nps_comment: string | null;
  grade_posted_at: string | null;
  grade_error: string | null;
}

interface Turn {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  ts: string;
}

/** Hidden user turn that opens a tutorial (the API needs a user turn first). */
export const START_MARKER = '[Tutorial start]';

// ─── Validation ─────────────────────────────────────────────────────────────

/** Per-material and per-tutorial grounding caps (characters; ~4 chars/token). */
export const MATERIAL_MAX_CHARS = 200_000;
export const GROUNDING_MAX_CHARS = 400_000;

export const MaterialInput = z.object({
  title: z.string().trim().min(1).max(160),
  body: z.string().trim().min(1).max(MATERIAL_MAX_CHARS),
});
export type MaterialInput = z.infer<typeof MaterialInput>;

export const TutorialInput = z.object({
  title: z.string().trim().min(1).max(160),
  learning_goal: z.string().trim().min(1).max(2000),
  opening_question: z.string().trim().min(1).max(2000),
  ta_brief: z.string().trim().max(8000).default(''),
  misconceptions: z.string().trim().max(4000).default(''),
  success_criteria: z.string().trim().max(4000).default(''),
  material_ids: z.array(z.number().int().positive()).max(20).default([]),
  target_minutes: z.number().int().min(5).max(60).default(15),
  gradebook: z.boolean().default(false),
  status: z.enum(['draft', 'published', 'archived']).default('draft'),
});
export type TutorialInput = z.infer<typeof TutorialInput>;

export const ProfileInput = z.object({
  program: z.string().trim().max(200).default(''),
  goal: z.string().trim().max(500).default(''),
  background: z.string().trim().max(500).default(''),
  struggles: z.string().trim().max(500).default(''),
  interests: z.string().trim().max(300).default(''),
});
export type ProfileInput = z.infer<typeof ProfileInput>;

// ─── Materials ──────────────────────────────────────────────────────────────

export async function listMaterials(ctx: CourseCtx): Promise<Material[]> {
  return query<Material>(
    `select * from material where lti_iss = $1 and lti_context_id = $2 order by created_at`,
    [ctx.iss, ctx.contextId]
  );
}

export async function getMaterials(ids: number[], ctx: CourseCtx): Promise<Material[]> {
  if (ids.length === 0) return [];
  const rows = await query<Material>(
    `select * from material where id = any($1::bigint[]) and lti_iss = $2 and lti_context_id = $3`,
    [ids, ctx.iss, ctx.contextId]
  );
  // Preserve the tutorial's ordering.
  const byId = new Map(rows.map((m) => [m.id, m]));
  return ids.map((id) => byId.get(id)).filter((m): m is Material => !!m);
}

export async function createMaterial(ctx: CourseCtx, input: MaterialInput, createdBy: number): Promise<Material> {
  const rows = await query<Material>(
    `insert into material (lti_iss, lti_context_id, title, body, created_by)
     values ($1,$2,$3,$4,$5) returning *`,
    [ctx.iss, ctx.contextId, input.title, input.body, createdBy]
  );
  return rows[0]!;
}

export async function updateMaterial(id: number, ctx: CourseCtx, input: MaterialInput): Promise<Material | null> {
  const rows = await query<Material>(
    `update material set title = $4, body = $5, updated_at = now()
     where id = $1 and lti_iss = $2 and lti_context_id = $3 returning *`,
    [id, ctx.iss, ctx.contextId, input.title, input.body]
  );
  return rows[0] ?? null;
}

export async function deleteMaterial(id: number, ctx: CourseCtx): Promise<boolean> {
  const rows = await query<{ id: number }>(
    `delete from material where id = $1 and lti_iss = $2 and lti_context_id = $3 returning id`,
    [id, ctx.iss, ctx.contextId]
  );
  if (rows.length) {
    await query(
      `update tutorial set material_ids = array_remove(material_ids, $1::bigint)
       where lti_iss = $2 and lti_context_id = $3 and $1 = any(material_ids)`,
      [id, ctx.iss, ctx.contextId]
    );
  }
  return rows.length > 0;
}

function materialsBlock(materials: Material[]): string | null {
  if (materials.length === 0) return null;
  let total = 0;
  const parts = ['# COURSE MATERIALS (provided by the instructor)'];
  for (const m of materials) {
    const body = total + m.body.length > GROUNDING_MAX_CHARS
      ? m.body.slice(0, Math.max(0, GROUNDING_MAX_CHARS - total)) + '\n[…truncated: grounding limit reached]'
      : m.body;
    total += body.length;
    parts.push(`\n## ${m.title}\n${body}`);
    if (total >= GROUNDING_MAX_CHARS) break;
  }
  return parts.join('\n');
}

// ─── Tutorial CRUD ──────────────────────────────────────────────────────────

export async function listTutorials(ctx: CourseCtx, opts: { publishedOnly: boolean }): Promise<Tutorial[]> {
  return query<Tutorial>(
    `select * from tutorial
     where lti_iss = $1 and lti_context_id = $2
       ${opts.publishedOnly ? "and status = 'published'" : "and status <> 'archived'"}
     order by created_at`,
    [ctx.iss, ctx.contextId]
  );
}

export async function getTutorial(id: number, ctx: CourseCtx): Promise<Tutorial | null> {
  const rows = await query<Tutorial>(
    `select * from tutorial where id = $1 and lti_iss = $2 and lti_context_id = $3`,
    [id, ctx.iss, ctx.contextId]
  );
  return rows[0] ?? null;
}

/** Drop material ids that don't belong to this course. */
async function validMaterialIds(ids: number[], ctx: CourseCtx): Promise<number[]> {
  const found = await getMaterials(ids, ctx);
  return found.map((m) => m.id);
}

export async function createTutorial(ctx: CourseCtx, input: TutorialInput, createdBy: number): Promise<Tutorial> {
  const materialIds = await validMaterialIds(input.material_ids, ctx);
  const rows = await query<Tutorial>(
    `insert into tutorial
       (lti_iss, lti_context_id, title, learning_goal, opening_question, ta_brief, misconceptions,
        success_criteria, material_ids, target_minutes, gradebook, status, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9::bigint[],$10,$11,$12,$13) returning *`,
    [
      ctx.iss, ctx.contextId, input.title, input.learning_goal, input.opening_question,
      input.ta_brief, input.misconceptions, input.success_criteria, materialIds,
      input.target_minutes, input.gradebook, input.status, createdBy,
    ]
  );
  return rows[0]!;
}

export async function updateTutorial(id: number, ctx: CourseCtx, input: TutorialInput): Promise<Tutorial | null> {
  const materialIds = await validMaterialIds(input.material_ids, ctx);
  const rows = await query<Tutorial>(
    `update tutorial set
       title = $4, learning_goal = $5, opening_question = $6, ta_brief = $7, misconceptions = $8,
       success_criteria = $9, material_ids = $10::bigint[], target_minutes = $11, gradebook = $12,
       status = $13, updated_at = now()
     where id = $1 and lti_iss = $2 and lti_context_id = $3 returning *`,
    [
      id, ctx.iss, ctx.contextId, input.title, input.learning_goal, input.opening_question,
      input.ta_brief, input.misconceptions, input.success_criteria, materialIds,
      input.target_minutes, input.gradebook, input.status,
    ]
  );
  return rows[0] ?? null;
}

export async function deleteTutorial(id: number, ctx: CourseCtx): Promise<boolean> {
  const rows = await query<{ id: number }>(
    `delete from tutorial where id = $1 and lti_iss = $2 and lti_context_id = $3 returning id`,
    [id, ctx.iss, ctx.contextId]
  );
  return rows.length > 0;
}

// ─── Student profile ────────────────────────────────────────────────────────

export async function getProfile(studentId: number): Promise<StudentProfile | null> {
  const rows = await query<StudentProfile>(`select * from student_profile where student_id = $1`, [studentId]);
  return rows[0] ?? null;
}

export async function upsertProfile(studentId: number, input: ProfileInput): Promise<StudentProfile> {
  const rows = await query<StudentProfile>(
    `insert into student_profile (student_id, program, goal, background, struggles, interests)
     values ($1,$2,$3,$4,$5,$6)
     on conflict (student_id) do update set
       program = excluded.program, goal = excluded.goal, background = excluded.background,
       struggles = excluded.struggles, interests = excluded.interests, updated_at = now()
     returning *`,
    [studentId, input.program, input.goal, input.background, input.struggles, input.interests]
  );
  return rows[0]!;
}

function profileBlock(student: Student, profile: StudentProfile | null): string {
  const lines = [`Student's name: ${student.display_name}`];
  if (profile) {
    if (profile.program) lines.push(`Program / year: ${profile.program}`);
    if (profile.goal) lines.push(`Why they're taking this course / goal: ${profile.goal}`);
    if (profile.background) lines.push(`Prior background in the subject: ${profile.background}`);
    if (profile.struggles) lines.push(`What they find hardest so far: ${profile.struggles}`);
    if (profile.interests) lines.push(`Interests, work, hobbies (useful for analogies): ${profile.interests}`);
  } else {
    lines.push('(No profile on file — personalise lightly from what they tell you.)');
  }
  return lines.join('\n');
}

// ─── Sessions ───────────────────────────────────────────────────────────────

export async function getTutorialSession(id: number): Promise<TutorialSession | null> {
  const rows = await query<TutorialSession>(`select * from tutorial_session where id = $1`, [id]);
  return rows[0] ?? null;
}

/** The student's most recent run of each tutorial. */
export async function latestSessionsForStudent(studentId: number): Promise<Map<number, TutorialSession>> {
  const rows = await query<TutorialSession>(
    `select distinct on (tutorial_id) * from tutorial_session
     where student_id = $1 order by tutorial_id, started_at desc`,
    [studentId]
  );
  return new Map(rows.map((r) => [r.tutorial_id, r]));
}

/** Resume the in-progress run or start a new one (`fresh` forces new). */
export async function startTutorialSession(
  tutorial: Tutorial,
  studentId: number,
  opts: { fresh?: boolean } = {}
): Promise<TutorialSession> {
  if (!opts.fresh) {
    const existing = await query<TutorialSession>(
      `select * from tutorial_session
       where tutorial_id = $1 and student_id = $2 and status = 'in_progress'
       order by started_at desc limit 1`,
      [tutorial.id, studentId]
    );
    if (existing[0]) return existing[0];
  }
  const sess = await query<{ id: number }>(
    `insert into session (student_id, kind) values ($1, 'tutorial') returning id`,
    [studentId]
  );
  const rows = await query<TutorialSession>(
    `insert into tutorial_session (tutorial_id, student_id, session_id) values ($1, $2, $3) returning *`,
    [tutorial.id, studentId, sess[0]!.id]
  );
  return rows[0]!;
}

export async function getSessionTurns(sessionId: number): Promise<Turn[]> {
  return query<Turn>(
    `select id, role, content, ts from tutor_turn where session_id = $1 order by ts asc, id asc`,
    [sessionId]
  );
}

async function appendTurn(sessionId: number, role: 'user' | 'assistant', content: string) {
  await query(`insert into tutor_turn (session_id, role, content) values ($1,$2,$3)`, [sessionId, role, content]);
}

// ─── The tutorial conversation ──────────────────────────────────────────────

const TUTORIAL_RULES = `You are running a one-on-one tutorial for a student in the course named below. The instructor designed this tutorial and wrote you a brief describing how they would run it with their best teaching assistant. Follow that brief: it sets the goal, the opening question, the probes, and what "got it" looks like.

You are a Socratic tutor, not a lecturer. Hard rules:
1. One question per turn. Never stack questions.
2. Don't hand over answers the student could be guided to. When they're wrong, ask the question that exposes the contradiction rather than saying "no".
3. Use the student's own words back to them when probing.
4. Vary technique: definition-probing, counter-example, cause-effect chain, zooming in and out between detail and big picture, analogy stress-test.
5. If the student raises something correct that's adjacent to the goal, credit it briefly before steering back.
6. Stay grounded in the course materials provided. If none are attached, draw on general knowledge of the subject described in the brief, and say so if asked where something comes from. If the student asks something outside the materials, say what you can and point them to the instructor.
7. Personalise lightly: about one example or analogy in ten should draw on the student's own context and interests. Never make the tutorial about them instead of the subject.

The tutorial runs in stages. A progress note at the end of this system prompt tells you which stage you're in; move earlier if the student clearly reaches the goal, never later.
- ORIENT (first reply only): greet the student by first name in one short sentence, state the goal of this tutorial in one sentence, then ask the opening question. Nothing else.
- EXPLORE: work through the brief's probes. Build on what they say. Keep them doing the thinking.
- TEACH-BACK: ask the student to explain the core idea back as if teaching a classmate who missed the lecture. Then play back your understanding of what they said in two or three sentences and ask whether you've got it right (Pask's conversation theory: understanding is confirmed when it survives being re-explained). Probe one gap if there is one.
- WRAP-UP: in four or five sentences, summarise the path they walked and what they figured out, name the one thing to review, and tell them they can click "Finish tutorial" to get their summary. Then stop asking questions.

Style: warm, concrete, pitched at the level the brief implies. Many students talk to you by voice and hear your replies read aloud, so keep each reply short — usually under 80 words — in plain spoken sentences. No headings, bullet lists, tables or markdown formatting. No "great question!" filler.

A message beginning "${START_MARKER}" is not from the student; it is the system telling you the student has just opened the tutorial. Reply to it with the ORIENT stage.`;

type Stage = 'ORIENT' | 'EXPLORE' | 'TEACH-BACK' | 'WRAP-UP';

function stageFor(studentTurns: number, targetMinutes: number): { stage: Stage; target: number } {
  // ~1.5 minutes per exchange by voice; clamped so a short tutorial still has
  // room for a teach-back and a long one doesn't drag.
  const target = Math.min(24, Math.max(6, Math.round(targetMinutes / 1.5)));
  if (studentTurns === 0) return { stage: 'ORIENT', target };
  if (studentTurns < Math.round(target * 0.6)) return { stage: 'EXPLORE', target };
  if (studentTurns < target) return { stage: 'TEACH-BACK', target };
  return { stage: 'WRAP-UP', target };
}

function tutorialBrief(t: Tutorial, ctx: CourseCtx): string {
  const parts = [
    `# TUTORIAL BRIEF (written by the instructor)`,
    `Course: ${ctx.title || '(untitled course)'}`,
    `Title: ${t.title}`,
    `Learning goal: ${t.learning_goal}`,
    `Opening question (ask this, verbatim or lightly adapted, in the ORIENT stage): ${t.opening_question}`,
  ];
  if (t.ta_brief) parts.push(`\n## How to run it — the instructor's notes to their TA\n${t.ta_brief}`);
  if (t.misconceptions) parts.push(`\n## Misconceptions to listen for\n${t.misconceptions}`);
  if (t.success_criteria) parts.push(`\n## What "got it" sounds like\n${t.success_criteria}`);
  parts.push(`\nTarget length: about ${t.target_minutes} minutes.`);
  return parts.join('\n');
}

/**
 * Stream one tutor turn. Persists the user turn before streaming and the
 * assistant turn after. A `userMessage` starting with START_MARKER produces
 * the opening.
 */
export async function streamTutorialReply(params: {
  tutorial: Tutorial;
  ctx: CourseCtx;
  tutorialSession: TutorialSession;
  student: Student;
  profile: StudentProfile | null;
  userMessage: string;
  onChunk: (text: string) => void;
  attribution?: Attribution;
}): Promise<{ assistantText: string; stage: Stage; studentTurns: number }> {
  const { tutorial, ctx, tutorialSession, student, profile, userMessage, onChunk, attribution } = params;
  const sessionId = tutorialSession.session_id;

  await appendTurn(sessionId, 'user', userMessage);
  const turns = await getSessionTurns(sessionId);
  const studentTurns = turns.filter((t) => t.role === 'user' && !t.content.startsWith(START_MARKER)).length;
  const { stage, target } = stageFor(studentTurns, tutorial.target_minutes);

  // Merge consecutive same-role turns (the API requires alternation).
  const messages: Anthropic.MessageParam[] = [];
  for (const t of turns) {
    const prev = messages[messages.length - 1];
    if (prev && prev.role === t.role && typeof prev.content === 'string') {
      prev.content = `${prev.content}\n\n${t.content}`;
    } else {
      messages.push({ role: t.role, content: t.content });
    }
  }
  // Cache the transcript prefix: the progress note changes only at stage
  // transitions, so most turns re-read the prior transcript from cache.
  const last = messages[messages.length - 1];
  if (last && typeof last.content === 'string') {
    last.content = [{ type: 'text', text: last.content, cache_control: { type: 'ephemeral' } }];
  }

  const materials = await getMaterials(tutorial.material_ids, ctx);
  const system: Anthropic.TextBlockParam[] = [{ type: 'text', text: TUTORIAL_RULES }];
  const grounding = materialsBlock(materials);
  if (grounding) system.push({ type: 'text', text: grounding, cache_control: { type: 'ephemeral' } });
  system.push({
    type: 'text',
    text: `${tutorialBrief(tutorial, ctx)}\n\n# STUDENT PROFILE\n${profileBlock(student, profile)}`,
    cache_control: { type: 'ephemeral' },
  });
  system.push({
    type: 'text',
    text: `# PROGRESS NOTE\nStudent turns so far: ${studentTurns} of about ${target}. Current stage: ${stage}.`,
  });

  const client = getAnthropic();
  const t0 = Date.now();
  const stream = client.messages.stream({ model: TUTOR_MODEL, max_tokens: 1024, system, messages });

  let assistantText = '';
  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      assistantText += event.delta.text;
      onChunk(event.delta.text);
    }
  }
  await appendTurn(sessionId, 'assistant', assistantText);

  try {
    const final = await stream.finalMessage();
    void recordApiCall({
      ...(attribution ?? { endpoint: 'tutorial.turn' }),
      endpoint: 'tutorial.turn',
      sessionId,
      model: TUTOR_MODEL,
      usage: final.usage,
      durationMs: Date.now() - t0,
    });
  } catch {
    // stream errored mid-flight; the partial reply is already persisted
  }
  return { assistantText, stage, studentTurns };
}

// ─── Completion summary ─────────────────────────────────────────────────────

const SUMMARY_SYSTEM = `You read the transcript of a one-on-one tutorial and write a short structured summary for two readers: the student (student_note) and the instructor (everything else). Judge against the tutorial brief's learning goal and success criteria.

Return ONLY a JSON object, no code fences, with exactly these keys:
{
  "mastery": "solid" | "developing" | "needs_work",
  "understood": [up to 6 short phrases naming what the student demonstrably understood],
  "sticking_points": [up to 6 short phrases naming where they were confused, guessed, or needed heavy prompting; empty array if none],
  "teachback": one sentence on how well they explained the core idea back in their own words, or "Teach-back not reached" if the tutorial ended before that stage,
  "next_step": one concrete thing to review or practise, framed as a concept,
  "student_note": 2–4 warm, specific sentences addressed to the student by first name — what they figured out, and the one thing to revisit
}

Be honest: "solid" means they could explain the idea unprompted and survived a counter-example. A short transcript with little from the student is "needs_work", not "developing".`;

function transcriptText(turns: Turn[], studentName: string): string {
  return turns
    .filter((t) => !t.content.startsWith(START_MARKER))
    .map((t) => `${t.role === 'user' ? studentName : 'Tutor'}: ${t.content}`)
    .join('\n\n');
}

function textOf(res: Anthropic.Message): string {
  return res.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

function stripFences(text: string): string {
  return text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
}

/** Ask for JSON, parse against a schema, retry once with a correction nudge. */
async function jsonCall<T>(params: {
  schema: z.ZodType<T>;
  system: string | Anthropic.TextBlockParam[];
  userPrompt: string;
  maxTokens: number;
  attribution: Attribution;
  endpoint: string;
}): Promise<T> {
  const client = getAnthropic();
  const t0 = Date.now();
  const res = await client.messages.create({
    model: GEN_MODEL,
    max_tokens: params.maxTokens,
    system: params.system,
    messages: [{ role: 'user', content: params.userPrompt }],
  });
  void recordApiCall({ ...params.attribution, endpoint: params.endpoint, model: GEN_MODEL, usage: res.usage, durationMs: Date.now() - t0 });
  try {
    return params.schema.parse(JSON.parse(stripFences(textOf(res))));
  } catch {
    const t1 = Date.now();
    const retry = await client.messages.create({
      model: GEN_MODEL,
      max_tokens: params.maxTokens,
      system: params.system,
      messages: [
        { role: 'user', content: params.userPrompt },
        { role: 'assistant', content: textOf(res) || '(empty)' },
        { role: 'user', content: 'That was not valid JSON matching the schema. Return ONLY the JSON object.' },
      ],
    });
    void recordApiCall({ ...params.attribution, endpoint: params.endpoint + '.retry', model: GEN_MODEL, usage: retry.usage, durationMs: Date.now() - t1 });
    return params.schema.parse(JSON.parse(stripFences(textOf(retry))));
  }
}

export async function completeTutorialSession(params: {
  tutorial: Tutorial;
  ctx: CourseCtx;
  tutorialSession: TutorialSession;
  student: Student;
  attribution: Attribution;
}): Promise<TutorialSummary> {
  const { tutorial, ctx, tutorialSession, student, attribution } = params;
  if (tutorialSession.status === 'completed' && tutorialSession.summary) return tutorialSession.summary;

  const turns = await getSessionTurns(tutorialSession.session_id);
  const studentTurns = turns.filter((t) => t.role === 'user' && !t.content.startsWith(START_MARKER)).length;
  const parsed = await jsonCall({
    schema: TutorialSummary,
    system: SUMMARY_SYSTEM,
    userPrompt:
      `${tutorialBrief(tutorial, ctx)}\n\n# TRANSCRIPT\n${transcriptText(turns, student.display_name) || '(the student did not say anything)'}\n\nWrite the JSON summary now.`,
    maxTokens: 1024,
    attribution,
    endpoint: 'tutorial.summary',
  });
  const summary: TutorialSummary = { ...parsed, turns: studentTurns };

  await query(
    `update tutorial_session set status = 'completed', completed_at = now(), summary = $2 where id = $1`,
    [tutorialSession.id, JSON.stringify(summary)]
  );
  await query(`update session set ended_at = now(), summary = $2 where id = $1`, [
    tutorialSession.session_id,
    JSON.stringify({ tutorial_id: tutorial.id, mastery: summary.mastery }),
  ]);
  return summary;
}

export async function recordNps(tutorialSessionId: number, score: number, comment: string): Promise<void> {
  await query(`update tutorial_session set nps_score = $2, nps_comment = $3 where id = $1`, [
    tutorialSessionId, score, comment || null,
  ]);
}

export async function recordGradeResult(tutorialSessionId: number, result: { posted: boolean; error?: string }): Promise<void> {
  await query(
    `update tutorial_session
       set grade_posted_at = case when $2 then now() else grade_posted_at end, grade_error = $3
     where id = $1`,
    [tutorialSessionId, result.posted, result.error ?? null]
  );
}

// ─── Instructor: report + group debrief ─────────────────────────────────────

export interface TutorialReportRow {
  session_id: number;
  student_id: number;
  display_name: string;
  status: 'in_progress' | 'completed';
  started_at: string;
  completed_at: string | null;
  turns: number;
  summary: TutorialSummary | null;
  nps_score: number | null;
  nps_comment: string | null;
  grade_posted_at: string | null;
  grade_error: string | null;
}

export interface TutorialReport {
  tutorial: Tutorial;
  rows: TutorialReportRow[];
  totals: {
    started: number;
    completed: number;
    avg_turns: number | null;
    mastery: { solid: number; developing: number; needs_work: number };
    nps: { responses: number; score: number | null };
  };
}

/** Latest run per student for one tutorial, with turn counts. */
export async function getTutorialReport(tutorial: Tutorial): Promise<TutorialReport> {
  const rows = await query<TutorialReportRow>(
    `select ts.id as session_id, ts.student_id, st.display_name, ts.status,
            ts.started_at::text, ts.completed_at::text, ts.summary,
            ts.nps_score, ts.nps_comment, ts.grade_posted_at::text, ts.grade_error,
            (select count(*)::int from tutor_turn tt
              where tt.session_id = ts.session_id and tt.role = 'user' and tt.content not like $2) as turns
     from (
       select distinct on (student_id) * from tutorial_session
       where tutorial_id = $1 order by student_id, started_at desc
     ) ts
     join student st on st.id = ts.student_id
     order by ts.started_at desc`,
    [tutorial.id, START_MARKER + '%']
  );
  const completed = rows.filter((r) => r.status === 'completed');
  const mastery = { solid: 0, developing: 0, needs_work: 0 };
  for (const r of completed) if (r.summary) mastery[r.summary.mastery] += 1;
  const npsRows = rows.filter((r) => r.nps_score !== null);
  const promoters = npsRows.filter((r) => (r.nps_score ?? 0) >= 9).length;
  const detractors = npsRows.filter((r) => (r.nps_score ?? 0) <= 6).length;
  const nps = npsRows.length ? Math.round(((promoters - detractors) / npsRows.length) * 100) : null;
  const avgTurns = rows.length ? Math.round((rows.reduce((s, r) => s + r.turns, 0) / rows.length) * 10) / 10 : null;
  return {
    tutorial,
    rows,
    totals: {
      started: rows.length,
      completed: completed.length,
      avg_turns: avgTurns,
      mastery,
      nps: { responses: npsRows.length, score: nps },
    },
  };
}

const DEBRIEF_SYSTEM = `You prepare an instructor for the live group debrief that follows a one-on-one AI tutorial. You are given the tutorial brief and the per-student summaries (anonymised) from every completed run, plus any student feedback comments.

Write a debrief brief in markdown, at most 400 words, with exactly these sections:
## What landed
## Where they stuck
## Misconceptions to address
## Discussion prompts for the debrief
(3–5 prompts the instructor can put to the room, each building on something students actually said)
## One-minute re-teach
(the single explanation most worth giving live, in the instructor's voice)

Be specific and concrete — name the ideas, quote the shape of the confusions. Count how many students hit each issue when that helps ("4 of 11…"). Don't name students. Don't pad with generic teaching advice.`;

export async function generateGroupDebrief(report: TutorialReport, ctx: CourseCtx, attribution: Attribution): Promise<string> {
  const completed = report.rows.filter((r) => r.summary);
  if (completed.length === 0) {
    return "No completed runs yet — the debrief is generated from students' tutorial summaries once they finish.";
  }
  const summaries = completed
    .map((r, i) => {
      const s = r.summary!;
      return (
        `Student ${i + 1} (${s.mastery}, ${r.turns} turns)\n` +
        `  Understood: ${s.understood.join('; ') || '—'}\n` +
        `  Stuck on: ${s.sticking_points.join('; ') || '—'}\n` +
        `  Teach-back: ${s.teachback}`
      );
    })
    .join('\n\n');
  const comments = report.rows
    .filter((r) => r.nps_comment)
    .map((r) => `- (${r.nps_score}/10) ${r.nps_comment}`)
    .join('\n');

  const client = getAnthropic();
  const t0 = Date.now();
  const res = await client.messages.create({
    model: GEN_MODEL,
    max_tokens: 1500,
    system: DEBRIEF_SYSTEM,
    messages: [
      {
        role: 'user',
        content:
          `${tutorialBrief(report.tutorial, ctx)}\n\n# RUNS (${completed.length} completed of ${report.rows.length} started)\n${summaries}` +
          (comments ? `\n\n# STUDENT FEEDBACK COMMENTS\n${comments}` : '') +
          `\n\nWrite the debrief brief now.`,
      },
    ],
  });
  void recordApiCall({ ...attribution, endpoint: 'tutorial.debrief', model: GEN_MODEL, usage: res.usage, durationMs: Date.now() - t0 });
  return textOf(res);
}

// ─── Instructor: draft a brief with AI ──────────────────────────────────────

export const DraftBrief = z.object({
  title: z.string().min(1).max(160),
  learning_goal: z.string().min(1),
  opening_question: z.string().min(1),
  ta_brief: z.string().min(1),
  misconceptions: z.string(),
  success_criteria: z.string(),
});
export type DraftBrief = z.infer<typeof DraftBrief>;

const DRAFT_SYSTEM = `You help a university instructor draft a one-on-one AI tutorial. The instructor gives you a topic (and sometimes rough notes); if course materials are provided, ground everything in them. Draft the brief the way the instructor would write notes for their best teaching assistant — first person, practical, specific.

Return ONLY a JSON object, no code fences, with exactly these keys:
{
  "title": short tutorial title (under 60 characters),
  "learning_goal": one or two sentences: what the student should be able to explain by the end,
  "opening_question": the first question the tutor asks — open, concrete, answerable from the materials, not yes/no,
  "ta_brief": 150–300 words in the instructor's voice: how to open, the 3–5 probes to work through in order (each with what a good answer contains), what to do when the student is stuck, and when to move to the teach-back,
  "misconceptions": 3–5 lines, each a misconception students commonly hold on this topic and the question that exposes it,
  "success_criteria": 2–4 lines describing what a student who "got it" can say or do
}`;

export async function draftTutorialBrief(params: {
  ctx: CourseCtx;
  materialIds: number[];
  topic: string;
  attribution: Attribution;
}): Promise<DraftBrief> {
  const materials = await getMaterials(params.materialIds, params.ctx);
  const system: Anthropic.TextBlockParam[] = [{ type: 'text', text: DRAFT_SYSTEM }];
  const grounding = materialsBlock(materials);
  if (grounding) system.push({ type: 'text', text: grounding, cache_control: { type: 'ephemeral' } });
  return jsonCall({
    schema: DraftBrief,
    system,
    userPrompt: `Course: ${params.ctx.title || '(untitled)'}\n\nTopic / rough notes from the instructor:\n${params.topic}\n\nDraft the tutorial brief JSON now.`,
    maxTokens: 2048,
    attribution: params.attribution,
    endpoint: 'tutorial.draft',
  });
}

// ─── Student: personalised lecture debrief ──────────────────────────────────
//
// Paski's "personalised lecture debrief": keep the core shared, personalise
// the 5–10% that connects it to the student's own goals and context. Here: a
// short written debrief of one course material, with one personal section.

const LECTURE_DEBRIEF_SYSTEM = `You write a short post-lecture debrief of one piece of course material (lecture notes, a transcript, or a reading) for one student. Most of it is the same for every student: the core ideas, in plain English, as a knowledgeable friend would recap them the morning after. One section is personal: it connects the material to this student's stated program, goals and interests.

Format (markdown, at most 450 words total):
## The big ideas
3–5 short paragraphs or a tight list: the ideas that matter, stated so they could be explained to a classmate.
## Where students usually slip
2–3 sentences on the common confusions.
## Consider this in your context, {FIRST_NAME}
2–3 sentences tying one or two of the ideas to the student's program, goal or interests. Specific, not flattering. If their profile is empty, tie it to everyday life instead.
## Three questions to test yourself
Three questions, no answers.

Ground everything in the provided material.`;

export async function getDebrief(studentId: number, materialId: number): Promise<{ markdown: string; generated_at: string } | null> {
  const rows = await query<{ markdown: string; generated_at: string }>(
    `select markdown, generated_at::text from debrief where student_id = $1 and material_id = $2`,
    [studentId, materialId]
  );
  return rows[0] ?? null;
}

export async function generateDebrief(params: {
  student: Student;
  profile: StudentProfile | null;
  material: Material;
  attribution: Attribution;
}): Promise<{ markdown: string; generated_at: string }> {
  const { student, profile, material } = params;
  const firstName = student.display_name.split(/\s+/)[0] || 'there';
  const client = getAnthropic();
  const t0 = Date.now();
  const res = await client.messages.create({
    model: GEN_MODEL,
    max_tokens: 1500,
    system: [
      { type: 'text', text: LECTURE_DEBRIEF_SYSTEM.replace('{FIRST_NAME}', firstName) },
      { type: 'text', text: materialsBlock([material])!, cache_control: { type: 'ephemeral' } },
    ],
    messages: [
      {
        role: 'user',
        content: `# STUDENT PROFILE\n${profileBlock(student, profile)}\n\nWrite the debrief for "${material.title}" now.`,
      },
    ],
  });
  void recordApiCall({ ...params.attribution, endpoint: 'tutorial.lecture_debrief', model: GEN_MODEL, usage: res.usage, durationMs: Date.now() - t0 });
  const markdown = textOf(res);
  const rows = await query<{ markdown: string; generated_at: string }>(
    `insert into debrief (student_id, material_id, markdown) values ($1, $2, $3)
     on conflict (student_id, material_id) do update set markdown = excluded.markdown, generated_at = now()
     returning markdown, generated_at::text`,
    [student.id, material.id, markdown]
  );
  return rows[0]!;
}
