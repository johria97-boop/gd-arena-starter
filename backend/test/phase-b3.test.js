import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { SessionStore } from '../src/store/sessions.js';
import {
  FEEDBACK_CATEGORIES,
  FeedbackService,
  FeedbackValidationError,
  calculateMetrics,
} from '../src/services/feedback.service.js';
import { GeminiServiceError } from '../src/services/gemini.service.js';

class EvaluationGemini {
  constructor({ failEvaluation = false, fabricateEvidence = false } = {}) {
    this.calls = [];
    this.failEvaluation = failEvaluation;
    this.fabricateEvidence = fabricateEvidence;
  }

  async generate(input) {
    this.calls.push(input);
    if (input.responseMimeType !== 'application/json') return 'A concise AI discussion response.';
    if (this.failEvaluation) throw new GeminiServiceError('Evaluation unavailable');
    const request = JSON.parse(input.prompt);
    const studentId = request.transcript.find(turn => turn.speaker === 'Student')?.turnId;
    const evidenceId = this.fabricateEvidence ? randomUUID() : studentId;
    return JSON.stringify({
      feedback: FEEDBACK_CATEGORIES.map((category, index) => ({
        category,
        status: studentId ? 'assessed' : 'not_assessed',
        score: studentId ? 6 + (index % 3) : null,
        explanation: studentId ? 'The student made a relevant contribution.' : 'No student evidence was available.',
        improvement: 'Add a concrete example and connect it to a prior contribution.',
        evidenceTurnIds: studentId ? [evidenceId] : [],
      })),
      summary: 'The student contributed relevant ideas and can make connections more explicit.',
      recommendations: ['Use evidence.', 'Refer directly to another speaker.'],
    });
  }
}

function makeTurn(speaker, text, seconds, turnId = randomUUID()) {
  return { turnId, speaker, text, timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString() };
}

