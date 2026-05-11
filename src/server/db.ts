import { Pool } from 'pg';
import { env } from './env.js';

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
});

export async function query<T = unknown>(
  text: string,
  params: unknown[] = []
): Promise<T[]> {
  const result = await pool.query(text, params as never[]);
  return result.rows as T[];
}

export async function close(): Promise<void> {
  await pool.end();
}
