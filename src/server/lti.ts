/**
 * LTI 1.3 provider setup. Uses the ltijs library plus the Sequelize-backed
 * Postgres plugin so platform/token state lives in the same DB cluster as the
 * app's own tables (students, sessions, progress).
 *
 * The cookie config (sameSite=None + secure) is required because the launch
 * iframe is on the ngrok HTTPS origin while Moodle dev runs on
 * http://localhost:8080 — that's cross-site from the browser's POV.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ltijs, { type IdToken } from 'ltijs';
import Database from 'ltijs-sequelize';

const { Provider: lti } = ltijs;
import { URL } from 'node:url';
import { env } from './env.js';
import { findOrCreateStudent } from './students.js';
import { listUnits } from './content.js';
import { isTeacher } from './auth.js';
import { renderAdminCostsHtml } from './admin.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const LAUNCH_HTML_PATH = join(HERE, '..', 'web', 'launch.html');

// In dev we re-read on every launch so HTML edits show up without restarting
// the Node server. In prod we'd cache.
const isDev = (process.env.NODE_ENV ?? 'development') !== 'production';
let _launchHtmlCache: string | null = null;
function loadLaunchHtml(): string {
  if (isDev) return readFileSync(LAUNCH_HTML_PATH, 'utf8');
  if (!_launchHtmlCache) _launchHtmlCache = readFileSync(LAUNCH_HTML_PATH, 'utf8');
  return _launchHtmlCache;
}

// One Postgres instance, two logical "uses": ltijs tables get auto-created by
// ltijs-sequelize; our migrations create the rest.
// Parse all connection bits from DATABASE_URL so dev (docker-compose) and prod
// (Railway random creds) both work without code changes.
const dbUrl = new URL(env.DATABASE_URL);
const ltiDb = new Database(
  decodeURIComponent(dbUrl.pathname.replace(/^\//, '')) || 'biology_bot',
  decodeURIComponent(dbUrl.username || 'postgres'),
  decodeURIComponent(dbUrl.password || ''),
  {
    host: dbUrl.hostname || 'localhost',
    port: parseInt(dbUrl.port || '5432', 10),
    dialect: 'postgres',
    logging: false,
    // Railway's managed Postgres typically needs SSL; toggle via ?sslmode=
    // in the URL. For local docker-compose Postgres, leave SSL off.
    dialectOptions: /sslmode=require/i.test(env.DATABASE_URL)
      ? { ssl: { require: true, rejectUnauthorized: false } }
      : undefined,
  }
);

lti.setup(
  env.LTI_COOKIE_SECRET,
  { plugin: ltiDb },
  {
    cookies: {
      secure: true, // cookies issued on the ngrok HTTPS origin
      sameSite: 'None', // required for cross-site iframe launch
    },
    devMode: false, // we ARE on HTTPS via ngrok, so leave this off
    // Routes default to: appRoute='/', loginRoute='/login', keysetRoute='/keys',
    // dynRegRoute='/register'.
    dynReg: {
      url: env.LTI_TOOL_URL,
      name: 'Biology Bot',
      description:
        'AI tutor and practice-question generator for Human A&P (BIOL 1592 / 1692)',
      redirectUris: [env.LTI_TOOL_URL],
      autoActivate: true,
    },
    // Mounted before ltijs's session validator, so /admin/* routes bypass LTI
    // auth and use the ADMIN_TOKEN env var for access control instead. Used
    // for operational dashboards that should NOT be visible to teachers or
    // students inside Moodle.
    serverAddon: (server) => {
      // Unauthenticated liveness + deploy-version probe. Mounted before the
      // LTI session validator so a plain `curl https://…/healthz` works with no
      // launch token. Reports the commit Railway built so you can confirm a
      // push went live: `curl -s https://…/healthz | jq .commit`. Does no DB
      // work, so it stays green even if Postgres is down.
      server.get('/healthz', (_req, res) => {
        const sha = process.env.RAILWAY_GIT_COMMIT_SHA || 'unknown';
        res.json({
          status: 'ok',
          commit: sha,
          commit_short: sha === 'unknown' ? 'unknown' : sha.slice(0, 7),
          branch: process.env.RAILWAY_GIT_BRANCH || 'unknown',
          env: process.env.NODE_ENV || 'development',
          uptime_s: Math.round(process.uptime()),
        });
      });

      server.get('/admin/costs', async (req, res) => {
        if (!env.ADMIN_TOKEN) {
          return res.status(503).type('text').send(
            'Admin endpoints are disabled. Set ADMIN_TOKEN in environment vars to enable.'
          );
        }
        const supplied = (req.query.token as string) || req.headers['x-admin-token'];
        if (supplied !== env.ADMIN_TOKEN) {
          return res.status(401).type('text').send('Unauthorized');
        }
        try {
          const html = await renderAdminCostsHtml();
          res.type('html').send(html);
        } catch (e) {
          console.error('GET /admin/costs failed:', e);
          res.status(500).type('text').send('Error: ' + (e as Error).message);
        }
      });
    },
  }
);

/**
 * Fired on a successful LTI launch. At this point ltijs has validated the
 * JWT, established a session cookie, and `token` carries the platform's claims.
 */
lti.onConnect(async (token: IdToken, req, res) => {
  const student = await findOrCreateStudent({
    sub: token.user,
    iss: token.iss,
    // Use the pure LTI context.id (course) — NOT ltijs's contextId which mixes
    // in resource_link_id and hashes, giving a different id per activity instance.
    // Falls back to ltijs's contextId only if context.id is somehow missing.
    contextId: token.platformContext.context?.id ?? token.platformContext.contextId,
    displayName:
      token.userInfo.name ||
      [token.userInfo.given_name, token.userInfo.family_name].filter(Boolean).join(' ') ||
      'Student',
  });

  // Render the unit-picker list. Each <li> carries data-unit-no / data-unit-title
  // so the client-side JS can wire up click handlers against the rendered DOM.
  const units = listUnits();
  const unitsList = units
    .map((u) => {
      const titleAttr = escapeHtml(u.title);
      const metaParts: string[] = [`${u.terms_count} terms`];
      if (u.has_textbook) metaParts.push('textbook ✓');
      return (
        `<li data-unit-no="${u.unit_no}" data-unit-title="${titleAttr}">` +
        `<span><span class="unit-no">Unit ${u.unit_no}</span> ` +
        `<span class="unit-title">${titleAttr}</span></span>` +
        `<span class="unit-meta">${metaParts.join(' · ')}</span>` +
        `</li>`
      );
    })
    .join('\n');

  const ctxTitle = token.platformContext.context?.title || '';
  const role = isTeacher(token) ? 'teacher' : 'student';
  const html = loadLaunchHtml()
    .replace('{{DISPLAY_NAME}}', escapeHtml(student.display_name))
    .replace('{{PLATFORM_NAME}}', escapeHtml(token.platformInfo.name || 'Unknown platform'))
    .replace('{{CONTEXT_TITLE_SEP}}', ctxTitle ? ' — ' : '')
    .replace('{{CONTEXT_TITLE}}', escapeHtml(ctxTitle))
    .replace('{{ROLES}}', escapeHtml((token.platformContext.roles || []).join(', ')))
    .replace('{{ROLE}}', role)
    .replace('{{UNITS_LIST}}', unitsList)
    .replace('{{UNIT_COUNT}}', String(units.length));

  return res.send(html);
});

lti.onInvalidToken((req, res) => {
  // ltijs calls this with just (req, res) — different from onConnect's signature.
  return res
    .status(401)
    .send('LTI launch failed: invalid or expired token. Try launching from Moodle again.');
});

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export { lti };
