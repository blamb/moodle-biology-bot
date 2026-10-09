/**
 * LTI 1.3 provider setup (ltijs + Sequelize-backed Postgres plugin), the
 * launch handler, deep linking, and the out-of-band endpoints mounted before
 * ltijs's session validator (/healthz, /fullscreen, /admin/costs).
 *
 * Cookies are sameSite=None + secure because the launch iframe is on the
 * tool's HTTPS origin while Moodle is on another site.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { randomBytes } from 'node:crypto';
import ltijs, { type IdToken } from 'ltijs';
import Database from 'ltijs-sequelize';
import { env, isProd } from './env.js';
import { findOrCreateStudent } from './students.js';
import { isTeacher } from './auth.js';
import { listTutorials } from './tutorials.js';
import { getCostSummary } from './costs.js';

const { Provider: lti } = ltijs;

const HERE = dirname(fileURLToPath(import.meta.url));
const LAUNCH_HTML_PATH = join(HERE, '..', 'web', 'launch.html');

// ─── Full-screen session handoff ─────────────────────────────────────────────
// Cookie-partitioning browsers (Firefox Total Cookie Protection) hide a
// cookie set inside a cross-site iframe from a later top-level navigation,
// so "Full screen" would 401. An in-iframe call mints a single-use nonce
// bound to the session cookies + ltik; GET /fullscreen redeems it, re-issues
// the cookies first-party, and redirects into the app. Voice input needs
// this too: Moodle's iframe doesn't grant microphone access.
const FULLSCREEN_NONCE_TTL_MS = 10 * 60_000;
const fullscreenNonces = new Map<string, { cookieHeader: string; ltik: string; expires: number }>();

export function mintFullscreenNonce(cookieHeader: string, ltik: string): string {
  const now = Date.now();
  for (const [k, v] of fullscreenNonces) if (v.expires < now) fullscreenNonces.delete(k);
  const nonce = randomBytes(24).toString('base64url');
  fullscreenNonces.set(nonce, { cookieHeader, ltik, expires: now + FULLSCREEN_NONCE_TTL_MS });
  return nonce;
}

let _launchHtmlCache: string | null = null;
function loadLaunchHtml(): string {
  if (!isProd) return readFileSync(LAUNCH_HTML_PATH, 'utf8'); // hot-reload in dev
  if (!_launchHtmlCache) _launchHtmlCache = readFileSync(LAUNCH_HTML_PATH, 'utf8');
  return _launchHtmlCache;
}

const dbUrl = new URL(env.DATABASE_URL);
const ltiDb = new Database(
  decodeURIComponent(dbUrl.pathname.replace(/^\//, '')) || 'lti_tutor',
  decodeURIComponent(dbUrl.username || 'postgres'),
  decodeURIComponent(dbUrl.password || ''),
  {
    host: dbUrl.hostname || 'localhost',
    port: parseInt(dbUrl.port || '5432', 10),
    dialect: 'postgres',
    logging: false,
    dialectOptions: /sslmode=require/i.test(env.DATABASE_URL)
      ? { ssl: { require: true, rejectUnauthorized: false } }
      : undefined,
  }
);

lti.setup(
  env.LTI_COOKIE_SECRET,
  { plugin: ltiDb },
  {
    cookies: { secure: true, sameSite: 'None' },
    devMode: false,
    dynReg: {
      url: env.LTI_TOOL_URL,
      name: env.TOOL_NAME,
      description: 'Instructor-designed one-on-one AI tutorials with voice, deep linking and debriefs',
      redirectUris: [env.LTI_TOOL_URL],
      autoActivate: true,
    },
    serverAddon: (server) => {
      server.get('/healthz', (_req, res) => {
        const sha = process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT || 'unknown';
        res.json({ status: 'ok', commit: sha, env: env.NODE_ENV, uptime_s: Math.round(process.uptime()) });
      });

      server.get('/fullscreen', (req, res) => {
        const nonce = String(req.query.n ?? '');
        const entry = fullscreenNonces.get(nonce);
        fullscreenNonces.delete(nonce);
        if (!entry || entry.expires < Date.now()) {
          return res.status(410).type('html').send(
            '<p>This full-screen link has expired. Go back to your course, open the tutor, and click “Full screen” again.</p>'
          );
        }
        const cookies = entry.cookieHeader.split(';').map((c) => c.trim()).filter(Boolean);
        res.setHeader('Set-Cookie', cookies.map((c) => `${c}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=86400`));
        res.redirect(`/?ltik=${encodeURIComponent(entry.ltik)}`);
      });

      // Operator-only cost summary (JSON). Not exposed inside the LMS.
      server.get('/admin/costs', async (req, res) => {
        if (!env.ADMIN_TOKEN) return res.status(503).type('text').send('Admin endpoints are disabled (set ADMIN_TOKEN).');
        const supplied = (req.query.token as string) || req.headers['x-admin-token'];
        if (supplied !== env.ADMIN_TOKEN) return res.status(401).type('text').send('Unauthorized');
        try {
          res.json(await getCostSummary());
        } catch (e) {
          res.status(500).type('text').send('Error: ' + (e as Error).message);
        }
      });
    },
  }
);

function courseCtxOf(token: IdToken) {
  return {
    iss: token.iss,
    contextId: token.platformContext.context?.id ?? token.platformContext.contextId,
    title: token.platformContext.context?.title || '',
  };
}

/** Successful launch: ltijs validated the JWT and set the session cookie. */
lti.onConnect(async (token: IdToken, req, res) => {
  const ctx = courseCtxOf(token);
  const student = await findOrCreateStudent({
    sub: token.user,
    iss: token.iss,
    contextId: ctx.contextId,
    displayName:
      token.userInfo.name ||
      [token.userInfo.given_name, token.userInfo.family_name].filter(Boolean).join(' ') ||
      'Student',
  });
  const role = isTeacher(token) ? 'teacher' : 'student';
  const lp = token.platformContext.launchPresentation as Record<string, unknown> | undefined;
  const rawReturnUrl = typeof lp?.return_url === 'string' ? lp.return_url : '';
  const returnUrl = /^https?:\/\//i.test(rawReturnUrl) ? rawReturnUrl : '';
  // Deep-linked tutorial activity: Moodle passes the custom tutorial_id we set
  // when the instructor placed it; the client opens that tutorial directly.
  const rawTutorialId = String(token.platformContext.custom?.tutorial_id ?? '');
  const tutorialId = /^\d+$/.test(rawTutorialId) ? rawTutorialId : '';

  const html = loadLaunchHtml()
    .replace('{{TUTORIAL_ID}}', tutorialId)
    .replace('{{TOOL_NAME}}', escapeHtml(env.TOOL_NAME))
    .replace('{{RETURN_URL}}', escapeHtml(returnUrl))
    .replace('{{DISPLAY_NAME}}', escapeHtml(student.display_name))
    .replace('{{CONTEXT_TITLE}}', escapeHtml(ctx.title))
    .replace('{{ROLE}}', role);
  return res.send(html);
});