async function withSystem(gemini, run) {
  const sessions = new SessionStore();
  const server = createApp({ gemini, sessions }).listen(0);
  try {
    const { port } = server.address();
    await run({ base: `http://127.0.0.1:${port}/api`, sessions });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

function post(base, path, body = {}) {
  return fetch(`${base}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}

async function start(base) {
  const created = await (await post(base, '/sessions', { topic: 'Should schools use AI?' })).json();
  await post(base, `/sessions/${created.sessionId}/turns/${created.turn.turnId}/ack`, { event: 'completed' });
  return created;
}

async function addStudent(base, sessionId, text) {
  const { turn } = await (await post(base, `/sessions/${sessionId}/messages`, { text })).json();
  await post(base, `/sessions/${sessionId}/turns/${turn.turnId}/ack`, { event: 'completed' });
  return turn;
}

test('deterministic metrics count words, turns, speakers, duration, and averages', () => {
  const transcript = [
    makeTurn('Moderator', 'Welcome everyone', 0),
    makeTurn('Student', 'One two three four', 2),
    makeTurn('Alex', 'Good point', 6),
    makeTurn('Student', 'Five six', 10),
  ];
  const metrics = calculateMetrics(transcript);
  assert.equal(metrics.totalStudentTurns, 2);
  assert.equal(metrics.totalAiParticipantTurns, 1);
  assert.equal(metrics.totalStudentWords, 6);
  assert.equal(metrics.totalDiscussionWords, 10);
  assert.equal(metrics.discussionDurationSeconds, 10);
  assert.equal(metrics.averageStudentContributionWords, 3);
  assert.deepEqual(metrics.perSpeaker.Student, { turns: 2, words: 6, wordPercentage: 60 });
});

test('student contribution percentage is word-based rather than turn-based', () => {
  const metrics = calculateMetrics([
    makeTurn('Student', 'three student words', 0),
    makeTurn('Alex', 'one two three four five six seven', 1),
  ]);
  assert.equal(metrics.totalStudentTurns, 1);
  assert.equal(metrics.studentContributionPercentage, 30);
});

test('Gemini feedback is normalized to the valid six-category schema', async () => {
  const transcript = [makeTurn('Student', 'My opening reason is access.', 0), makeTurn('Alex', 'What about cost?', 1), makeTurn('Student', 'Cost matters, but access is broader.', 2)];
  const result = await new FeedbackService({ gemini: new EvaluationGemini() }).evaluate({ topic: 'AI in schools', transcript });
  assert.deepEqual(result.feedback.map(item => item.category), FEEDBACK_CATEGORIES);
  assert.ok(result.feedback.every(item => item.status === 'assessed' && item.score >= 0 && item.score <= 10));
  assert.ok(result.summary && result.recommendations.length === 2);
});

test('feedback evidence references only real transcript turns', async () => {
  const student = makeTurn('Student', 'I support the proposal.', 0);
  const alex = makeTurn('Alex', 'Why?', 1);
  const followup = makeTurn('Student', 'Because it expands access.', 2);
  const result = await new FeedbackService({ gemini: new EvaluationGemini() }).evaluate({ topic: 'Access', transcript: [student, alex, followup] });
  const ids = new Set([student.turnId, alex.turnId, followup.turnId]);
  assert.ok(result.feedback.flatMap(item => item.evidenceTurnIds).every(id => ids.has(id)));
});

test('fabricated Gemini turn IDs are rejected', async () => {
  const transcript = [makeTurn('Student', 'A real contribution.', 0)];
  const service = new FeedbackService({ gemini: new EvaluationGemini({ fabricateEvidence: true }) });
  await assert.rejects(service.evaluate({ topic: 'Test', transcript }), FeedbackValidationError);
});

test('discussion without student evidence is returned as not assessed without Gemini', async () => {
  const gemini = new EvaluationGemini();
  await withSystem(gemini, async ({ base }) => {
    const created = await start(base);
    const report = await (await post(base, `/sessions/${created.sessionId}/end`)).json();
    assert.equal(report.status, 'insufficient_evidence');
    assert.ok(report.feedback.every(item => item.status === 'not_assessed' && item.score === null));
    assert.equal(gemini.calls.length, 0);
  });
});

test('Gemini feedback failure returns a partial report and preserves metrics', async () => {
  const gemini = new EvaluationGemini({ failEvaluation: true });
  await withSystem(gemini, async ({ base }) => {
    const created = await start(base);
    await addStudent(base, created.sessionId, 'AI can broaden access to tutoring.');
    const report = await (await post(base, `/sessions/${created.sessionId}/end`)).json();
    assert.equal(report.status, 'partial');
    assert.equal(report.metrics.totalStudentTurns, 1);
    assert.ok(report.feedback.every(item => item.status === 'not_assessed'));
  });
});

test('repeated session-end requests reuse one cached Gemini evaluation', async () => {
  const gemini = new EvaluationGemini();
  await withSystem(gemini, async ({ base }) => {
    const created = await start(base);
    await addStudent(base, created.sessionId, 'AI should support teachers, not replace them.');
    const first = await (await post(base, `/sessions/${created.sessionId}/end`)).json();
    const second = await (await post(base, `/sessions/${created.sessionId}/end`)).json();
    assert.deepEqual(second, first);
    assert.equal(gemini.calls.filter(call => call.responseMimeType === 'application/json').length, 1);
  });
});

test('a very short discussion reports exact metrics and unsupported categories', async () => {
  await withSystem(new EvaluationGemini(), async ({ base }) => {
    const created = await start(base);
    await addStudent(base, created.sessionId, 'Yes.');
    const report = await (await post(base, `/sessions/${created.sessionId}/end`)).json();
    assert.equal(report.metrics.totalStudentWords, 1);
    assert.ok(report.feedback.some(item => item.status === 'not_assessed'));
  });
});

test('evaluation preserves every pre-existing transcript entry', async () => {
  await withSystem(new EvaluationGemini(), async ({ base, sessions }) => {
    const created = await start(base);
    await addStudent(base, created.sessionId, 'My evidence is the improved access reported by schools.');
    const before = structuredClone(sessions.get(created.sessionId).transcript);
    const report = await (await post(base, `/sessions/${created.sessionId}/end`)).json();
    assert.deepEqual(report.transcript.slice(0, before.length), before);
    assert.equal(report.transcript.at(-1).speaker, 'Moderator');
  });
});
