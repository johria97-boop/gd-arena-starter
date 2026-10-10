import { randomUUID } from 'node:crypto';

const DEFAULT_TTL_MS = 60 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 500;
const DEFAULT_MAX_TURNS = 100;
export const DEFAULT_DISCUSSION_DURATION_MS = 5 * 60 * 1000;

export const SESSION_STATES = Object.freeze({
  READY: 'READY',
  GENERATING: 'GENERATING',
  SPEAKING: 'SPEAKING',
  LISTENING: 'LISTENING',
  ENDED: 'ENDED',
});

export class SessionStore {
  constructor({ ttlMs = DEFAULT_TTL_MS, maxSessions = DEFAULT_MAX_SESSIONS, maxTurns = DEFAULT_MAX_TURNS, defaultDurationMs = DEFAULT_DISCUSSION_DURATION_MS, now = Date.now } = {}) {
    this.sessions = new Map();
    this.ttlMs = ttlMs;
    this.maxSessions = maxSessions;
    this.maxTurns = maxTurns;
    this.defaultDurationMs = defaultDurationMs;
    this.now = now;
  }

  create(topic, { durationMs = this.defaultDurationMs } = {}) {
    this.cleanup();
    while (this.sessions.size >= this.maxSessions) this.evictOldest();
    const now = this.now();
    const session = {
      id: randomUUID(),
      topic,
      state: SESSION_STATES.READY,
      turnCounter: 0,
      aiTurnCount: 0,
      aiOnlyTurnCount: 0,
      turnsSinceAiInterruption: 3,
      pendingAiInterruptionTurnId: null,
      transcript: [],
      activeTurnId: null,
      turnEvents: new Map(),
      report: null,
      evaluationPromise: null,
      generationPromise: null,
      endingPromise: null,
      endRequested: false,
      deadlineAt: now + durationMs,
      deadlineTimer: null,
      createdAt: now,
      lastAccessedAt: now,
      expiresAt: now + this.ttlMs,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  get(id) {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    if (session.expiresAt <= this.now()) {
      this.dispose(session);
      this.sessions.delete(id);
      return undefined;
    }
    session.lastAccessedAt = this.now();
    return session;
  }

  appendTurn(session, speaker, text) {
    session.turnCounter += 1;
    const turn = {
      turnId: randomUUID(),
      speaker,
      text,
      timestamp: new Date(this.now()).toISOString(),
    };
    session.transcript.push(turn);
    if (session.transcript.length > this.maxTurns) {
      session.transcript.splice(0, session.transcript.length - this.maxTurns);
    }
    return turn;
  }

  removeTurn(session, turnId) {
    const index = session.transcript.findIndex(turn => turn.turnId === turnId);
    if (index !== -1) session.transcript.splice(index, 1);
  }

  recordTurnEvent(session, turnId, event) {
    session.turnEvents.set(turnId, event);
    while (session.turnEvents.size > this.maxTurns) {
      session.turnEvents.delete(session.turnEvents.keys().next().value);
    }
  }

  cleanup() {
    const now = this.now();
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= now) {
        this.dispose(session);
        this.sessions.delete(id);
      }
    }
  }

  evictOldest() {
    let oldest;
    for (const session of this.sessions.values()) {
      if (!oldest || session.lastAccessedAt < oldest.lastAccessedAt) oldest = session;
    }
    if (oldest) {
      this.dispose(oldest);
      this.sessions.delete(oldest.id);
    }
  }

  dispose(session) {
    if (session.deadlineTimer) clearTimeout(session.deadlineTimer);
    session.deadlineTimer = null;
  }
}
