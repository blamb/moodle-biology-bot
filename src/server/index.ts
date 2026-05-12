/**
 * Server entry. Starts ltijs (which owns the Express app and listens on PORT).
 *
 * Order: load env → wire LTI handlers (registering the onConnect callback) →
 * deploy. Database migrations run separately via `npm run db:migrate`.
 */

import { env } from './env.js';
import { lti } from './lti.js';
import { pool } from './db.js';
import './routes.js'; // side-effect: registers /api/* routes on lti.app

async function main(): Promise<void> {
  // Fail fast if Postgres isn't reachable — easier than debugging a half-up
  // server. ltijs's own DB connect will surface a clearer error than ours.
  try {
    await pool.query('select 1');
  } catch (e) {
    console.error('FATAL: cannot reach Postgres at DATABASE_URL.');
    console.error(`       ${(e as Error).message}`);
    console.error('       Did you run `docker compose up -d postgres`?');
    process.exit(1);
  }

  await lti.deploy({ port: env.PORT });

  // One-line diagnostic so we can confirm env vars made it to the running
  // process. Useful when the admin endpoint reports "disabled" despite the
  // variable being set in the dashboard.
  console.log(
    `[env] ANTHROPIC_API_KEY=${env.ANTHROPIC_API_KEY ? 'set(' + env.ANTHROPIC_API_KEY.length + ')' : 'MISSING'}` +
    `  ADMIN_TOKEN=${env.ADMIN_TOKEN ? 'set(' + env.ADMIN_TOKEN.length + ')' : 'MISSING'}` +
    `  NODE_ENV=${env.NODE_ENV}` +
    `  raw_ADMIN_TOKEN_in_process_env=${process.env.ADMIN_TOKEN ? 'present(' + process.env.ADMIN_TOKEN.length + ')' : 'absent'}`
  );

  console.log(`\nMoodle Biology Bot is live`);
  console.log(`  Local:   http://localhost:${env.PORT}`);
  console.log(`  Public:  ${env.LTI_TOOL_URL}`);
  console.log(`  Login:   ${env.LTI_TOOL_URL}/login`);
  console.log(`  Keyset:  ${env.LTI_TOOL_URL}/keys`);
  console.log(``);
  console.log(`Now run the tunnel in another window:`);
  console.log(`  ~/Downloads/ngrok http --domain=${new URL(env.LTI_TOOL_URL).host} ${env.PORT}`);
}

main().catch((e) => {
  console.error('Server crashed during startup:', e);
  process.exit(1);
});
