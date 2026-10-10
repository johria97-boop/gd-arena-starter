import { Router } from 'express';
import { DiscussionError } from '../engine/discussion.engine.js';
import { GeminiServiceError } from '../services/gemini.service.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOPIC_MAX_LENGTH = 300;
const MESSAGE_MAX_LENGTH = 2_000;
const TURN_EVENTS = new Set(['completed', 'cancelled']);

function cleanRequiredString(value, field, maxLength) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new DiscussionError(`${field} must be a non-empty string`, 400, 'INVALID_INPUT');
  }
  const cleaned = value.trim();
  if (cleaned.length > maxLength) {
    throw new DiscussionError(`${field} must be at most ${maxLength} characters`, 400, 'INVALID_INPUT');
  }
  return cleaned;
}

function findSession(req, sessions) {
  if (!UUID_PATTERN.test(req.params.id)) {
    throw new DiscussionError('Invalid session ID', 400, 'INVALID_SESSION_ID');
  }
  const session = sessions.get(req.params.id);
  if (!session) throw new DiscussionError('Session not found or expired', 404, 'SESSION_NOT_FOUND');
  return session;
}

function publicTurn({ turnId, speaker, text }) {
  return { turnId, speaker, text };
}

export function createDiscussionRouter({ sessions, engine }) {
  const router = Router();

  router.post('/sessions', (req, res) => {
    const topic = cleanRequiredString(req.body?.topic, 'topic', TOPIC_MAX_LENGTH);
    const { session, turn } = engine.open(topic);
    res.status(201).json({ sessionId: session.id, turn: publicTurn(turn) });
  });

  router.post('/sessions/:id/messages', async (req, res) => {
    const session = findSession(req, sessions);
    const text = cleanRequiredString(req.body?.text, 'text', MESSAGE_MAX_LENGTH);
    const turn = await engine.respond(session, text);
    res.json({ turn: publicTurn(turn) });
  });

  router.post('/sessions/:id/next', async (req, res) => {
    const session = findSession(req, sessions);
    const turn = await engine.respond(session);
    res.json({ turn: publicTurn(turn) });
  });

  router.post('/sessions/:id/turns/:turnId/ack', (req, res) => {
    const session = findSession(req, sessions);
    if (!UUID_PATTERN.test(req.params.turnId)) {
      throw new DiscussionError('Invalid turn ID', 400, 'INVALID_TURN_ID');
    }
    if (!TURN_EVENTS.has(req.body?.event)) {
      throw new DiscussionError('event must be completed or cancelled', 400, 'INVALID_TURN_EVENT');
    }
    res.json(engine.acknowledge(session, req.params.turnId, req.body.event));
  });

  router.post('/sessions/:id/end', async (req, res) => {
    const session = findSession(req, sessions);
    res.json(await engine.close(session));
  });

  router.use((error, _req, res, next) => {
    if (error instanceof DiscussionError || error instanceof GeminiServiceError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    return next(error);
  });

  return router;
}
