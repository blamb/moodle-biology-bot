/**
 * Thin wrapper around @anthropic-ai/sdk. Constructs the client lazily so the
 * server can start without an API key (you only need one to actually use the
 * tutor / question generators — useful for LTI-only smoke tests).
 */

import Anthropic from '@anthropic-ai/sdk';
import { env } from './env.js';

let client: Anthropic | null = null;

export function getAnthropic(): Anthropic {
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set. Add it to .env to use AI features.'
    );
  }
  if (!client) {
    client = new Anthropic({
      apiKey: env.ANTHROPIC_API_KEY,
      // Default is 2 retries; bump to handle intermittent 529 overload
      // responses from Anthropic's API. The SDK retries connection errors,
      // 408, 409, 429, and 5xx (including 529) with exponential backoff.
      maxRetries: 5,
      // Default timeout is 10 minutes; tighten to 90s so a hung request
      // doesn't leave the student waiting indefinitely.
      timeout: 90_000,
    });
  }
  return client;
}

// Default model for tutor + grading. Cheap-and-fast model for question gen
// is wired separately in the generator code.
export const TUTOR_MODEL = 'claude-opus-4-7';
export const GEN_MODEL = 'claude-sonnet-4-6';
