/**
 * Server entry. Loads env, wires LTI handlers and routes, deploys ltijs
 * (which owns the Express app). Migrations run via `npm run db:migrate`
 * (and before `npm start` in production).
 */

import { env } from './env.js';
import { lti } from './lti.js';
import { pool } from './db.js';
import './routes.js'; // side-effect: registers /api/* routes on lti.app

async function main(): Promise<void> {
  try {
    await pool.query('select 1');
  } catch (e) {
    console.error('FATAL: cannot reach Postgres at DATABASE_URL.');
    console.error(`       ${(e as Error).message}`);
    process.exit(1);
  }

  await lti.deploy({ port: env.PORT });

  console.log(
    `[env] ANTHROPIC_API_KEY=${env.ANTHROPIC_API_KEY ? 'set' : 'MISSING'}` +
      `  ADMIN_TOKEN=${env.ADMIN_TOKEN ? 'set' : 'MISSING'}  NODE_ENV=${env.NODE_ENV}` +
      `  TUTOR_MODEL=${env.TUTOR_MODEL}  GEN_MODEL=${env.GEN_MODEL}`
  );
  console.log(`\n${env.TOOL_NAME} is live`);
  console.log(`  Local:     http://localhost:${env.PORT}`);
  console.log(`  Public:    ${env.LTI_TOOL_URL}`);
  console.log(`  Register:  ${env.LTI_TOOL_URL}/register   (Moodle: Manage tools → Dynamic registration)`);
  console.log(`  Keyset:    ${env.LTI_TOOL_URL}/keys\n`);
}

main().catch((e) => {
  console.error('Server crashed during startup:', e);
  process.exit(1);
});
