/**
 * Request-context helpers for route modules: pull the validated LTI token
 * off the response, resolve the launching user to a student row, build
 * cost-tracking attribution, and gate instructor-only routes.
 */

import type { Response } from 'express';
import type { IdToken } from 'ltijs';
import { findOrCreateStudent, type Student } from './students.js';
import { isTeacher } from './auth.js';
import type { Attribution } from './costs.js';

export function tokenOf(res: Response): IdToken {
  const token = res.locals.token as IdToken | undefined;
  if (!token) throw new Error('No LTI token on request (middleware bug?)');
  return token;
}

/** The pure LTI course id — not ltijs's compound contextId, which varies per activity. */
export function contextIdOf(token: IdToken): string {
  return token.platformContext.context?.id ?? token.platformContext.contextId;
}

export async function studentFromToken(token: IdToken): Promise<Student> {
  return findOrCreateStudent({
    sub: token.user,
    iss: token.iss,
    contextId: contextIdOf(token),
    displayName:
      token.userInfo.name ||
      [token.userInfo.given_name, token.userInfo.family_name].filter(Boolean).join(' ') ||
      'Student',
  });
}

export function attr(
  token: IdToken,
  studentId: number | null,
  sessionId: number | null,
  endpoint: string
): Attribution {
  return {
    studentId,
    sessionId,
    iss: token.iss,
    contextId: contextIdOf(token),
    endpoint,
  };
}

/** Returns the token for an instructor launch, or sends 403 and returns null. */
export function gateTeacher(res: Response): IdToken | null {
  const token = tokenOf(res);
  if (!isTeacher(token)) {
    res.status(403).json({ error: 'This view is only available to instructors.' });
    return null;
  }
  return token;
}
