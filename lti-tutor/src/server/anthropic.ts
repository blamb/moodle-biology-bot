/**
 * Lazily constructed Anthropic client so the server can start without a key
 * (LTI-only smoke tests). The SDK retries 408/409/429/5xx (incl. 529 overload)
 * with backoff; the timeout is tightened so a hung request doesn't leave a
 * student waiting indefinitely.
 */

import Anthropic from '@anthropic-ai/sdk';
import { env } from './env.js';

let client: Anthropic | null = null;

export function getAnthropic(): Anthropic {
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set. Add it to .env to use the tutor.');
  }
  if (!client) {
    client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 5, timeout: 90_000 });
  }
  return client;
}

export const TUTOR_MODEL = env.TUTOR_MODEL;
export const GEN_MODEL = env.GEN_MODEL;
