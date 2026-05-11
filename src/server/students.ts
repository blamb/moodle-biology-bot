import { query } from './db.js';

export interface Student {
  id: number;
  lti_sub: string;
  lti_iss: string;
  lti_context_id: string;
  display_name: string;
  created_at: string;
}

export async function findOrCreateStudent(params: {
  sub: string;
  iss: string;
  contextId: string;
  displayName: string;
}): Promise<Student> {
  // ON CONFLICT DO UPDATE keeps the display name fresh if it changed in Moodle.
  const rows = await query<Student>(
    `insert into student (lti_sub, lti_iss, lti_context_id, display_name)
     values ($1, $2, $3, $4)
     on conflict (lti_sub, lti_iss, lti_context_id)
     do update set display_name = excluded.display_name
     returning *`,
    [params.sub, params.iss, params.contextId, params.displayName]
  );
  return rows[0]!;
}
