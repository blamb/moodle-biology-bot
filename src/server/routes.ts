/**
 * Post-launch API routes — all guarded by ltijs's session validator middleware
 * (because they hang off lti.app). On each request, res.locals.token has the
 * validated LTI claims.
 *
 *   GET  /api/units                         List all units with summary metadata
 *   POST /api/tutor/session                 { unit_no } -> { session, turns }
 *   POST /api/tutor/turn                    { session_id, message } -> SSE stream
 */

import express from 'express';
import type { Request, Response } from 'express';
import type { IdToken } from 'ltijs';
import { lti } from './lti.js';
import { query } from './db.js';
import { listUnits } from './content.js';
import { findOrCreateStudent } from './students.js';
import {
  getOrCreateActiveSession,
  getTurns,
  streamSocraticReply,
} from './tutor.js';

// ltijs doesn't install a JSON body parser globally; do it for our routes.
lti.app.use('/api', express.json({ limit: '256kb' }));

function tokenOf(res: Response): IdToken {
  const token = res.locals.token as IdToken | undefined;
  if (!token) throw new Error('No LTI token on request (middleware bug?)');
  return token;
}

async function studentFromToken(token: IdToken) {
  return findOrCreateStudent({
    sub: token.user,
    iss: token.iss,
    contextId: token.platformContext.contextId,
    displayName:
      token.userInfo.name ||
      [token.userInfo.given_name, token.userInfo.family_name].filter(Boolean).join(' ') ||
      'Student',
  });
}

lti.app.get('/api/units', (req: Request, res: Response) => {
  res.json({ units: listUnits() });
});

lti.app.post('/api/tutor/session', async (req: Request, res: Response) => {
  try {
    const token = tokenOf(res);
    const student = await studentFromToken(token);
    const unitNo = parseInt(String(req.body?.unit_no ?? ''), 10);
    if (!Number.isInteger(unitNo) || unitNo < 1 || unitNo > 17) {
      return res.status(400).json({ error: 'unit_no must be an integer 1–17' });
    }
    const session = await getOrCreateActiveSession(student.id, unitNo);
    const turns = await getTurns(session.id);
    res.json({ session, turns });
  } catch (e) {
    console.error('POST /api/tutor/session failed:', e);
    res.status(500).json({ error: (e as Error).message });
  }
});

lti.app.post('/api/tutor/turn', async (req: Request, res: Response) => {
  // Establish SSE headers BEFORE awaiting anything — fail fast if the client
  // has disconnected. Also flush headers so the browser shows progress UI.
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const send = (event: string, data: unknown): void => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const token = tokenOf(res);
    const student = await studentFromToken(token);
    const sessionId = parseInt(String(req.body?.session_id ?? ''), 10);
    const message = String(req.body?.message ?? '').trim();
    if (!Number.isInteger(sessionId)) {
      send('error', { message: 'session_id is required' });
      return res.end();
    }
    if (!message) {
      send('error', { message: 'message is required' });
      return res.end();
    }

    // Look up the session directly to verify ownership + pull unit_no.
    const rows = await query<{
      id: number;
      student_id: number;
      unit_no: number;
      ended_at: string | null;
    }>(
      `select id, student_id, unit_no, ended_at from session where id=$1 and kind='tutor'`,
      [sessionId]
    );
    if (!rows.length || rows[0]!.student_id !== student.id) {
      send('error', { message: 'session not found' });
      return res.end();
    }
    const sessionRow = rows[0]!;

    const displayName = student.display_name;

    await streamSocraticReply({
      session: {
        id: sessionRow.id,
        student_id: sessionRow.student_id,
        unit_no: sessionRow.unit_no,
        kind: 'tutor',
        started_at: '',
        ended_at: sessionRow.ended_at,
      },
      userMessage: message,
      displayName,
      onChunk: (text) => send('chunk', { text }),
    });

    send('done', {});
    res.end();
  } catch (e) {
    console.error('POST /api/tutor/turn failed:', e);
    send('error', { message: (e as Error).message });
    res.end();
  }
});
