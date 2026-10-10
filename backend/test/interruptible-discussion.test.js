import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { FEEDBACK_CATEGORIES, calculateMetrics, createNotAssessedFeedback } from '../src/services/feedback.service.js';
import { SessionStore } from '../src/store/sessions.js';

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

class ShortGemini {
  constructor({ long = false } = {}) { this.calls = []; this.long = long; }
  async generate(input) {
    this.calls.push(input);
    const speaker = input.prompt.match(/Now contribute as (Alex|Sarah|David|Moderator)/)?.[1] || 'Participant';
    const base = `${speaker} responds to the latest argument with a concise relevant challenge and one practical point for the group.`;
    return this.long ? `${base} This longer contribution adds enough detail for another participant to interject naturally before the complete thought finishes in browser playback.` : base;
  }
}

function feedbackStub(counter = { calls: 0 }) {
  return {
    calculateMetrics,
    createNotAssessedFeedback,
    async evaluate() {
      counter.calls += 1;
      return {
        overallScore: 7,
        feedback: FEEDBACK_CATEGORIES.map(category => ({
          category, status: 'not_assessed', score: null,
          explanation: 'Not enough evidence.', strength: null,
          improvementOpportunity: 'Add evidence.', actionableNextStep: 'Add evidence.',
          improvement: 'Add evidence.', evidenceTurnIds: [],
        })),
        summary: 'A bounded test report.',
        recommendations: ['Add evidence.'],
      };
    },
  };
}

