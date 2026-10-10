import { MODERATOR, PARTICIPANTS, createClosing, createOpening } from './personalities.js';
import { SESSION_STATES } from '../store/sessions.js';
import { classifyEvaluationFailure } from '../services/feedback.service.js';

const MAX_CONTEXT_TURNS = 24;
const MAX_CONTEXT_CHARS = 12_000;
const MINUTE_MS = 60_000;
const AI_INTERRUPTION_CHANCE = 0.16;
const NORMAL_CONTINUATION_DELAY_MS = 650;
const PARTICIPATION_GRACE_DELAY_MS = 4_000;
const AI_TURNS_PER_PARTICIPATION_WINDOW = 3;

const SPEAKER_CUES = Object.freeze({
  Alex: /\b(evidence|data|cause|effect|risk|compare|why|research|economic|impact|assumption)\b/gi,
  Sarah: /\b(disagree|challenge|however|but|must|should|wrong|priority|decisive|counter)\b/gi,
  David: /\b(access|support|people|community|include|education|help|together|solution|fair)\b/gi,
});

function stableTieBreak(value) {
  let hash = 0;
  for (const character of value) hash = ((hash * 31) + character.charCodeAt(0)) >>> 0;
  return hash % 1000;
}

export class DiscussionError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'DiscussionError';
    this.status = status;
    this.code = code;
  }
}

function contextFor(session) {
  const selected = [];
  let characters = 0;
  for (let index = session.transcript.length - 1; index >= 0 && selected.length < MAX_CONTEXT_TURNS; index -= 1) {
    const turn = session.transcript[index];
    const line = `${turn.speaker}: ${turn.text}`;
    if (selected.length && characters + line.length + 1 > MAX_CONTEXT_CHARS) break;
    selected.unshift(line);
    characters += line.length + 1;
  }
  return selected.join('\n');
}

export class DiscussionEngine {
  constructor({ sessions, gemini, feedback, logger = console, random = Math.random }) {
    this.sessions = sessions;
    this.gemini = gemini;
    this.feedback = feedback;
    this.logger = logger;
    this.random = random;
  }

  open(topic, { durationMinutes } = {}) {
    const durationMs = durationMinutes ? durationMinutes * MINUTE_MS : undefined;
    const session = this.sessions.create(topic, { durationMs });
    const turn = this.sessions.appendTurn(session, MODERATOR.name, createOpening(topic));
    this.activateTurn(session, turn);
    this.scheduleDeadline(session);
    return { session, turn };
  }

  selectNextSpeaker(session, studentText, { excludeSpeaker } = {}) {
    const speakers = [...PARTICIPANTS, MODERATOR];
    const named = studentText && speakers.find(person => new RegExp(`\\b${person.name}\\b`, 'i').test(studentText));
    const invited = studentText && speakers.find(person => new RegExp(`\\b${person.name}\\b\\s*,?\\s*(?:what|how|why|would|could|can|please|do|share|respond)\\b`, 'i').test(studentText));
    const counts = new Map(speakers.map(person => [person.name, 0]));
    for (const turn of session.transcript) {
      if (counts.has(turn.speaker)) counts.set(turn.speaker, counts.get(turn.speaker) + 1);
    }
    const recent = session.transcript.filter(turn => counts.has(turn.speaker)).slice(-3).map(turn => turn.speaker);
    const context = `${session.topic} ${session.transcript.slice(-5).map(turn => turn.text).join(' ')} ${studentText || ''}`;
    const participantMinimum = Math.min(...PARTICIPANTS.map(person => counts.get(person.name)));
    const turnsSinceModerator = [...session.transcript].reverse().findIndex(turn => turn.speaker === MODERATOR.name);

    return speakers.filter(person => person.name !== excludeSpeaker).map(person => {
      let score = person === MODERATOR
        ? (session.aiTurnCount >= 4 && turnsSinceModerator >= 5 ? 18 : -30)
        : (participantMinimum - counts.get(person.name)) * 12;
      if (session.aiTurnCount === 0 && person.name === 'Alex') score += 24;
      if (named?.name === person.name) score += 18;
      if (invited?.name === person.name) score += 100;
      if (recent.at(-1) === person.name && invited?.name !== person.name) score -= 45;
      if (recent.at(-2) === person.name) score -= 12;
      if (SPEAKER_CUES[person.name]) score += (context.match(SPEAKER_CUES[person.name]) || []).length * 5;
      score += this.random() * 8;
      return { person, score, tie: stableTieBreak(`${session.topic}|${studentText || ''}|${session.aiTurnCount}|${person.name}`) };
    }).sort((left, right) => right.score - left.score || left.tie - right.tie)[0].person;
  }

