/**
 * Role detection from LTI claims.
 *
 * Moodle (and most platforms) send roles as IMS Global URIs:
 *   http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor
 *   http://purl.imsglobal.org/vocab/lis/v2/institution/person#Administrator
 *   http://purl.imsglobal.org/vocab/lis/v2/system/person#SysAdmin
 *   http://purl.imsglobal.org/vocab/lis/v2/membership#Learner
 *   ...
 *
 * We pattern-match the role identifier suffix (case-insensitive) so this works
 * across full URIs and short forms.
 */

import type { IdToken } from 'ltijs';

const TEACHER_ROLE_KEYWORDS = [
  'instructor',
  'administrator',
  'sysadmin',
  'contentdeveloper',
  'teachingassistant',
  'staff',
];

export function isTeacher(token: IdToken): boolean {
  const roles = token.platformContext?.roles ?? [];
  return roles.some((r) => {
    const lower = String(r).toLowerCase();
    return TEACHER_ROLE_KEYWORDS.some((k) => lower.includes(k));
  });
}

export function requireTeacher(token: IdToken): void {
  if (!isTeacher(token)) {
    throw new TeacherOnlyError();
  }
}

export class TeacherOnlyError extends Error {
  constructor(message = 'This view is only available to instructors.') {
    super(message);
    this.name = 'TeacherOnlyError';
  }
}
