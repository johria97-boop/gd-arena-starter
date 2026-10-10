import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { ElevenLabsTtsService, ALEX_CUSTOM_VOICE_ID } from '../src/services/elevenlabs-tts.service.js';
import { SessionStore, SESSION_STATES } from '../src/store/sessions.js';

class MockGemini {
  constructor() { this.calls = []; }
  async generate(input) {
    this.calls.push(input);
    return 'Alex connects the evidence to the previous point.';
  }
}

async function withServer(options, run) {
  const server = createApp(options).listen(0);
  try {
    const { port } = server.address();
    await run(`http://127.0.0.1:${port}/api`);
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

async function activeAlex(base) {
  const createdResponse = await post(base, '/sessions', { topic: 'Should evidence guide public policy?' });
  const created = await createdResponse.json();
  await post(base, `/sessions/${created.sessionId}/turns/${created.turn.turnId}/ack`, { event: 'completed' });
  const response = await post(base, `/sessions/${created.sessionId}/messages`, {
    text: 'Evidence should be transparent and independently checked.',
  });
  return { sessionId: created.sessionId, turn: (await response.json()).turn };
}

test('ElevenLabs adapter sends bounded text to the configured Alex voice and model', async () => {
  const calls = [];
  const service = new ElevenLabsTtsService({
    apiKey: 'test-secret-key',
    model: 'eleven_flash_v2_5',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(Buffer.from('mock-mp3'), { status: 200, headers: { 'Content-Type': 'audio/mpeg' } });
    },
  });
  const audio = await service.synthesize('An analytical response.');
  assert.equal(audio.buffer.toString(), 'mock-mp3');
  assert.match(calls[0].url, new RegExp(`${ALEX_CUSTOM_VOICE_ID}\\?output_format=mp3_44100_128$`));
  assert.equal(calls[0].options.headers['xi-api-key'], 'test-secret-key');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    text: 'An analytical response.',
    model_id: 'eleven_flash_v2_5',
  });
});

test('missing ElevenLabs credentials return a stable error without making a request', async () => {
  let called = false;
  const diagnostics = [];
  const service = new ElevenLabsTtsService({
    apiKey: '',
    fetchImpl: async () => { called = true; },
    logger: { warn: (...values) => diagnostics.push(values.join(' ')) },
  });
  await assert.rejects(
    service.synthesize('Text'),
    error => error.code === 'ALEX_VOICE_NOT_CONFIGURED' && error.status === 503,
  );
  assert.equal(called, false);
  assert.match(diagnostics[0], /missing_configuration/);
});

test('upstream failures are classified without logging credentials, text, or raw messages', async () => {
  const cases = [
    [401, 'invalid_api_key', 'ALEX_VOICE_INVALID_CREDENTIALS', 'invalid_credentials'],
    [400, 'api_key_id_used_as_api_key', 'ALEX_VOICE_INVALID_CREDENTIALS', 'invalid_credentials'],
    [401, 'quota_exceeded', 'ALEX_VOICE_INSUFFICIENT_CREDITS', 'insufficient_credits'],
    [403, 'voice_access_denied', 'ALEX_VOICE_INACCESSIBLE', 'voice_inaccessible'],
    [429, 'concurrent_limit_exceeded', 'ALEX_VOICE_RATE_LIMITED', 'rate_limited'],
    [503, 'service_unavailable', 'ALEX_VOICE_UPSTREAM_FAILURE', 'upstream_service_failure'],
  ];
  for (const [status, providerCode, expectedCode, category] of cases) {
    const diagnostics = [];
    const secret = 'never-log-this-api-key';
    const privateText = 'never log this transcript text';
    const service = new ElevenLabsTtsService({
      apiKey: secret,
      logger: { warn: (...values) => diagnostics.push(values.join(' ')) },
      fetchImpl: async () => new Response(JSON.stringify({
        detail: { status: providerCode, message: `${secret} ${privateText}` },
      }), { status, headers: { 'Content-Type': 'application/json' } }),
    });
    await assert.rejects(service.synthesize(privateText), error => error.code === expectedCode && error.status === 503);
    const output = diagnostics.join(' ');
    assert.match(output, new RegExp(category));
    assert.match(output, new RegExp(`"upstreamStatus":${status}`));
    assert.doesNotMatch(output, new RegExp(secret));
    assert.doesNotMatch(output, new RegExp(privateText));
    assert.doesNotMatch(output, /"message"/);
  }
});

