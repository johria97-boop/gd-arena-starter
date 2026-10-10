import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { PARTICIPANTS } from '../src/engine/personalities.js';
import { GeminiService, GeminiServiceError } from '../src/services/gemini.service.js';

class MockGemini {
  constructor({ delay, failure } = {}) {
    this.calls = [];
    this.delay = delay;
    this.failure = failure;
  }

  async generate(input) {
    this.calls.push(input);
    if (this.delay) await this.delay;
    if (this.failure) throw this.failure;
    return `Mock response ${this.calls.length}: building on the previous contribution.`;
  }
}

async function withServer(gemini, run) {
  const server = createApp({ gemini }).listen(0);
  try {
    const { port } = server.address();
    await run(`http://127.0.0.1:${port}/api`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function post(base, path, body = {}) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function createSession(base, topic = 'Is AI replacing human jobs?') {
  const response = await post(base, '/sessions', { topic });
  assert.equal(response.status, 201);
  return response.json();
}

async function acknowledge(base, sessionId, turnId, event = 'completed') {
  return post(base, `/sessions/${sessionId}/turns/${turnId}/ack`, { event });
}

test('invalid topics are rejected', async () => {
  await withServer(new MockGemini(), async base => {
    for (const topic of ['', '   ', 42, 'x'.repeat(301)]) {
      const response = await post(base, '/sessions', { topic });
      assert.equal(response.status, 400);
      assert.equal(typeof (await response.json()).error, 'string');
    }
  });
});

test('valid sessions have unique UUIDs and a moderator opening', async () => {
  await withServer(new MockGemini(), async base => {
    const first = await createSession(base);
    const second = await createSession(base, 'Should cities ban private cars?');
    assert.notEqual(first.sessionId, second.sessionId);
    assert.match(first.sessionId, /^[0-9a-f-]{36}$/i);
    assert.deepEqual(Object.keys(first.turn).sort(), ['speaker', 'text', 'turnId']);
    assert.equal(first.turn.speaker, 'Moderator');
  });
});

test('student messages and predictable AI turns appear in the transcript', async () => {
  const gemini = new MockGemini();
  await withServer(gemini, async base => {
    const { sessionId, turn: opening } = await createSession(base);
    assert.equal((await acknowledge(base, sessionId, opening.turnId)).status, 200);
    const studentText = 'I think AI will transform many existing jobs.';
    const first = await post(base, `/sessions/${sessionId}/messages`, { text: studentText });
    assert.equal(first.status, 200);
    const firstTurn = (await first.json()).turn;
    assert.equal(firstTurn.speaker, 'Alex');
    assert.equal(typeof firstTurn.turnId, 'string');
    assert.equal(typeof firstTurn.text, 'string');

    await acknowledge(base, sessionId, firstTurn.turnId);
    const second = await post(base, `/sessions/${sessionId}/next`);
    const secondTurn = (await second.json()).turn;
    assert.equal(secondTurn.speaker, 'Sarah');
    await acknowledge(base, sessionId, secondTurn.turnId);
    const third = await post(base, `/sessions/${sessionId}/next`);
    const thirdTurn = (await third.json()).turn;
    assert.equal(thirdTurn.speaker, 'David');
    await acknowledge(base, sessionId, thirdTurn.turnId);

    const ended = await post(base, `/sessions/${sessionId}/end`);
    const result = await ended.json();
    assert.ok(result.transcript.some(turn => turn.speaker === 'Student' && turn.text === studentText));
    assert.equal(result.transcript.at(-1).speaker, 'Moderator');
    assert.equal(result.feedback.length, 6);
    assert.match(gemini.calls[1].prompt, /Alex: Mock response 1/);
  });
});

test('all three participants have distinct instructions', () => {
  assert.deepEqual(PARTICIPANTS.map(person => person.name), ['Alex', 'Sarah', 'David']);
  assert.equal(new Set(PARTICIPANTS.map(person => person.systemInstruction)).size, 3);
  assert.ok(PARTICIPANTS.every(person => person.systemInstruction.length > 40));
});

test('malformed and nonexistent session IDs return appropriate errors', async () => {
  await withServer(new MockGemini(), async base => {
    assert.equal((await post(base, '/sessions/not-a-uuid/next')).status, 400);
    assert.equal((await post(base, `/sessions/${randomUUID()}/next`)).status, 404);
  });
});

test('concurrent generation is rejected without corrupting the session', async () => {
  let release;
  const delay = new Promise(resolve => { release = resolve; });
  const gemini = new MockGemini({ delay });
  await withServer(gemini, async base => {
    const { sessionId, turn } = await createSession(base);
    await acknowledge(base, sessionId, turn.turnId);
    const firstRequest = post(base, `/sessions/${sessionId}/next`);
    while (gemini.calls.length === 0) await new Promise(resolve => setTimeout(resolve, 1));
    const duplicate = await post(base, `/sessions/${sessionId}/next`);
    assert.equal(duplicate.status, 409);
    assert.match((await duplicate.json()).error, /already being generated/);
    release();
    assert.equal((await firstRequest).status, 200);
  });
});

test('Gemini failure is recoverable and rolls back the pending student turn', async () => {
  const failure = new GeminiServiceError('AI service is temporarily unavailable');
  await withServer(new MockGemini({ failure }), async base => {
    const { sessionId, turn } = await createSession(base);
    await acknowledge(base, sessionId, turn.turnId);
    const failed = await post(base, `/sessions/${sessionId}/messages`, { text: 'Do not retain this failed turn.' });
    assert.equal(failed.status, 503);
    assert.doesNotMatch(JSON.stringify(await failed.json()), /stack|api.?key/i);

    const ended = await post(base, `/sessions/${sessionId}/end`);
    const { transcript } = await ended.json();
    assert.ok(!transcript.some(turn => turn.speaker === 'Student'));
  });
});

test('ended sessions reject further discussion turns', async () => {
  await withServer(new MockGemini(), async base => {
    const { sessionId, turn } = await createSession(base);
    await acknowledge(base, sessionId, turn.turnId);
    assert.equal((await post(base, `/sessions/${sessionId}/end`)).status, 200);
    assert.equal((await post(base, `/sessions/${sessionId}/next`)).status, 409);
    assert.equal((await post(base, `/sessions/${sessionId}/messages`, { text: 'Too late' })).status, 409);
  });
});

test('Gemini REST integration works when a key is configured', {
  skip: !process.env.GEMINI_API_KEY,
  timeout: 25_000,
}, async () => {
  const service = new GeminiService();
  const text = await service.generate({
    systemInstruction: 'Reply concisely and return plain text.',
    prompt: 'Say that the integration is working in five words or fewer.',
  });
  assert.ok(text.length > 0);
});