async function post(base, path, body = {}) {
  return fetch(`${base}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}

async function withSystem({ random = seededRandom(1), gemini = new ShortGemini(), feedback = feedbackStub() } = {}, run) {
  const sessions = new SessionStore();
  const server = createApp({ sessions, gemini, feedback, random }).listen(0);
  try {
    const { port } = server.address();
    await run({ base: `http://127.0.0.1:${port}/api`, sessions, gemini });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function openListening(base) {
  const created = await (await post(base, '/sessions', { topic: 'Responsible technology policy' })).json();
  await post(base, `/sessions/${created.sessionId}/turns/${created.turn.turnId}/ack`, { event: 'completed' });
  return created;
}

test('seeded scheduling varies valid speakers instead of repeating a rigid long-term cycle', async () => {
  await withSystem({ random: seededRandom(42) }, async ({ base }) => {
    const created = await openListening(base);
    const speakers = [];
    for (let index = 0; index < 6; index += 1) {
      const response = index === 0
        ? await post(base, `/sessions/${created.sessionId}/messages`, { text: 'Evidence and fair access should guide this policy.' })
        : await post(base, `/sessions/${created.sessionId}/next`);
      const turn = (await response.json()).turn;
      speakers.push(turn.speaker);
      await post(base, `/sessions/${created.sessionId}/turns/${turn.turnId}/ack`, { event: 'completed' });
    }
    assert.ok(speakers.every(speaker => ['Alex', 'Sarah', 'David', 'Moderator'].includes(speaker)));
    assert.ok(new Set(speakers).size >= 3);
    assert.notDeepEqual(speakers, ['Alex', 'Sarah', 'David', 'Alex', 'Sarah', 'David']);
  });
});

test('continuation metadata advances beyond two turns and inserts bounded participation windows', async () => {
  await withSystem({ random: () => 0 }, async ({ base }) => {
    const created = await (await post(base, '/sessions', { topic: 'A discussion topic' })).json();
    const openingAck = await (await post(base, `/sessions/${created.sessionId}/turns/${created.turn.turnId}/ack`, { event: 'completed', requestContinuation: true })).json();
    assert.equal(openingAck.nextAction, 'generate');
    assert.equal(openingAck.continuationDelayMs, 650);
    for (let index = 1; index <= 5; index += 1) {
      const turn = (await (await post(base, `/sessions/${created.sessionId}/next`)).json()).turn;
      const ack = await (await post(base, `/sessions/${created.sessionId}/turns/${turn.turnId}/ack`, { event: 'completed', requestContinuation: true })).json();
      assert.equal(ack.nextAction, 'generate');
      assert.equal(ack.participationWindow, index === 3);
      assert.equal(ack.continuationDelayMs, index === 3 ? 4_000 : 650);
    }
    const cancelled = (await (await post(base, `/sessions/${created.sessionId}/next`)).json()).turn;
    const cancelledAck = await (await post(base, `/sessions/${created.sessionId}/turns/${cancelled.turnId}/ack`, { event: 'cancelled', requestContinuation: true })).json();
    assert.equal(cancelledAck.nextAction, 'listen');
    assert.equal(cancelledAck.continuationDelayMs, undefined);
  });
});

test('student text atomically cancels the exact active AI turn and takes priority', async () => {
  await withSystem({ random: () => 0, gemini: new ShortGemini({ long: true }) }, async ({ base, sessions }) => {
    const created = await openListening(base);
    const interrupted = (await (await post(base, `/sessions/${created.sessionId}/next`)).json()).turn;
    const response = await post(base, `/sessions/${created.sessionId}/messages`, {
      text: 'Let me respond before we move on.', interruptTurnId: interrupted.turnId,
    });
    assert.equal(response.status, 200);
    const replacement = (await response.json()).turn;
    const session = sessions.get(created.sessionId);
    assert.equal(session.turnEvents.get(interrupted.turnId), 'cancelled');
    assert.ok(!session.transcript.some(turn => turn.turnId === interrupted.turnId));
    assert.ok(session.transcript.some(turn => turn.speaker === 'Student' && /Let me respond/.test(turn.text)));
    assert.equal(session.activeTurnId, replacement.turnId);
    const stale = await post(base, `/sessions/${created.sessionId}/turns/${interrupted.turnId}/ack`, { event: 'completed' });
    assert.equal(stale.status, 409);
  });
});

test('scheduled AI interjection cancels one exact turn and cannot create an interruption loop', async () => {
  const gemini = new ShortGemini({ long: true });
  await withSystem({ random: () => 0, gemini }, async ({ base, sessions }) => {
    const created = await openListening(base);
    const interrupted = (await (await post(base, `/sessions/${created.sessionId}/next`)).json()).turn;
    assert.ok(interrupted.interruption?.afterMs >= 1_400);
    const response = await post(base, `/sessions/${created.sessionId}/next`, { interruptTurnId: interrupted.turnId });
    assert.equal(response.status, 200);
    const interjection = (await response.json()).turn;
    assert.notEqual(interjection.speaker, interrupted.speaker);
    assert.equal(interjection.interruption, undefined);
    assert.match(gemini.calls.at(-1).prompt, new RegExp(`${interrupted.speaker} was interrupted`));
    const session = sessions.get(created.sessionId);
    assert.equal(session.turnEvents.get(interrupted.turnId), 'cancelled');
    assert.ok(!session.transcript.some(turn => turn.turnId === interrupted.turnId));
  });
});

test('client cannot invent an unscheduled AI interruption', async () => {
  await withSystem({ random: () => 0, gemini: new ShortGemini() }, async ({ base, sessions }) => {
    const created = await openListening(base);
    const active = (await (await post(base, `/sessions/${created.sessionId}/next`)).json()).turn;
    assert.equal(active.interruption, undefined);
    const response = await post(base, `/sessions/${created.sessionId}/next`, { interruptTurnId: active.turnId });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, 'AI_INTERRUPTION_NOT_SCHEDULED');
    assert.equal(sessions.get(created.sessionId).activeTurnId, active.turnId);
  });
});

test('ending command during playback cancels that turn and still creates exactly one report', async () => {
  const evaluation = { calls: 0 };
  await withSystem({ random: () => 0, feedback: feedbackStub(evaluation) }, async ({ base }) => {
    const created = await openListening(base);
    const active = (await (await post(base, `/sessions/${created.sessionId}/messages`, {
      text: 'A staged policy should combine evidence, access, and public accountability.',
    })).json()).turn;
    const intent = await post(base, `/sessions/${created.sessionId}/messages`, {
      text: "Let's end this conversation.", interruptTurnId: active.turnId,
    });
    assert.deepEqual(await intent.json(), { endRequested: true });
    const first = await (await post(base, `/sessions/${created.sessionId}/end`)).json();
    const second = await (await post(base, `/sessions/${created.sessionId}/end`)).json();
    assert.deepEqual(second, first);
    assert.equal(evaluation.calls, 1);
    assert.ok(!first.transcript.some(turn => turn.turnId === active.turnId));
  });
});
