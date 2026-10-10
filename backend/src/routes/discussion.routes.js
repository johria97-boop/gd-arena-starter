import { Router } from 'express';
import { DiscussionError } from '../engine/discussion.engine.js';
import { classifyEndingIntent } from '../engine/ending-intent.js';
import { GeminiServiceError } from '../services/gemini.service.js';
import { TtsServiceError } from '../services/elevenlabs-tts.service.js';
import { SESSION_STATES } from '../store/sessions.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOPIC_MAX_LENGTH = 300;
const MESSAGE_MAX_LENGTH = 2_000;
const TURN_EVENTS = new Set(['completed', 'cancelled']);
const TTS_RATE_LIMIT = 12;
const TTS_RATE_WINDOW_MS = 60_000;
const MAX_RATE_LIMIT_CLIENTS = 500;
const DEFAULT_DURATION_MINUTES = 5;
const MAX_DURATION_MINUTES = 60;

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

function publicTurn({ turnId, speaker, text, interruption }) {
  return { turnId, speaker, text, ...(interruption ? { interruption } : {}) };
}

function optionalTurnId(value) {
  if (value === undefined || value === null) return null;
  if (!UUID_PATTERN.test(value)) throw new DiscussionError('Invalid turn ID', 400, 'INVALID_TURN_ID');
  return value;
}

function cleanDuration(value) {
  if (value === undefined) return DEFAULT_DURATION_MINUTES;
  if (!Number.isInteger(value) || value < 1 || value > MAX_DURATION_MINUTES) {
    throw new DiscussionError('durationMinutes must be an integer from 1 to 60', 400, 'INVALID_INPUT');
  }
  return value;
}

function createTtsRateLimiter() {
  const clients = new Map();
  return req => {
    const now = Date.now();
    const key = req.ip || 'unknown';
    const recent = (clients.get(key) || []).filter(timestamp => now - timestamp < TTS_RATE_WINDOW_MS);
    if (recent.length >= TTS_RATE_LIMIT) {
      throw new TtsServiceError('Alex custom voice request limit reached', 429, 'ALEX_VOICE_REQUEST_LIMIT');
    }
    recent.push(now);
    clients.set(key, recent);
    while (clients.size > MAX_RATE_LIMIT_CLIENTS) clients.delete(clients.keys().next().value);
  };
}

export function createDiscussionRouter({ sessions, engine, tts }) {
  const router = Router();
  const limitTts = createTtsRateLimiter();

  router.post('/sessions', (req, res) => {
    const topic = cleanRequiredString(req.body?.topic, 'topic', TOPIC_MAX_LENGTH);
    const durationMinutes = cleanDuration(req.body?.durationMinutes);
    const { session, turn } = engine.open(topic, { durationMinutes });
    res.status(201).json({ sessionId: session.id, turn: publicTurn(turn) });
  });

  router.post('/sessions/:id/messages', async (req, res) => {
    const session = findSession(req, sessions);
    const text = cleanRequiredString(req.body?.text, 'text', MESSAGE_MAX_LENGTH);
    const interruptTurnId = optionalTurnId(req.body?.interruptTurnId);
    const intent = classifyEndingIntent(text);
    if (intent === 'end') return res.json(engine.acceptEndingIntent(session, interruptTurnId));
    const turn = interruptTurnId
      ? await engine.interruptAndRespond(session, interruptTurnId, text)
      : await engine.respond(session, text);
    return res.json({ turn: publicTurn(turn) });
  });

  router.post('/sessions/:id/next', async (req, res) => {
    const session = findSession(req, sessions);
    const interruptTurnId = optionalTurnId(req.body?.interruptTurnId);
    const turn = interruptTurnId
      ? await engine.interruptAndRespond(session, interruptTurnId)
      : await engine.respond(session);
    res.json({ turn: publicTurn(turn) });
  });

  router.post('/sessions/:id/turns/:turnId/audio', async (req, res) => {
    const session = findSession(req, sessions);
    if (!UUID_PATTERN.test(req.params.turnId)) {
      throw new DiscussionError('Invalid turn ID', 400, 'INVALID_TURN_ID');
    }
    if (session.state !== SESSION_STATES.SPEAKING || session.activeTurnId !== req.params.turnId) {
      throw new DiscussionError('Turn ID is stale or is not the active turn', 409, 'STALE_TURN_ID');
    }
    const turn = session.transcript.find(item => item.turnId === req.params.turnId);
    if (!turn || turn.speaker !== 'Alex') {
      throw new DiscussionError('Custom audio is available only for active Alex turns', 400, 'ALEX_VOICE_NOT_AVAILABLE');
    }
    limitTts(req);
    const audio = await tts.audioForTurn({ sessionId: session.id, turnId: turn.turnId, text: turn.text });
    res.set({
      'Cache-Control': 'private, no-store',
      'Content-Type': audio.contentType,
      'Content-Length': String(audio.buffer.length),
      'X-Audio-Provider': 'elevenlabs',
    });
    res.send(audio.buffer);
  });

  router.post('/sessions/:id/turns/:turnId/ack', (req, res) => {
    const session = findSession(req, sessions);
    if (!UUID_PATTERN.test(req.params.turnId)) {
      throw new DiscussionError('Invalid turn ID', 400, 'INVALID_TURN_ID');
    }
    if (!TURN_EVENTS.has(req.body?.event)) {
      throw new DiscussionError('event must be completed or cancelled', 400, 'INVALID_TURN_EVENT');
    }
    const result = engine.acknowledge(session, req.params.turnId, req.body.event, {
      includeNextAction: req.body?.requestContinuation === true,
    });
    tts.release(session.id, req.params.turnId);
    res.json(result);
  });

  router.post('/sessions/:id/end', async (req, res) => {
    const session = findSession(req, sessions);
    res.json(await engine.close(session, { cancelPendingTurn: req.body?.cancelPendingTurn === true }));
  });

  router.use((error, _req, res, next) => {
    if (error instanceof DiscussionError || error instanceof GeminiServiceError || error instanceof TtsServiceError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    return next(error);
  });

  return router;
}
