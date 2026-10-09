import 'dotenv/config';

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    throw new Error(`Missing required env var: ${name}. Copy .env.example to .env and fill it in.`);
  }
  return v;
}

function optional(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

export const env = {
  LTI_TOOL_URL: required('LTI_TOOL_URL'),
  PORT: parseInt(optional('PORT', '3000'), 10),
  DATABASE_URL: required('DATABASE_URL'),
  LTI_COOKIE_SECRET: required('LTI_COOKIE_SECRET'),
  ANTHROPIC_API_KEY: optional('ANTHROPIC_API_KEY', ''),
  NODE_ENV: optional('NODE_ENV', 'development'),
  TOOL_NAME: optional('TOOL_NAME', 'LTI Tutor'),
  // Out-of-band admin endpoints are disabled when empty.
  ADMIN_TOKEN: optional('ADMIN_TOKEN', ''),
  // Model per function; see .env.example. Prices live in costs.ts.
  TUTOR_MODEL: optional('TUTOR_MODEL', 'claude-haiku-4-5'),
  GEN_MODEL: optional('GEN_MODEL', 'claude-haiku-4-5'),
} as const;

export const isProd = env.NODE_ENV === 'production';