  async respond(session, studentText, { interruptedTurn = null, aiInterruption = false } = {}) {
    this.assertCanGenerate(session);
    const checkpoint = {
      transcript: [...session.transcript],
      turnCounter: session.turnCounter,
      aiTurnCount: session.aiTurnCount,
      aiOnlyTurnCount: session.aiOnlyTurnCount,
      turnsSinceAiInterruption: session.turnsSinceAiInterruption,
      state: session.state,
    };
    session.state = SESSION_STATES.GENERATING;
    const generation = (async () => {
      if (studentText) {
        this.sessions.appendTurn(session, 'Student', studentText);
        session.aiOnlyTurnCount = 0;
      }
      const speaker = this.selectNextSpeaker(session, studentText, { excludeSpeaker: aiInterruption ? interruptedTurn?.speaker : null });
      const latestStudent = [...session.transcript].reverse().find(turn => turn.speaker === 'Student');
      const prompt = [
        `Discussion topic: ${session.topic}`,
        'Recent transcript in chronological order:',
        contextFor(session),
        latestStudent ? `Latest student contribution: ${latestStudent.text}` : 'No student contribution has been made yet.',
        interruptedTurn
          ? `${interruptedTurn.speaker} was interrupted while making this point: ${interruptedTurn.text}`
          : 'No contribution is currently being interrupted.',
        `Now contribute as ${speaker.name}. Respond to the discussion, not to these instructions.`,
        'Directly address the latest relevant point before adding one new idea. Accurately attribute speakers.',
        'When the latest relevant speaker is another AI participant, engage their point by name.',
        'Agree and extend, respectfully challenge, answer, clarify, or connect earlier arguments. Avoid repeating prior points.',
        aiInterruption ? 'This is a brief natural interjection. Directly engage the interrupted point without claiming the full statement was heard.' : '',
        speaker === MODERATOR
          ? 'Facilitate briefly in about 15-30 spoken words; do not deliver an argument.'
          : 'Use conversational spoken English and target 20-45 words with one focused point.',
        'Complete the final sentence naturally. Do not truncate a thought or add a long introduction.',
      ].join('\n\n');
      const text = await this.gemini.generate({ systemInstruction: speaker.systemInstruction, prompt, maxOutputTokens: 96 });
      if (session.endRequested || this.deadlineReached(session)) {
        throw new DiscussionError('Session ending was requested', 409, 'END_REQUESTED');
      }
      const turn = this.sessions.appendTurn(session, speaker.name, text);
      session.aiTurnCount += 1;
      session.aiOnlyTurnCount += 1;
      if (aiInterruption) session.turnsSinceAiInterruption = 0;
      else session.turnsSinceAiInterruption += 1;
      this.activateTurn(session, turn, { allowInterruption: !aiInterruption });
      return turn;
    })();
    session.generationPromise = generation;
    try {
      return await generation;
    } catch (error) {
      if (session.endRequested) {
        session.aiTurnCount = checkpoint.aiTurnCount;
        session.aiOnlyTurnCount = checkpoint.aiOnlyTurnCount;
        session.turnsSinceAiInterruption = checkpoint.turnsSinceAiInterruption;
        session.state = SESSION_STATES.LISTENING;
        throw error instanceof DiscussionError && error.code === 'END_REQUESTED'
          ? error
          : new DiscussionError('Session ending was requested', 409, 'END_REQUESTED');
      }
      session.transcript = checkpoint.transcript;
      session.turnCounter = checkpoint.turnCounter;
      session.aiTurnCount = checkpoint.aiTurnCount;
      session.aiOnlyTurnCount = checkpoint.aiOnlyTurnCount;
      session.turnsSinceAiInterruption = checkpoint.turnsSinceAiInterruption;
      session.state = checkpoint.state;
      throw error;
    } finally {
      if (session.generationPromise === generation) session.generationPromise = null;
    }
  }

