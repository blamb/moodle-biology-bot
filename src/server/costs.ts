/**
 * Cost tracking for Anthropic API calls. Wraps each `messages.create` /
 * `messages.stream` response and records:
 *   - the endpoint that triggered the call
 *   - the model used
 *   - input / output / cache-read / cache-creation token counts
 *   - computed USD cost using Anthropic's published per-million rates
 *
 * The actual SDK call is unchanged; this is pure observability.
 *
 * Cost table viewable via the instructor dashboard. Helpful when transitioning
 * billing from Brian's API key to TRU's.
 */

import { query } from './db.js';

// USD per 1 million tokens. Update when Anthropic's pricing changes.
// Cache write tokens are charged at ~25% over base input rate; cache read
// tokens are charged at 10% of base input rate.
const MODEL_PRICES: Record<
  string,
  { input: number; output: number; cacheRead: number; cacheWrite: number }
> = {
  // Opus 4.x family
  'claude-opus-4-7':    { input: 15, output: 75, cacheRead: 1.5,  cacheWrite: 18.75 },
  'claude-opus-4-6':    { input: 15, output: 75, cacheRead: 1.5,  cacheWrite: 18.75 },
  'claude-opus-4-5':    { input: 15, output: 75, cacheRead: 1.5,  cacheWrite: 18.75 },

  // Sonnet 4.x family
  'claude-sonnet-4-6':  { input: 3,  output: 15, cacheRead: 0.3,  cacheWrite: 3.75 },
  'claude-sonnet-4-5':  { input: 3,  output: 15, cacheRead: 0.3,  cacheWrite: 3.75 },

  // Haiku 4.x family
  'claude-haiku-4-5':   { input: 1,  output: 5,  cacheRead: 0.1,  cacheWrite: 1.25 },
};

export interface AnthropicUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

export function computeCostUsd(
  model: string,
  usage: AnthropicUsage
): number {
  const price = MODEL_PRICES[model];
  if (!price) {
    // Unknown model — log warning but don't fail. Cost recorded as 0.
    console.warn(`costs: no price entry for model "${model}"; cost will be 0`);
    return 0;
  }
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheCreate = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cost =
    (input * price.input +
     output * price.output +
     cacheCreate * price.cacheWrite +
     cacheRead * price.cacheRead) /
    1_000_000;
  // Round to 6 decimal places to match numeric(10,6) column precision.
  return Math.round(cost * 1_000_000) / 1_000_000;
}

/**
 * Where to attribute a particular Anthropic call. Carries forward to the
 * api_call table so the instructor dashboard can show "X spent on tutor turns
 * for student Y in course Z".
 */
export interface Attribution {
  studentId?: number | null;
  sessionId?: number | null;
  iss?: string | null;
  contextId?: string | null;
  endpoint: string;
}

export interface RecordApiCallParams extends Attribution {
  model: string;
  usage: AnthropicUsage;
  durationMs?: number;
}

export interface CostSummary {
  total_cost_usd: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_creation_tokens: number;
  total_calls: number;
  by_endpoint: Array<{ endpoint: string; calls: number; cost_usd: number }>;
  by_student: Array<{ student_id: number; display_name: string; calls: number; cost_usd: number }>;
  by_day: Array<{ day: string; cost_usd: number; calls: number }>;
}

export async function getCostSummaryForCourse(params: {
  iss: string;
  contextId: string;
}): Promise<CostSummary> {
  const { iss, contextId } = params;

  const totals = await query<{
    total_cost: string;
    total_input: number;
    total_output: number;
    total_cache_read: number;
    total_cache_create: number;
    total_calls: number;
  }>(
    `select
       coalesce(sum(cost_usd), 0)::text as total_cost,
       coalesce(sum(input_tokens), 0)::int as total_input,
       coalesce(sum(output_tokens), 0)::int as total_output,
       coalesce(sum(cache_read_tokens), 0)::int as total_cache_read,
       coalesce(sum(cache_creation_tokens), 0)::int as total_cache_create,
       count(*)::int as total_calls
     from api_call
     where lti_iss = $1 and lti_context_id = $2`,
    [iss, contextId]
  );

  const byEndpoint = await query<{ endpoint: string; calls: number; cost: string }>(
    `select endpoint, count(*)::int as calls, sum(cost_usd)::text as cost
     from api_call
     where lti_iss = $1 and lti_context_id = $2
     group by endpoint
     order by sum(cost_usd) desc
     limit 20`,
    [iss, contextId]
  );

  const byStudent = await query<{
    student_id: number; display_name: string; calls: number; cost: string;
  }>(
    `select s.id as student_id, s.display_name,
            count(c.id)::int as calls,
            sum(c.cost_usd)::text as cost
     from api_call c
     join student s on s.id = c.student_id
     where c.lti_iss = $1 and c.lti_context_id = $2
     group by s.id, s.display_name
     order by sum(c.cost_usd) desc
     limit 20`,
    [iss, contextId]
  );

  const byDay = await query<{ day: string; calls: number; cost: string }>(
    `select to_char(date_trunc('day', ts), 'YYYY-MM-DD') as day,
            count(*)::int as calls,
            sum(cost_usd)::text as cost
     from api_call
     where lti_iss = $1 and lti_context_id = $2
     group by date_trunc('day', ts)
     order by date_trunc('day', ts) desc
     limit 30`,
    [iss, contextId]
  );

  return {
    total_cost_usd: parseFloat(totals[0]?.total_cost ?? '0'),
    total_input_tokens: totals[0]?.total_input ?? 0,
    total_output_tokens: totals[0]?.total_output ?? 0,
    total_cache_read_tokens: totals[0]?.total_cache_read ?? 0,
    total_cache_creation_tokens: totals[0]?.total_cache_create ?? 0,
    total_calls: totals[0]?.total_calls ?? 0,
    by_endpoint: byEndpoint.map((r) => ({
      endpoint: r.endpoint,
      calls: r.calls,
      cost_usd: parseFloat(r.cost),
    })),
    by_student: byStudent.map((r) => ({
      student_id: r.student_id,
      display_name: r.display_name,
      calls: r.calls,
      cost_usd: parseFloat(r.cost),
    })),
    by_day: byDay
      .map((r) => ({ day: r.day, cost_usd: parseFloat(r.cost), calls: r.calls }))
      .reverse(),
  };
}

export async function recordApiCall(p: RecordApiCallParams): Promise<void> {
  const cost = computeCostUsd(p.model, p.usage);
  try {
    await query(
      `insert into api_call
       (student_id, session_id, lti_iss, lti_context_id, endpoint, model,
        input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
        cost_usd, duration_ms)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        p.studentId ?? null,
        p.sessionId ?? null,
        p.iss ?? null,
        p.contextId ?? null,
        p.endpoint,
        p.model,
        p.usage.input_tokens ?? 0,
        p.usage.output_tokens ?? 0,
        p.usage.cache_creation_input_tokens ?? 0,
        p.usage.cache_read_input_tokens ?? 0,
        cost,
        p.durationMs ?? null,
      ]
    );
  } catch (e) {
    // Cost logging must never break the user-visible flow. Just warn.
    console.warn('costs: failed to record api_call:', (e as Error).message);
  }
}