test('audio endpoint permits only the active Alex turn and ignores client-supplied voice data', async () => {
  const gemini = new MockGemini();
  const calls = [];
  const releases = [];
  const tts = {
    async audioForTurn(input) { calls.push(input); return { buffer: Buffer.from('audio'), contentType: 'audio/mpeg' }; },
    release: (...args) => releases.push(args),
  };
  await withServer({ gemini, tts }, async base => {
    const createdResponse = await post(base, '/sessions', { topic: 'A policy topic' });
    const created = await createdResponse.json();
    const rejected = await post(base, `/sessions/${created.sessionId}/turns/${created.turn.turnId}/audio`);
    assert.equal(rejected.status, 400);
    assert.equal((await rejected.json()).code, 'ALEX_VOICE_NOT_AVAILABLE');
    await post(base, `/sessions/${created.sessionId}/turns/${created.turn.turnId}/ack`, { event: 'completed' });

    const messageResponse = await post(base, `/sessions/${created.sessionId}/messages`, { text: 'A student point.' });
    const turn = (await messageResponse.json()).turn;
    const audio = await post(base, `/sessions/${created.sessionId}/turns/${turn.turnId}/audio`, {
      text: 'attacker-controlled text', voiceId: 'another-voice',
    });
    assert.equal(audio.status, 200);
    assert.equal(await audio.text(), 'audio');
    assert.deepEqual(calls, [{ sessionId: created.sessionId, turnId: turn.turnId, text: turn.text }]);
    assert.equal(gemini.calls.length, 1);

    await post(base, `/sessions/${created.sessionId}/turns/${turn.turnId}/ack`, { event: 'completed' });
    assert.ok(releases.some(args => args[0] === created.sessionId && args[1] === turn.turnId));
    const stale = await post(base, `/sessions/${created.sessionId}/turns/${turn.turnId}/audio`);
    assert.equal(stale.status, 409);
  });
});

test('provider failure preserves the active Alex turn for browser fallback and exact acknowledgment', async () => {
  const sessions = new SessionStore();
  const tts = new ElevenLabsTtsService({
    apiKey: 'mock-key',
    fetchImpl: async () => new Response('{}', { status: 429, headers: { 'Content-Type': 'application/json' } }),
    logger: { warn() {} },
  });
  await withServer({ sessions, gemini: new MockGemini(), tts }, async base => {
    const { sessionId, turn } = await activeAlex(base);
    const failed = await post(base, `/sessions/${sessionId}/turns/${turn.turnId}/audio`);
    assert.equal(failed.status, 503);
    const error = await failed.json();
    assert.equal(error.code, 'ALEX_VOICE_RATE_LIMITED');
    assert.doesNotMatch(JSON.stringify(error), /secret|stack|api.?key/i);
    const session = sessions.get(sessionId);
    assert.equal(session.state, SESSION_STATES.SPEAKING);
    assert.equal(session.activeTurnId, turn.turnId);
    assert.ok(session.transcript.some(item => item.turnId === turn.turnId));
    assert.equal((await post(base, `/sessions/${sessionId}/turns/${turn.turnId}/ack`, { event: 'completed' })).status, 200);
  });
});

test('repeated requests for one active turn share one provider generation and release bounded cache', async () => {
  let calls = 0;
  let resolveFetch;
  const responsePromise = new Promise(resolve => { resolveFetch = resolve; });
  const service = new ElevenLabsTtsService({
    apiKey: 'test-key',
    fetchImpl: async () => { calls += 1; return responsePromise; },
  });
  const input = { sessionId: 'session', turnId: 'turn', text: 'One exact turn.' };
  const first = service.audioForTurn(input);
  const second = service.audioForTurn(input);
  resolveFetch(new Response(Buffer.from('voice'), { status: 200, headers: { 'Content-Type': 'audio/mpeg' } }));
  const [firstAudio, secondAudio] = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.strictEqual(firstAudio, secondAudio);
  assert.equal(service.cache.size, 1);
  service.release(input.sessionId, input.turnId);
  assert.equal(service.cache.size, 0);
});