/**
 * Deep linking: Moodle's "Select content" on an External tool activity.
 * Instructors pick which tutorials to place in the course, each as its own
 * activity, so the tutorial sits in the sequence between lecture and debrief.
 */
lti.onDeepLinking(async (token: IdToken, req, res) => {
  if (!isTeacher(token)) {
    return res.status(403).type('html').send('<p>Only instructors can select content.</p>');
  }
  const ltik = String((res.locals as { ltik?: string }).ltik ?? '');
  const tutorials = await listTutorials(courseCtxOf(token), { publishedOnly: false });
  const rows = tutorials
    .map(
      (t) =>
        `<label class="row"><input type="checkbox" name="tutorial" value="${t.id}">` +
        `<span><strong>${escapeHtml(t.title)}</strong>` +
        `<span class="meta"> · ${t.target_minutes} min${t.status !== 'published' ? ' · <em>' + t.status + '</em>' : ''}${t.gradebook ? ' · gradebook column' : ''}</span>` +
        `<div class="goal">${escapeHtml(t.learning_goal)}</div></span></label>`
    )
    .join('\n');
  res.type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Select content — ${escapeHtml(env.TOOL_NAME)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 1.5rem; color: #1a1a1a; max-width: 720px; }
  h1 { font-size: 1.2rem; margin: 0 0 .25rem; } p { color: #666; margin: .25rem 0 1rem; }
  .row { display: flex; gap: .6rem; align-items: flex-start; padding: .6rem .75rem; border: 1px solid #e5e5e5; border-radius: 8px; margin-bottom: .5rem; cursor: pointer; }
  .row:hover { background: #f7f7f7; } .meta { color: #666; font-size: .85rem; } .goal { color: #444; font-size: .85rem; margin-top: .2rem; }
  .btn { padding: .5rem 1.1rem; border: none; border-radius: 6px; background: #0f6cbd; color: #fff; font: inherit; font-weight: 500; cursor: pointer; margin-top: .75rem; }
  .empty { color: #666; border: 1px dashed #ccc; border-radius: 8px; padding: .75rem; }
</style></head><body>
<h1>Add ${escapeHtml(env.TOOL_NAME)} content to this course</h1>
<p>Each selected tutorial becomes its own activity on the course page, so you can place it right after the lecture it follows. Draft tutorials can be placed now and published later.</p>
<form method="post" action="/api/deeplink?ltik=${encodeURIComponent(ltik)}">
  <label class="row"><input type="checkbox" name="home" value="1"><span><strong>${escapeHtml(env.TOOL_NAME)} home</strong><span class="meta"> · all tutorials, lecture debriefs, profile</span></span></label>
  <h2 style="font-size:1rem;margin:1rem 0 .5rem">Tutorials</h2>
  ${rows || '<div class="empty">No tutorials yet. Open the tool from the course, go to Instructor view, and create one first.</div>'}
  <button class="btn" type="submit">Add selected to course</button>
</form>
</body></html>`);
});

lti.onInvalidToken((req, res) => {
  return res.status(401).send('LTI launch failed: invalid or expired token. Try launching from the course again.');
});

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export { lti };
