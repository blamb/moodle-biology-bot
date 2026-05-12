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

const HERE = dirname(fileURLToPath(import.meta.url));
const LAUNCH_HTML = readFileSync(join(HERE, '..', 'web', 'launch.html'), 'utf8');

// One Postgres instance, two logical "uses": ltijs tables get auto-created by
// ltijs-sequelize; our migrations create the rest.
const ltiDb = new Database('biology_bot', 'postgres', 'postgres', {
  host: new URL(env.DATABASE_URL).hostname || 'localhost',
  port: parseInt(new URL(env.DATABASE_URL).port || '5432', 10),
  dialect: 'postgres',
  logging: false,
});

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
    contextId: token.platformContext.contextId,
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
  const html = LAUNCH_HTML
    .replace('{{DISPLAY_NAME}}', escapeHtml(student.display_name))
    .replace('{{PLATFORM_NAME}}', escapeHtml(token.platformInfo.name || 'Unknown platform'))
    .replace('{{CONTEXT_TITLE_SEP}}', ctxTitle ? ' — ' : '')
    .replace('{{CONTEXT_TITLE}}', escapeHtml(ctxTitle))
    .replace('{{ROLES}}', escapeHtml((token.platformContext.roles || []).join(', ')))
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
