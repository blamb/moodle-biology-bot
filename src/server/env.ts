import 'dotenv/config';

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    throw new Error(
      `Missing required env var: ${name}. Copy .env.example to .env and fill it in.`
    );
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
  // Admin-only access token for /admin/* operational endpoints (e.g. cost
  // dashboard). When empty, those endpoints are disabled. Generate via:
  //   openssl rand -hex 32
  ADMIN_TOKEN: optional('ADMIN_TOKEN', ''),

  // Model selection per AI function, overridable without a code change so cost
  // vs quality can be tuned from the Railway dashboard. Defaults are Haiku 4.5
  // ($1/$5 per 1M) across the board for the cheapest run. Dial an individual
  // function up to a stronger model (e.g. claude-opus-4-8, claude-sonnet-4-6)
  // if its quality drops. Any price added here must also be added to
  // MODEL_PRICES in costs.ts or its cost records as 0.
  GEN_MODEL: optional('GEN_MODEL', 'claude-haiku-4-5'),        // question gen + coaching feedback
  TUTOR_MODEL: optional('TUTOR_MODEL', 'claude-haiku-4-5'),    // Socratic tutor chat
  GRADER_MODEL: optional('GRADER_MODEL', 'claude-haiku-4-5'),  // free-response grading
} as const;

export const isProd = env.NODE_ENV === 'production';
