import assert from 'node:assert/strict';
import test from 'node:test';
import { DiscussionEngine, DiscussionError } from '../src/engine/discussion.engine.js';
import { SessionStore, SESSION_STATES, DEFAULT_DISCUSSION_DURATION_MS } from '../src/store/sessions.js';
import { FEEDBACK_CATEGORIES, calculateMetrics, createNotAssessedFeedback, FeedbackService } from '../src/services/feedback.service.js';

function evaluationFor(transcript) {
  const studentId = transcript.find(turn => turn.speaker === 'Student')?.turnId;
  return {
    overallScore: studentId ? 7 : null,
    feedback: FEEDBACK_CATEGORIES.map(category => ({
      category,
      status: studentId ? 'assessed' : 'not_assessed',
      score: studentId ? 7 : null,
      explanation: studentId ? 'A transcript-grounded observation.' : 'Not enough evidence.',
      improvement: 'Use one specific example.',
      evidenceTurnIds: studentId ? [studentId] : [],
    })),
    summary: 'A concise transcript-grounded summary.',
    recommendations: ['Use one specific example.'],
  };
}

function feedbackStub() {
  return {
    calls: 0,
    calculateMetrics,
    createNotAssessedFeedback,
    async evaluate({ transcript }) { this.calls += 1; return evaluationFor(transcript); },
  };
}

function makeEngine({ durationMs = 60_000, gemini } = {}) {
  const sessions = new SessionStore({ defaultDurationMs: durationMs });
  const feedback = feedbackStub();
  const engine = new DiscussionEngine({
    sessions,
    feedback,
    gemini: gemini || { async generate() { return 'A brief, complete response grounded in the discussion.'; } },
  });
  return { sessions, feedback, engine };
}

async function waitFor(predicate, timeoutMs = 500) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for session state');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test('speaker selection uses context, invitations, balance, and moderator cadence after the opening rotation', () => {
  const { sessions, engine } = makeEngine();
  const early = sessions.create('Should cities improve public transport?');
  assert.equal(engine.selectNextSpeaker(early, 'Sarah, how would you challenge that assumption?').name, 'Sarah');
  const session = sessions.create('How can evidence improve fair access to education?');
  session.aiTurnCount = 6;
  sessions.appendTurn(session, 'Moderator', 'Opening structure.');
  sessions.appendTurn(session, 'Alex', 'Evidence matters.');
  sessions.appendTurn(session, 'Sarah', 'A firm challenge.');
  sessions.appendTurn(session, 'David', 'Support access.');
  sessions.appendTurn(session, 'Student', 'One response.');
  sessions.appendTurn(session, 'Student', 'Another response.');
  assert.equal(engine.selectNextSpeaker(session, 'Moderator, please refocus us.').name, 'Moderator');
  assert.equal(engine.selectNextSpeaker(session, 'David, how can communities support fair access?').name, 'David');
  const afterDavid = sessions.appendTurn(session, 'David', 'A recent supportive point.');
  assert.notEqual(engine.selectNextSpeaker(session, 'What is the next consideration?').name, afterDavid.speaker);
});

test('default session deadline is five minutes', () => {
  const sessions = new SessionStore();
  const session = sessions.create('A topic');
  assert.equal(DEFAULT_DISCUSSION_DURATION_MS, 300_000);
  assert.equal(session.deadlineAt - session.createdAt, 300_000);
});

test('backend deadline automatically closes once and creates a reusable report', async () => {
  const { engine, feedback } = makeEngine({ durationMs: 20 });
  const { session, turn } = engine.open('A timed topic');
  engine.acknowledge(session, turn.turnId, 'completed');
  const ai = await engine.respond(session, 'A student contribution with one clear reason.');
  assert.equal(session.activeTurnId, ai.turnId);
  await waitFor(() => session.state === SESSION_STATES.ENDED && session.report);
  assert.ok(!session.report.transcript.some(item => item.turnId === ai.turnId));
  assert.ok(session.report.transcript.some(item => item.speaker === 'Student'));
  assert.equal(session.report.transcript.at(-1).speaker, 'Moderator');
  assert.equal(session.report.status, 'complete');
  assert.equal(session.report.overallScore, 7);
  const same = await engine.close(session);
  assert.equal(same, session.report);
  assert.equal(feedback.calls, 1);

  const manualSystem = makeEngine();
  const opened = manualSystem.engine.open('A manually ended topic');
  manualSystem.engine.acknowledge(opened.session, opened.turn.turnId, 'completed');
  const manualAi = await manualSystem.engine.respond(opened.session, 'Another student contribution with evidence.');
  manualSystem.engine.acknowledge(opened.session, manualAi.turnId, 'completed');
  const manualReport = await manualSystem.engine.close(opened.session);
  assert.equal(manualReport.status, session.report.status);
  assert.equal(manualReport.overallScore, session.report.overallScore);
  assert.deepEqual(Object.keys(manualReport).sort(), Object.keys(session.report).sort());
  assert.equal(manualSystem.feedback.calls, 1);
});

test('deadline during generation preserves the student turn and discards unfinished AI output', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { engine } = makeEngine({
    durationMs: 20,
    gemini: { async generate() { await gate; return 'This unfinished AI response must not be recorded.'; } },
  });
  const { session, turn } = engine.open('A timed generation');
  engine.acknowledge(session, turn.turnId, 'completed');
  const pending = engine.respond(session, 'Preserve this substantive student point.');
  await waitFor(() => session.endRequested);
  release();
  await assert.rejects(pending, error => error instanceof DiscussionError && error.code === 'END_REQUESTED');
  await waitFor(() => session.state === SESSION_STATES.ENDED && session.report);
  assert.ok(session.report.transcript.some(item => item.text === 'Preserve this substantive student point.'));
  assert.ok(!session.report.transcript.some(item => item.text.startsWith('This unfinished')));
});

test('feedback prompt requests detailed cross-cutting analysis with real evidence only', async () => {
  const transcript = [{ turnId: 'student-1', speaker: 'Student', text: 'My evidence supports fair access.', timestamp: new Date().toISOString() }];
  let request;
  const service = new FeedbackService({ gemini: { async generate(input) { request = JSON.parse(input.prompt); return JSON.stringify(evaluationFor(transcript)); } } });
  const result = await service.evaluate({ topic: 'Fair access', transcript });
  assert.match(request.evaluationGuidance.argument_quality_and_relevance, /critical thinking/i);
  assert.match(request.evaluationGuidance.handling_disagreements_and_interruptions, /respectful disagreement/i);
  assert.equal(result.feedback[0].evidenceTurnIds[0], 'student-1');
  assert.equal(result.overallScore, 7);
});
