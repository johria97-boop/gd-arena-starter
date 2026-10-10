import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { SessionStore, SESSION_STATES } from '../src/store/sessions.js';
import { GeminiServiceError } from '../src/services/gemini.service.js';

class ControlledGemini {
  constructor({ gate, failures = 0 } = {}) {
    this.calls = [];
    this.gate = gate;
    this.failures = failures;
  }

  async generate(input) {
    this.calls.push(input);
    if (this.gate) await this.gate;
    if (this.failures > 0) {
      this.failures -= 1;
      throw new GeminiServiceError('AI service is temporarily unavailable');
    }
    return `Contribution ${this.calls.length} responding to the prior speaker.`;
  }
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
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function open(base) {
  const response = await post(base, '/sessions', { topic: 'Should AI reshape education?' });
  return response.json();
}

function ack(base, sessionId, turnId, event = 'completed') {
  return post(base, `/sessions/${sessionId}/turns/${turnId}/ack`, { event });
}

test('session follows valid READY, SPEAKING, LISTENING, GENERATING states', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const gemini = new ControlledGemini({ gate });
  await withSystem(gemini, async ({ base, sessions }) => {
    const created = await open(base);
    const session = sessions.get(created.sessionId);
    assert.equal(session.state, SESSION_STATES.SPEAKING);
    assert.equal((await post(base, `/sessions/${session.id}/next`)).status, 409);
    await ack(base, session.id, created.turn.turnId);
    assert.equal(session.state, SESSION_STATES.LISTENING);

    const pending = post(base, `/sessions/${session.id}/next`);
    while (gemini.calls.length === 0) await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal(session.state, SESSION_STATES.GENERATING);
    release();
    const turn = (await (await pending).json()).turn;
    assert.equal(session.state, SESSION_STATES.SPEAKING);
    await ack(base, session.id, turn.turnId);
    assert.equal(session.state, SESSION_STATES.LISTENING);
  });
});

test('completed playback acknowledgment clears the active AI turn', async () => {
  await withSystem(new ControlledGemini(), async ({ base, sessions }) => {
    const created = await open(base);
    const response = await ack(base, created.sessionId, created.turn.turnId);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      turnId: created.turn.turnId,
      event: 'completed',
      state: SESSION_STATES.LISTENING,
    });
    assert.equal(sessions.get(created.sessionId).activeTurnId, null);
  });
});

test('stale turn IDs are rejected without changing the active turn', async () => {
  await withSystem(new ControlledGemini(), async ({ base, sessions }) => {
    const created = await open(base);
    const response = await ack(base, created.sessionId, randomUUID());
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, 'STALE_TURN_ID');
    assert.equal(sessions.get(created.sessionId).activeTurnId, created.turn.turnId);
  });
});

test('duplicate acknowledgments are rejected safely', async () => {
  await withSystem(new ControlledGemini(), async ({ base }) => {
    const created = await open(base);
    assert.equal((await ack(base, created.sessionId, created.turn.turnId)).status, 200);
    const duplicate = await ack(base, created.sessionId, created.turn.turnId);
    assert.equal(duplicate.status, 409);
    assert.equal((await duplicate.json()).code, 'DUPLICATE_TURN_EVENT');
  });
});

test('student cancellation invalidates only the active turn and permits resumption', async () => {
  const gemini = new ControlledGemini();
  await withSystem(gemini, async ({ base, sessions }) => {
    const created = await open(base);
    await ack(base, created.sessionId, created.turn.turnId);
    const alex = (await (await post(base, `/sessions/${created.sessionId}/next`)).json()).turn;
    await ack(base, created.sessionId, alex.turnId);
    const sarah = (await (await post(base, `/sessions/${created.sessionId}/next`)).json()).turn;
    assert.equal((await ack(base, created.sessionId, sarah.turnId, 'cancelled')).status, 200);

    const resumed = await post(base, `/sessions/${created.sessionId}/messages`, { text: 'Let me challenge that.' });
    assert.equal(resumed.status, 200);
    assert.equal((await resumed.json()).turn.speaker, 'David');
    const transcript = sessions.get(created.sessionId).transcript;
    assert.ok(transcript.some(turn => turn.turnId === alex.turnId));
    assert.ok(!transcript.some(turn => turn.turnId === sarah.turnId));
    assert.ok(transcript.some(turn => turn.text === 'Let me challenge that.'));
  });
});

