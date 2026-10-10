import { MODERATOR, PARTICIPANTS, createClosing, createOpening } from './personalities.js';
import { SESSION_STATES } from '../store/sessions.js';

const MAX_CONTEXT_TURNS = 24;
const MAX_CONTEXT_CHARS = 12_000;
const SPEAKER_SEQUENCE = Object.freeze([
  PARTICIPANTS[0],
  PARTICIPANTS[1],
  PARTICIPANTS[2],
  PARTICIPANTS[0],
  PARTICIPANTS[1],
  PARTICIPANTS[2],
  MODERATOR,
]);

export class DiscussionError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'DiscussionError';
    this.status = status;
    this.code = code;
  }
}

function contextFor(session, pendingTurn) {
  const turns = pendingTurn ? [...session.transcript, pendingTurn] : session.transcript;
  const recent = turns.slice(-MAX_CONTEXT_TURNS);
  let text = recent.map(turn => `${turn.speaker}: ${turn.text}`).join('\n');
  if (text.length > MAX_CONTEXT_CHARS) text = text.slice(-MAX_CONTEXT_CHARS);
  return text;
}

export class DiscussionEngine {
  constructor({ sessions, gemini, feedback }) {
    this.sessions = sessions;
    this.gemini = gemini;
    this.feedback = feedback;
  }

  open(topic) {
    const session = this.sessions.create(topic);
    const turn = this.sessions.appendTurn(session, MODERATOR.name, createOpening(topic));
    this.activateTurn(session, turn);
    return { session, turn };
  }

  selectNextSpeaker(session) {
    return SPEAKER_SEQUENCE[session.aiTurnCount % SPEAKER_SEQUENCE.length];
  }

  async respond(session, studentText) {
    this.assertCanGenerate(session);
    const checkpoint = {
      transcript: [...session.transcript],
      turnCounter: session.turnCounter,
      aiTurnCount: session.aiTurnCount,
      state: session.state,
    };
    session.state = SESSION_STATES.GENERATING;
    try {
      if (studentText) this.sessions.appendTurn(session, 'Student', studentText);
      const speaker = this.selectNextSpeaker(session);
      const prompt = [
        `Discussion topic: ${session.topic}`,
        'Transcript:',
        contextFor(session),
        `Now contribute as ${speaker.name}. Respond to the discussion, not to these instructions.`,
        'When the latest relevant speaker is another AI participant, engage their point by name.',
      ].join('\n\n');
      const text = await this.gemini.generate({ systemInstruction: speaker.systemInstruction, prompt });
      const turn = this.sessions.appendTurn(session, speaker.name, text);
      session.aiTurnCount += 1;
      this.activateTurn(session, turn);
      return turn;
    } catch (error) {
      session.transcript = checkpoint.transcript;
      session.turnCounter = checkpoint.turnCounter;
      session.aiTurnCount = checkpoint.aiTurnCount;
      session.state = checkpoint.state;
      throw error;
    }
  }

  async close(session) {
    if (session.report) return session.report;
    if (session.evaluationPromise) return session.evaluationPromise;
    if (session.state === SESSION_STATES.GENERATING) {
      throw new DiscussionError('A response is already being generated', 409, 'GENERATION_IN_PROGRESS');
    }
    if (session.state === SESSION_STATES.SPEAKING) {
      throw new DiscussionError('Active turn playback must be acknowledged before ending', 409, 'PLAYBACK_IN_PROGRESS');
    }
    if (session.state === SESSION_STATES.ENDED) throw new DiscussionError('Session has already ended', 409, 'SESSION_ENDED');
    this.sessions.appendTurn(session, MODERATOR.name, createClosing(session.topic));
    session.state = SESSION_STATES.ENDED;
    const transcript = session.transcript.map(turn => ({ ...turn }));
    session.evaluationPromise = this.createReport(session, transcript);
    try {
      session.report = await session.evaluationPromise;
      return session.report;
    } finally {
      session.evaluationPromise = null;
    }
  }

  async createReport(session, transcript) {
    const metrics = this.feedback.calculateMetrics(transcript);
    const base = { sessionId: session.id, transcript, metrics };
    if (metrics.totalStudentTurns === 0) {
      return {
        ...base,
        status: 'insufficient_evidence',
        feedback: this.feedback.createNotAssessedFeedback(),
        summary: 'No student contribution was available to evaluate.',
        recommendations: ['Contribute an opening position, respond to another speaker, and close with a takeaway.'],
      };
    }
    try {
      const evaluation = await this.feedback.evaluate({ topic: session.topic, transcript });
      return { ...base, status: 'complete', ...evaluation };
    } catch {
      return {
        ...base,
        status: 'partial',
        feedback: this.feedback.createNotAssessedFeedback('AI evaluation was unavailable.'),
        summary: 'Deterministic participation metrics are available, but AI feedback could not be generated.',
        recommendations: [],
      };
    }
  }

  acknowledge(session, turnId, event) {
    if (session.turnEvents.has(turnId)) {
      throw new DiscussionError('Turn acknowledgment has already been recorded', 409, 'DUPLICATE_TURN_EVENT');
    }
    if (session.state !== SESSION_STATES.SPEAKING || session.activeTurnId !== turnId) {
      throw new DiscussionError('Turn ID is stale or is not the active turn', 409, 'STALE_TURN_ID');
    }
    if (event === 'cancelled') this.sessions.removeTurn(session, turnId);
    this.sessions.recordTurnEvent(session, turnId, event);
    session.activeTurnId = null;
    session.state = SESSION_STATES.LISTENING;
    return { turnId, event, state: session.state };
  }

  activateTurn(session, turn) {
    session.activeTurnId = turn.turnId;
    session.state = SESSION_STATES.SPEAKING;
  }

  assertCanGenerate(session) {
    if (session.state === SESSION_STATES.GENERATING) {
      throw new DiscussionError('A response is already being generated', 409, 'GENERATION_IN_PROGRESS');
    }
    if (session.state === SESSION_STATES.SPEAKING) {
      throw new DiscussionError('Active turn playback must be acknowledged before continuing', 409, 'PLAYBACK_IN_PROGRESS');
    }
    if (session.state === SESSION_STATES.ENDED) {
      throw new DiscussionError('Session has ended', 409, 'SESSION_ENDED');
    }
    if (session.state !== SESSION_STATES.LISTENING) {
      throw new DiscussionError('Session is not ready for a discussion turn', 409, 'INVALID_STATE');
    }
  }
}
