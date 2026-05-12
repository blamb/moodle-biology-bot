/**
 * Admin-only operational views served at /admin/*.
 *
 * These bypass the LTI session validator (mounted via ltijs's serverAddon
 * before the validator middleware) and are gated solely by the ADMIN_TOKEN
 * environment variable. Intended for the project operator (Brian during dev,
 * TRU IT or the prof later) — NOT for instructors or students.
 *
 * Currently surfaces a class-agnostic cost dashboard: total Anthropic spend
 * across every course this deployment serves, with per-feature, per-course,
 * per-student, and per-day breakdowns.
 */

import { query } from './db.js';

interface RowEndpoint { endpoint: string; calls: number; cost: string }
interface RowCourse { iss: string; ctx: string; calls: number; cost: string }
interface RowStudent { id: number; display_name: string; iss: string; ctx: string; calls: number; cost: string }
interface RowDay { day: string; calls: number; cost: string }
interface RowTotal { total_cost: string; total_input: number; total_output: number; total_cache_read: number; total_cache_create: number; total_calls: number }

export async function renderAdminCostsHtml(): Promise<string> {
  const [totals] = await query<RowTotal>(
    `select
       coalesce(sum(cost_usd), 0)::text as total_cost,
       coalesce(sum(input_tokens), 0)::int as total_input,
       coalesce(sum(output_tokens), 0)::int as total_output,
       coalesce(sum(cache_read_tokens), 0)::int as total_cache_read,
       coalesce(sum(cache_creation_tokens), 0)::int as total_cache_create,
       count(*)::int as total_calls
     from api_call`
  );

  const byEndpoint = await query<RowEndpoint>(
    `select endpoint, count(*)::int as calls, sum(cost_usd)::text as cost
     from api_call group by endpoint order by sum(cost_usd) desc`
  );
  const byCourse = await query<RowCourse>(
    `select coalesce(lti_iss, '(unknown)') as iss,
            coalesce(lti_context_id, '(unknown)') as ctx,
            count(*)::int as calls, sum(cost_usd)::text as cost
     from api_call group by lti_iss, lti_context_id order by sum(cost_usd) desc`
  );
  const byStudent = await query<RowStudent>(
    `select s.id, s.display_name, s.lti_iss as iss, s.lti_context_id as ctx,
            count(c.id)::int as calls, sum(c.cost_usd)::text as cost
     from api_call c join student s on s.id = c.student_id
     group by s.id, s.display_name, s.lti_iss, s.lti_context_id
     order by sum(c.cost_usd) desc
     limit 50`
  );
  const byDay = await query<RowDay>(
    `select to_char(date_trunc('day', ts), 'YYYY-MM-DD') as day,
            count(*)::int as calls, sum(cost_usd)::text as cost
     from api_call
     group by date_trunc('day', ts)
     order by date_trunc('day', ts) desc
     limit 30`
  );

  const t = totals ?? {
    total_cost: '0', total_input: 0, total_output: 0,
    total_cache_read: 0, total_cache_create: 0, total_calls: 0,
  };
  const fmt$ = (n: number | string) => '$' + parseFloat(String(n)).toFixed(4);
  const fmtTok = (n: number) =>
    n >= 1_000_000 ? (n / 1_000_000).toFixed(1) + 'M' :
    n >= 1_000 ? Math.round(n / 1_000) + 'k' : String(n);
  const esc = (s: string | null | undefined) =>
    String(s ?? '').replace(/[&<>"']/g, (c) =>
      ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]!)
    );

  const totalsCards = [
    { lbl: 'Total spend', num: fmt$(t.total_cost) },
    { lbl: 'API calls', num: t.total_calls },
    { lbl: 'Input tokens', num: fmtTok(t.total_input) },
    { lbl: 'Output tokens', num: fmtTok(t.total_output) },
    { lbl: 'Cache reads', num: fmtTok(t.total_cache_read) },
    { lbl: 'Cache writes', num: fmtTok(t.total_cache_create) },
  ];

  const totalsHtml = totalsCards
    .map((c) => `<div class="card"><div class="num">${c.num}</div><div class="lbl">${esc(c.lbl)}</div></div>`)
    .join('');

  const endpointRows = byEndpoint
    .map((r) => `<tr><td>${esc(r.endpoint)}</td><td class="n">${r.calls}</td><td class="n">${fmt$(r.cost)}</td></tr>`)
    .join('');
  const courseRows = byCourse
    .map((r) => `<tr><td>${esc(r.iss)}</td><td>${esc(r.ctx).slice(0, 60)}</td><td class="n">${r.calls}</td><td class="n">${fmt$(r.cost)}</td></tr>`)
    .join('');
  const studentRows = byStudent
    .map((r) => `<tr><td>${esc(r.display_name)}</td><td>${esc(r.iss)}</td><td class="n">${r.calls}</td><td class="n">${fmt$(r.cost)}</td></tr>`)
    .join('');
  const dayRows = byDay
    .map((r) => `<tr><td>${r.day}</td><td class="n">${r.calls}</td><td class="n">${fmt$(r.cost)}</td></tr>`)
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Biology Bot — Admin: Cost Dashboard</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; }
  body { background: #fafafa; color: #1a1a1a; margin: 0; padding: 2rem 1.5rem; line-height: 1.4; }
  .wrap { max-width: 980px; margin: 0 auto; }
  h1 { margin: 0 0 .25rem; font-size: 1.4rem; }
  .sub { color: #666; font-size: .9rem; margin-bottom: 1.5rem; }
  .admin-tag { display:inline-block; padding:.15rem .5rem; border-radius:999px; background:#fce8e8; color:#8b1f1f; font-size:.75rem; letter-spacing:.04em; text-transform:uppercase; margin-bottom: .25rem; }
  h2 { font-size: 1rem; margin: 1.5rem 0 .5rem; padding-bottom: .35rem; border-bottom: 1px solid #e5e5e5; }
  .totals { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: .75rem; margin-bottom: 1rem; }
  .card { background:#fff; border:1px solid #e5e5e5; border-radius:8px; padding:.85rem 1rem; }
  .card .num { font-size: 1.5rem; font-weight: 600; font-variant-numeric: tabular-nums; }
  .card .lbl { color:#666; font-size:.8rem; }
  table { width: 100%; border-collapse: collapse; font-size: .9rem; }
  th, td { text-align: left; padding: .4rem .55rem; border-bottom: 1px solid #e5e5e5; }
  th { color:#666; font-weight:500; font-size:.8rem; }
  td.n { text-align: right; font-variant-numeric: tabular-nums; }
  td:nth-child(2) { color:#666; font-family: ui-monospace, monospace; font-size:.85rem; }
</style>
</head>
<body>
<div class="wrap">
  <div class="admin-tag">Admin only</div>
  <h1>Biology Bot — Anthropic Cost Dashboard</h1>
  <div class="sub">Generated ${new Date().toISOString()}</div>

  <h2>Totals (all courses, all time)</h2>
  <div class="totals">${totalsHtml}</div>

  <h2>By feature</h2>
  <table>
    <thead><tr><th>Endpoint</th><th class="n">Calls</th><th class="n">Cost</th></tr></thead>
    <tbody>${endpointRows || '<tr><td colspan="3" style="color:#888">No data yet.</td></tr>'}</tbody>
  </table>

  <h2>By course</h2>
  <table>
    <thead><tr><th>Issuer</th><th>Course context</th><th class="n">Calls</th><th class="n">Cost</th></tr></thead>
    <tbody>${courseRows || '<tr><td colspan="4" style="color:#888">No data yet.</td></tr>'}</tbody>
  </table>

  <h2>By student (top 50)</h2>
  <table>
    <thead><tr><th>Student</th><th>Issuer</th><th class="n">Calls</th><th class="n">Cost</th></tr></thead>
    <tbody>${studentRows || '<tr><td colspan="4" style="color:#888">No data yet.</td></tr>'}</tbody>
  </table>

  <h2>By day (last 30)</h2>
  <table>
    <thead><tr><th>Day</th><th class="n">Calls</th><th class="n">Cost</th></tr></thead>
    <tbody>${dayRows || '<tr><td colspan="3" style="color:#888">No data yet.</td></tr>'}</tbody>
  </table>
</div>
</body>
</html>`;
}