test('AI-to-AI generation receives prior speaker context and engagement guidance', async () => {
  const gemini = new ControlledGemini();
  await withSystem(gemini, async ({ base }) => {
    const created = await open(base);
    await ack(base, created.sessionId, created.turn.turnId);
    const alex = (await (await post(base, `/sessions/${created.sessionId}/next`)).json()).turn;
    await ack(base, created.sessionId, alex.turnId);
    const sarah = await post(base, `/sessions/${created.sessionId}/next`);
    assert.equal((await sarah.json()).turn.speaker, 'Sarah');
    assert.match(gemini.calls[1].prompt, /Alex: Contribution 1/);
    assert.match(gemini.calls[1].prompt, /engage their point by name/);
  });
});

test('moderator closes the transcript and the session becomes terminal', async () => {
  await withSystem(new ControlledGemini(), async ({ base, sessions }) => {
    const created = await open(base);
    await ack(base, created.sessionId, created.turn.turnId);
    const ended = await post(base, `/sessions/${created.sessionId}/end`);
    const body = await ended.json();
    assert.equal(body.transcript.at(-1).speaker, 'Moderator');
    assert.match(body.transcript.at(-1).text, /concludes our discussion/);
    assert.equal(sessions.get(created.sessionId).state, SESSION_STATES.ENDED);
    assert.equal((await post(base, `/sessions/${created.sessionId}/next`)).status, 409);
  });
});

test('state prevents concurrent Gemini generation', async () => {
  let release;
  const gemini = new ControlledGemini({ gate: new Promise(resolve => { release = resolve; }) });
  await withSystem(gemini, async ({ base }) => {
    const created = await open(base);
    await ack(base, created.sessionId, created.turn.turnId);
    const pending = post(base, `/sessions/${created.sessionId}/next`);
    while (gemini.calls.length === 0) await new Promise(resolve => setTimeout(resolve, 1));
    const conflict = await post(base, `/sessions/${created.sessionId}/next`);
    assert.equal((await conflict.json()).code, 'GENERATION_IN_PROGRESS');
    release();
    assert.equal((await pending).status, 200);
  });
});

test('Gemini failure restores LISTENING and a later request can recover', async () => {
  const gemini = new ControlledGemini({ failures: 1 });
  await withSystem(gemini, async ({ base, sessions }) => {
    const created = await open(base);
    await ack(base, created.sessionId, created.turn.turnId);
    const failed = await post(base, `/sessions/${created.sessionId}/messages`, { text: 'Failed attempt' });
    assert.equal(failed.status, 503);
    const session = sessions.get(created.sessionId);
    assert.equal(session.state, SESSION_STATES.LISTENING);
    assert.ok(!session.transcript.some(turn => turn.text === 'Failed attempt'));
    assert.equal((await post(base, `/sessions/${created.sessionId}/next`)).status, 200);
  });
});

test('Phase B1 success response formats remain compatible', async () => {
  await withSystem(new ControlledGemini(), async ({ base }) => {
    const created = await open(base);
    assert.deepEqual(Object.keys(created).sort(), ['sessionId', 'turn']);
    assert.deepEqual(Object.keys(created.turn).sort(), ['speaker', 'text', 'turnId']);
    await ack(base, created.sessionId, created.turn.turnId);
    const generated = (await (await post(base, `/sessions/${created.sessionId}/next`)).json()).turn;
    assert.deepEqual(Object.keys(generated).sort(), ['speaker', 'text', 'turnId']);
    await ack(base, created.sessionId, generated.turnId);
    const ended = await (await post(base, `/sessions/${created.sessionId}/end`)).json();
    assert.ok(Array.isArray(ended.feedback));
    assert.ok(Array.isArray(ended.transcript));
    assert.equal(typeof ended.status, 'string');
  });
});
