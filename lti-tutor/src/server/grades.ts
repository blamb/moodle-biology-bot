/**
 * LTI Assignment & Grade Services (AGS) — post tutorial completion to the
 * Moodle gradebook. Best-effort: a failure is recorded on the tutorial_session
 * row and never blocks the student's flow.
 *
 * Which gradebook column receives the score:
 *   1. If the student launched a deep-linked tutorial activity (custom
 *      tutorial_id matches) and Moodle sent that activity's own line item, use
 *      it — that is the activity's grade column.
 *   2. Otherwise, if the tutorial has `gradebook` on and the platform grants
 *      line-item scope, find or create a column tagged for this tutorial.
 *   3. Otherwise, do nothing.
 *
 * Completion is scored 1/1. Mastery is feedback, not a grade — the tutorial's
 * value is doing it, as in Paski, so we post completion and leave the
 * summary for the instructor's report.
 */

import type { IdToken } from 'ltijs';
import { lti } from './lti.js';
import { env } from './env.js';
import type { Tutorial } from './tutorials.js';

export interface GradeResult {
  posted: boolean;
  error?: string;
}

export async function postCompletionGrade(
  token: IdToken,
  tutorial: Tutorial
): Promise<GradeResult> {
  const endpoint = token.platformContext.endpoint;
  if (!endpoint) return { posted: false, error: 'Platform did not grant grade services on this launch.' };

  try {
    let lineItemId: string | null = null;
    const launchedTutorialId = String(token.platformContext.custom?.tutorial_id ?? '');
    if (endpoint.lineitem && launchedTutorialId === String(tutorial.id)) {
      lineItemId = endpoint.lineitem;
    } else if (tutorial.gradebook && endpoint.lineitems) {
      const resourceId = `tutorial-${tutorial.id}`;
      const found = await lti.Grade.getLineItems(token, { resourceId });
      const match = found.lineItems.find((li) => li.resourceId === resourceId);
      if (match) {
        lineItemId = match.id;
      } else {
        const created = await lti.Grade.createLineItem(token, {
          scoreMaximum: 1,
          label: `Tutorial: ${tutorial.title}`,
          resourceId,
          tag: 'tutorial',
        });
        lineItemId = created.id;
      }
    }
    if (!lineItemId) {
      return { posted: false, error: 'No gradebook column for this tutorial (gradebook posting is off).' };
    }
    await lti.Grade.submitScore(token, lineItemId, {
      userId: token.user,
      scoreGiven: 1,
      scoreMaximum: 1,
      activityProgress: 'Completed',
      gradingProgress: 'FullyGraded',
      comment: `Completed tutorial "${tutorial.title}" in ${env.TOOL_NAME}.`,
    });
    return { posted: true };
  } catch (e) {
    const msg = (e as Error).message || String(e);
    console.warn(`grades: could not post completion for tutorial ${tutorial.id}: ${msg}`);
    return { posted: false, error: msg.slice(0, 500) };
  }
}
