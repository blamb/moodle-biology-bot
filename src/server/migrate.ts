/**
 * Trivial migration runner. Applies every .sql file in ./migrations in name
 * order, once. Idempotent: skips files already recorded in the _migration table.
 *
 * Run: `npm run db:migrate`
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, query, close } from './db.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, 'migrations');

async function ensureMigrationsTable(): Promise<void> {
  await pool.query(`
    create table if not exists _migration (
      name        text        primary key,
      applied_at  timestamptz not null default now()
    )
  `);
}

async function appliedNames(): Promise<Set<string>> {
  const rows = await query<{ name: string }>(`select name from _migration`);
  return new Set(rows.map((r) => r.name));
}

async function run(): Promise<void> {
  console.log(`migrate: scanning ${MIGRATIONS_DIR}`);

  try {
    await ensureMigrationsTable();
  } catch (e) {
    console.error(`migrate: cannot reach DB — ${(e as Error).message}`);
    console.error(`         is Postgres running?  (docker compose up -d postgres)`);
    process.exit(1);
  }

  const applied = await appliedNames();
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  let n = 0;
  for (const file of files) {
    if (applied.has(file)) {
      console.log(`  skip  ${file}  (already applied)`);
      continue;
    }
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    console.log(`  apply ${file}`);
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query(`insert into _migration (name) values ($1)`, [file]);
      await client.query('commit');
      n++;
    } catch (e) {
      await client.query('rollback');
      console.error(`migrate: FAILED on ${file}: ${(e as Error).message}`);
      process.exit(1);
    } finally {
      client.release();
    }
  }

  console.log(`migrate: applied ${n} new migration(s); ${applied.size + n} total`);
  await close();
}

run();
