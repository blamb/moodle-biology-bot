import pg from 'pg';
import { env } from './env.js';

// Postgres bigint (int8) and bigint[] come back as strings by default. Every
// id in this schema is a bigserial that fits comfortably in a JS number, and
// ids are compared against numbers from request bodies, so parse them.
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1016 as unknown as Parameters<typeof pg.types.setTypeParser>[0], (v: string) =>
  v === '{}' ? [] : v.replace(/^\{|\}$/g, '').split(',').map((x) => Number(x))
);

export const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 10 });

export async function query<T = unknown>(text: string, params: unknown[] = []): Promise<T[]> {
  const result = await pool.query(text, params as never[]);
  return result.rows as T[];
}

export async function close(): Promise<void> {
  await pool.end();
}