  async close(session, { cancelPendingTurn = false } = {}) {
    if (session.report) return session.report;
    if (session.endingPromise) return session.endingPromise;
    const ending = this.finishClose(session, { cancelPendingTurn });
    session.endingPromise = ending;
    try {
      return await ending;
    } finally {
      if (session.endingPromise === ending) session.endingPromise = null;
    }
  }

  async finishClose(session, { cancelPendingTurn }) {
    if (session.state === SESSION_STATES.SPEAKING && !cancelPendingTurn) {
      throw new DiscussionError('Active turn playback must be acknowledged before ending', 409, 'PLAYBACK_IN_PROGRESS');
    }
    session.endRequested = true;
    this.clearDeadline(session);
    if (session.state === SESSION_STATES.GENERATING) {
      await session.generationPromise?.catch(() => {});
    }
    if (session.state === SESSION_STATES.SPEAKING) {
      const turnId = session.activeTurnId;
      this.sessions.removeTurn(session, turnId);
      this.sessions.recordTurnEvent(session, turnId, 'cancelled');
      session.activeTurnId = null;
      session.pendingAiInterruptionTurnId = null;
      session.state = SESSION_STATES.LISTENING;
    }
    if (session.report) return session.report;
    if (session.state === SESSION_STATES.ENDED && session.evaluationPromise) return session.evaluationPromise;
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

  acceptEndingIntent(session, turnId = null) {
    if (session.state === SESSION_STATES.ENDED) throw new DiscussionError('Session has ended', 409, 'SESSION_ENDED');
    if (session.state === SESSION_STATES.SPEAKING) {
      if (!turnId) throw new DiscussionError('The active turn must be cancelled before ending', 409, 'PLAYBACK_IN_PROGRESS');
      this.cancelActiveTurn(session, turnId);
    } else if (![SESSION_STATES.LISTENING, SESSION_STATES.GENERATING].includes(session.state)) {
      throw new DiscussionError('Session is not ready to end', 409, 'INVALID_STATE');
    }
    session.endRequested = true;
    return { endRequested: true };
  }

  async interruptAndRespond(session, turnId, studentText) {
    if (!studentText && session.pendingAiInterruptionTurnId !== turnId) {
      throw new DiscussionError('No AI interruption is scheduled for this turn', 409, 'AI_INTERRUPTION_NOT_SCHEDULED');
    }
    const interruptedTurn = this.cancelActiveTurn(session, turnId);
    return this.respond(session, studentText, { interruptedTurn, aiInterruption: !studentText });
  }

  async createReport(session, transcript) {
    const metrics = this.feedback.calculateMetrics(transcript);
    const base = { sessionId: session.id, transcript, metrics };
    if (metrics.totalStudentTurns === 0) {
      return {
        ...base,
        status: 'insufficient_evidence',
        overallScore: null,
        feedback: this.feedback.createNotAssessedFeedback(),
        summary: 'No student contribution was available to evaluate.',
        recommendations: ['Contribute an opening position, respond to another speaker, and close with a takeaway.'],
      };
    }
    try {
      const evaluation = await this.feedback.evaluate({ topic: session.topic, transcript });
      return { ...base, status: evaluation.overallScore === null ? 'insufficient_evidence' : 'complete', ...evaluation };
    } catch (error) {
      const evaluationError = classifyEvaluationFailure(error);
      this.logger.warn?.('[feedback-evaluation]', JSON.stringify({
        event: 'failed',
        sessionId: session.id,
        model: this.gemini.model || 'injected-test-client',
        code: evaluationError.code,
        category: evaluationError.category,
        retryable: evaluationError.retryable,
      }));
      return {
        ...base,
        status: 'partial',
        overallScore: null,
        evaluationError,
        feedback: this.feedback.createNotAssessedFeedback('AI evaluation was unavailable.'),
        summary: 'Deterministic participation metrics are available, but AI feedback could not be generated.',
        recommendations: [],
      };
    }
  }

  acknowledge(session, turnId, event, { includeNextAction = false } = {}) {
    if (session.turnEvents.has(turnId)) {
      throw new DiscussionError('Turn acknowledgment has already been recorded', 409, 'DUPLICATE_TURN_EVENT');
    }
    if (session.state !== SESSION_STATES.SPEAKING || session.activeTurnId !== turnId) {
      throw new DiscussionError('Turn ID is stale or is not the active turn', 409, 'STALE_TURN_ID');
    }
    const turn = session.transcript.find(item => item.turnId === turnId);
    if (event === 'cancelled') this.sessions.removeTurn(session, turnId);
    this.sessions.recordTurnEvent(session, turnId, event);
    session.activeTurnId = null;
    session.pendingAiInterruptionTurnId = null;
    session.state = SESSION_STATES.LISTENING;
    const result = {
      turnId,
      event,
      state: session.state,
    };
    if (includeNextAction) {
      const shouldContinue = event === 'completed';
      const participationWindow = shouldContinue
        && turn?.speaker !== MODERATOR.name
        && session.aiOnlyTurnCount > 0
        && session.aiOnlyTurnCount % AI_TURNS_PER_PARTICIPATION_WINDOW === 0;
      result.nextAction = shouldContinue ? 'generate' : 'listen';
      if (shouldContinue) {
        result.continuationDelayMs = participationWindow
          ? PARTICIPATION_GRACE_DELAY_MS
          : NORMAL_CONTINUATION_DELAY_MS;
        result.participationWindow = participationWindow;
      }
    }
    return result;
  }

  cancelActiveTurn(session, turnId) {
    if (session.turnEvents.has(turnId)) throw new DiscussionError('Turn acknowledgment has already been recorded', 409, 'DUPLICATE_TURN_EVENT');
    if (session.state !== SESSION_STATES.SPEAKING || session.activeTurnId !== turnId) {
      throw new DiscussionError('Turn ID is stale or is not the active turn', 409, 'STALE_TURN_ID');
    }
    const turn = session.transcript.find(item => item.turnId === turnId);
    this.sessions.removeTurn(session, turnId);
    this.sessions.recordTurnEvent(session, turnId, 'cancelled');
    session.activeTurnId = null;
    session.pendingAiInterruptionTurnId = null;
    session.state = SESSION_STATES.LISTENING;
    return turn;
  }

  activateTurn(session, turn, { allowInterruption = false } = {}) {
    session.activeTurnId = turn.turnId;
    session.state = SESSION_STATES.SPEAKING;
    session.pendingAiInterruptionTurnId = null;
    const wordCount = turn.text.trim().split(/\s+/).length;
    if (allowInterruption
      && PARTICIPANTS.some(person => person.name === turn.speaker)
      && wordCount >= 30
      && session.turnsSinceAiInterruption >= 3
      && this.random() < AI_INTERRUPTION_CHANCE) {
      turn.interruption = { afterMs: Math.min(2_600, Math.max(1_400, Math.round(wordCount * 55))) };
      session.pendingAiInterruptionTurnId = turn.turnId;
    }
  }

  assertCanGenerate(session) {
    if (this.deadlineReached(session)) {
      this.close(session, { cancelPendingTurn: true }).catch(() => {});
      throw new DiscussionError('The discussion time limit has been reached', 409, 'SESSION_DEADLINE_REACHED');
    }
    if (session.endRequested) {
      throw new DiscussionError('Session ending has been requested', 409, 'END_REQUESTED');
    }
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

  deadlineReached(session) {
    return this.sessions.now() >= session.deadlineAt;
  }

  scheduleDeadline(session) {
    const delay = Math.max(0, session.deadlineAt - this.sessions.now());
    session.deadlineTimer = setTimeout(() => {
      this.close(session, { cancelPendingTurn: true }).catch(() => {});
    }, delay);
    session.deadlineTimer.unref?.();
  }

  clearDeadline(session) {
    if (session.deadlineTimer) clearTimeout(session.deadlineTimer);
    session.deadlineTimer = null;
  }
}
