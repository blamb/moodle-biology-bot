/**
 * Cost tracking: every Anthropic call records its endpoint, model, token
 * counts and USD cost (at Anthropic's published rates) to api_call, so a
 * course's spend can be seen per feature, student and day.
 */

import { query } from './db.js';

// USD per 1M tokens: input, output, cache read, cache write.
// Update when Anthropic's pricing changes; unknown models record cost 0.
const MODEL_PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  'claude-opus-5-5':   { input: 4,    output: 20,   cacheRead: 0.2,   cacheWrite: 5 },
  'claude-opus-5':     { input: 5,    output: 25,   cacheRead: 0.5,   cacheWrite: 6.25 },
  'claude-opus-4-8':   { input: 5,    output: 25,   cacheRead: 0.5,   cacheWrite: 6.25 },
  'claude-sonnet-5-5': { input: 2,    output: 10,   cacheRead: 0.2,   cacheWrite: 2.5 },
  'claude-sonnet-5':   { input: 2,    output: 10,   cacheRead: 0.2,   cacheWrite: 2.5 },
  'claude-sonnet-4-6': { input: 3,    output: 15,   cacheRead: 0.3,   cacheWrite: 3.75 },
  'claude-haiku-5-5':  { input: 0.1,  output: 0.5,  cacheRead: 0.01,  cacheWrite: 0.125 },
  'claude-haiku-4-5':  { input: 1,    output: 5,    cacheRead: 0.1,   cacheWrite: 1.25 },
};

export interface AnthropicUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

export function computeCostUsd(model: string, usage: AnthropicUsage): number {
  const price = MODEL_PRICES[model];
  if (!price) {
    console.warn(`costs: no price entry for model "${model}"; cost will be 0`);
    return 0;
  }
  const cost =
    ((usage.input_tokens ?? 0) * price.input +
      (usage.output_tokens ?? 0) * price.output +
      (usage.cache_creation_input_tokens ?? 0) * price.cacheWrite +
      (usage.cache_read_input_tokens ?? 0) * price.cacheRead) /
    1_000_000;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

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

export async function recordApiCall(p: RecordApiCallParams): Promise<void> {
  const cost = computeCostUsd(p.model, p.usage);
  try {
    await query(
      `insert into api_call
       (student_id, session_id, lti_iss, lti_context_id, endpoint, model,
        input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, cost_usd, duration_ms)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        p.studentId ?? null, p.sessionId ?? null, p.iss ?? null, p.contextId ?? null,
        p.endpoint, p.model,
        p.usage.input_tokens ?? 0, p.usage.output_tokens ?? 0,
        p.usage.cache_creation_input_tokens ?? 0, p.usage.cache_read_input_tokens ?? 0,
        cost, p.durationMs ?? null,
      ]
    );
  } catch (e) {
    console.warn('costs: failed to record api_call:', (e as Error).message);
  }
}

export interface CostSummary {
  total_cost_usd: number;
  total_calls: number;
  by_endpoint: Array<{ endpoint: string; calls: number; cost_usd: number }>;
  by_course: Array<{ iss: string; context_id: string; calls: number; cost_usd: number }>;
  by_day: Array<{ day: string; calls: number; cost_usd: number }>;
}

/** Whole-deployment summary for the token-gated /admin/costs endpoint. */
export async function getCostSummary(): Promise<CostSummary> {
  const totals = await query<{ cost: string; calls: number }>(
    `select coalesce(sum(cost_usd), 0)::text as cost, count(*)::int as calls from api_call`
  );
  const byEndpoint = await query<{ endpoint: string; calls: number; cost: string }>(
    `select endpoint, count(*)::int as calls, sum(cost_usd)::text as cost
     from api_call group by endpoint order by sum(cost_usd) desc limit 30`
  );
  const byCourse = await query<{ iss: string; context_id: string; calls: number; cost: string }>(
    `select coalesce(lti_iss,'') as iss, coalesce(lti_context_id,'') as context_id,
            count(*)::int as calls, sum(cost_usd)::text as cost
     from api_call group by 1, 2 order by sum(cost_usd) desc limit 30`
  );
  const byDay = await query<{ day: string; calls: number; cost: string }>(
    `select to_char(date_trunc('day', ts), 'YYYY-MM-DD') as day, count(*)::int as calls, sum(cost_usd)::text as cost
     from api_call group by 1 order by 1 desc limit 60`
  );
  return {
    total_cost_usd: parseFloat(totals[0]?.cost ?? '0'),
    total_calls: totals[0]?.calls ?? 0,
    by_endpoint: byEndpoint.map((r) => ({ endpoint: r.endpoint, calls: r.calls, cost_usd: parseFloat(r.cost) })),
    by_course: byCourse.map((r) => ({ iss: r.iss, context_id: r.context_id, calls: r.calls, cost_usd: parseFloat(r.cost) })),
    by_day: byDay.map((r) => ({ day: r.day, calls: r.calls, cost_usd: parseFloat(r.cost) })).reverse(),
  };
}
