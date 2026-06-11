/**
 * Socratic tutor — session lifecycle, turn persistence, and streaming reply
 * generation. The unit's content (PPT + textbook + terms) goes into a single
 * prompt-cached system block so repeated turns within a session are cheap.
 *
 * The 7-rule Socratic frame is adapted from open-margins' nova tutor, tightened
 * for A&P pedagogy.
 */

import Anthropic from '@anthropic-ai/sdk';
import { query } from './db.js';
import { getUnit, type UnitContent } from './content.js';
import { getAnthropic, TUTOR_MODEL } from './anthropic.js';
import { recordApiCall, type Attribution } from './costs.js';

interface Session {
  id: number;
  student_id: number;
  kind: string;
  unit_no: number;
  started_at: string;
  ended_at: string | null;
}

interface Turn {
  id: number;
  session_id: number;
  role: 'user' | 'assistant';
  content: string;
  ts: string;
}

const SOCRATIC_RULES = `You are a Socratic tutor for a Human Anatomy & Physiology course at a Canadian university (Thompson Rivers University, BIOL 1592). Your job is to help an undergraduate student build their own understanding — never to lecture or hand them an answer.

Hard rules:
1. NEVER give a direct factual answer to a question the student could be guided to. Ask a question back.
2. Use the student's exact wording back to them when probing — "you said 'the cell membrane is selectively permeable' — what does selectively mean to a phospholipid bilayer?"
3. Vary your technique across turns. Rotate among: definition-probing, counter-example, cause-effect chain, assumption-surfacing, scale-shift (zoom into a cell / out to a whole organ), and analogy-stress-test.
4. One question per turn. Never stack questions.
5. When the student is wrong, don't say "no" — ask a question that exposes the contradiction. ("If that were true, what would happen when…?")
6. Stay grounded in the unit content provided. If the student goes wildly off-topic, gently steer back: "That's interesting — can we hold that thought until we've worked through [current sub-topic]?"
7. If the student raises correct biology that's adjacent to (but outside) what the question or rubric was testing — e.g. they mention a related structure or downstream effect that's factually right but wasn't part of what was being assessed — ACKNOWLEDGE it as valid before redirecting. Don't dismiss it as "not needed" and don't keep pulling them back to the rubric item without first crediting their thinking. Something like: "Good catch — yes, that's true, and it's a reasonable connection. The question itself was scoped to X, so it didn't pull marks for that — but you're not wrong. Want to keep building on it, or shall we look at Y?"
8. After ~6–8 productive exchanges OR when the student demonstrates they've reached the learning goal, synthesise: summarise the path they walked, name what they figured out, and offer one consolidation question or stop cleanly.

Tone: warm, undergraduate-appropriate, concrete. Avoid jargon-density unless probing the student's grasp of a specific term that's already in their vocabulary or this unit's terms list.

The student's display name and current unit are provided in the user message preamble for the first turn only; you don't need to repeat them.`;

function unitGroundingBlock(unit: UnitContent): string {
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

export async function getOrCreateActiveSession(
  studentId: number,
  unitNo: number,
  options: { forceFresh?: boolean } = {}
): Promise<Session> {
  if (options.forceFresh) {
    // End any open tutor session for this (student, unit) so we start clean.
    await query(
      `update session set ended_at = now()
       where student_id = $1 and unit_no = $2 and kind = 'tutor' and ended_at is null`,
      [studentId, unitNo]
    );
  }
  const existing = await query<Session>(
    `select * from session
     where student_id=$1 and unit_no=$2 and kind='tutor' and ended_at is null
     order by started_at desc limit 1`,
    [studentId, unitNo]
  );
  if (existing.length > 0) return existing[0]!;
  const created = await query<Session>(
    `insert into session (student_id, kind, unit_no) values ($1, 'tutor', $2) returning *`,
    [studentId, unitNo]
  );
  return created[0]!;
}

export async function getTurns(sessionId: number): Promise<Turn[]> {
  return query<Turn>(
    `select * from tutor_turn where session_id=$1 order by ts asc, id asc`,
    [sessionId]
  );
}

async function appendTurn(
  sessionId: number,
  role: 'user' | 'assistant',
  content: string
): Promise<void> {
  await query(
    `insert into tutor_turn (session_id, role, content) values ($1, $2, $3)`,
    [sessionId, role, content]
  );
}

/**
 * Stream a Socratic reply to the given user message. Persists both the user
 * turn (before streaming starts) and the assistant turn (after streaming
 * completes). Emits the assistant's text in chunks via `onChunk`.
 *
 * Throws on Anthropic API errors; the caller is responsible for surfacing
 * them to the client.
 */
export async function streamSocraticReply(params: {
  session: Session;
  userMessage: string;
  displayName: string;
  onChunk: (text: string) => void;
  attribution?: Attribution;
}): Promise<{ assistantText: string }> {
  const { session, userMessage, displayName, onChunk, attribution } = params;
  const unit = getUnit(session.unit_no);

  await appendTurn(session.id, 'user', userMessage);
  const turns = await getTurns(session.id);

  // Anthropic messages: full prior history + this user turn. The history
  // already includes the just-appended user message because we re-read.
  const messages: Anthropic.MessageParam[] = turns.map((t) => ({
    role: t.role,
    content: t.content,
  }));

  // First user message gets a brief preamble so the model knows the student's
  // name and unit context. We prepend it only to the first user message in the
  // wire-level messages array (not stored in DB).
  if (messages.length > 0 && messages[0]!.role === 'user') {
    messages[0] = {
      role: 'user',
      content: `(Tutor preamble — not part of the student's message: the student is "${displayName}" working on Unit ${session.unit_no}: ${unit.ppt_title}. Begin or continue the Socratic dialogue.)\n\n${messages[0]!.content as string}`,
    };
  }

  // Cache the conversation transcript too, not just the system block. A second
  // breakpoint on the latest turn means each subsequent turn reads the prior
  // transcript from cache instead of re-processing it at full price. The
  // system block (rules + unit grounding) is already cached separately above;
  // this caps the marginal per-turn input cost as the dialogue grows.
  const last = messages[messages.length - 1];
  if (last) {
    last.content = [
      {
        type: 'text',
        text: last.content as string,
        cache_control: { type: 'ephemeral' },
      },
    ];
  }

  const client = getAnthropic();
  const t0 = Date.now();
  const stream = client.messages.stream({
    model: TUTOR_MODEL,
    max_tokens: 1024,
    system: [
      { type: 'text', text: SOCRATIC_RULES },
      {
        type: 'text',
        text: unitGroundingBlock(unit),
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages,
  });

  let assistantText = '';
  for await (const event of stream) {
    if (
      event.type === 'content_block_delta' &&
      event.delta.type === 'text_delta'
    ) {
      assistantText += event.delta.text;
      onChunk(event.delta.text);
    }
  }

  await appendTurn(session.id, 'assistant', assistantText);

  // Record token usage once the stream completes.
  try {
    const final = await stream.finalMessage();
    void recordApiCall({
      ...(attribution ?? { endpoint: 'tutor.turn' }),
      endpoint: 'tutor.turn',
      sessionId: session.id,
      model: TUTOR_MODEL,
      usage: final.usage,
      durationMs: Date.now() - t0,
    });
  } catch {
    // finalMessage can fail if stream errored mid-flight; don't break the response
  }

  return { assistantText };
}
