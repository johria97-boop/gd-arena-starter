import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { classifyEndingIntent } from '../src/engine/ending-intent.js';
import { FEEDBACK_CATEGORIES } from '../src/services/feedback.service.js';
import { SessionStore, SESSION_STATES } from '../src/store/sessions.js';

class FlowGemini {
  constructor({ gate } = {}) {
    this.calls = [];
    this.gate = gate;
  }

  async generate(input) {
    this.calls.push(input);
    if (input.responseMimeType === 'application/json') {
      const transcript = JSON.parse(input.prompt).transcript;
      const evidence = transcript.find(turn => turn.speaker === 'Student')?.turnId;
      return JSON.stringify({
        feedback: FEEDBACK_CATEGORIES.map(category => ({
          category,
          status: evidence ? 'assessed' : 'not_assessed',
          score: evidence ? 7 : null,
          explanation: evidence ? 'The contribution is supported by the transcript.' : 'Insufficient evidence.',
          improvement: 'Respond to one specific prior point.',
          evidenceTurnIds: evidence ? [evidence] : [],
        })),
        summary: 'Transcript-grounded summary.',
        recommendations: ['Keep the next contribution focused.'],
      });
    }
    if (this.gate) await this.gate;
    return 'That concern matters because access and retraining capacity are uneven; we should test the claim against real outcomes.';
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
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}

async function openListening(base) {
  const created = await (await post(base, '/sessions', { topic: 'Will AI create more jobs than it replaces?' })).json();
  await post(base, `/sessions/${created.sessionId}/turns/${created.turn.turnId}/ack`, { event: 'completed' });
  return created;
}

async function requestEnd(base, sessionId, text) {
  const intent = await post(base, `/sessions/${sessionId}/messages`, { text });
  assert.equal(intent.status, 200);
  assert.deepEqual(await intent.json(), { endRequested: true });
  return post(base, `/sessions/${sessionId}/end`);
}

for (const [name, phrase] of [
  ["Let's end the discussion ends the session", "Let's end the discussion."],
  ["Let's end this conversation ends the session", "Let's end this conversation."],
  ["Let's end the topic ends the session", "Let's end the topic."],
  ["Let's finish here ends the session", "Let's finish here."],
]) {
  test(name, async () => {
    const gemini = new FlowGemini();
    await withSystem(gemini, async ({ base, sessions }) => {
      const created = await openListening(base);
      const report = await (await requestEnd(base, created.sessionId, phrase)).json();
      assert.equal(sessions.get(created.sessionId).state, SESSION_STATES.ENDED);
      assert.equal(report.transcript.at(-1).speaker, 'Moderator');
      assert.equal(gemini.calls.length, 0);
    });
  });
}

test('voice-transcribed ending punctuation follows the same deterministic message path', async () => {
  assert.equal(classifyEndingIntent("  LET'S end the discussion!!!  "), 'end');
  await withSystem(new FlowGemini(), async ({ base }) => {
    const created = await openListening(base);
    assert.equal((await requestEnd(base, created.sessionId, "LET'S end the discussion!!!")).status, 200);
  });
});

test('ambiguous ending questions do not terminate automatically', async () => {
  const gemini = new FlowGemini();
  await withSystem(gemini, async ({ base, sessions }) => {
    const created = await openListening(base);
    const response = await post(base, `/sessions/${created.sessionId}/messages`, { text: 'Should we end the discussion?' });
    assert.equal(response.status, 200);
    assert.ok((await response.json()).turn);
    assert.equal(sessions.get(created.sessionId).state, SESSION_STATES.SPEAKING);
    assert.equal(gemini.calls.length, 1);
  });
});

test('negated and quoted ending language does not terminate', () => {
  for (const text of [
    "I don't think we should end yet.",
    'Why did the discussion end?',
    'Imagine someone says end the discussion.',
    'We need to discuss when the session should end.',
  ]) assert.equal(classifyEndingIntent(text), 'none');
});

test('ending during AI generation preserves the student turn and discards the stale AI reply', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const gemini = new FlowGemini({ gate });
  await withSystem(gemini, async ({ base, sessions }) => {
    const created = await openListening(base);
    const studentText = 'AI might replace jobs faster than workers can retrain.';
    const pending = post(base, `/sessions/${created.sessionId}/messages`, { text: studentText });
    while (!gemini.calls.length) await new Promise(resolve => setTimeout(resolve, 1));
    const ending = post(base, `/sessions/${created.sessionId}/end`);
    while (!sessions.get(created.sessionId).endRequested) await new Promise(resolve => setTimeout(resolve, 1));
    release();
    const interrupted = await pending;
    assert.equal(interrupted.status, 409);
    assert.equal((await interrupted.json()).code, 'END_REQUESTED');
    const report = await (await ending).json();
    assert.ok(report.transcript.some(turn => turn.speaker === 'Student' && turn.text === studentText));
    assert.ok(!report.transcript.some(turn => turn.text.startsWith('That concern matters')));
  });
});

test('ending during speech playback requires exact cancellation before closure', async () => {
  await withSystem(new FlowGemini(), async ({ base }) => {
    const created = await openListening(base);
    const turn = (await (await post(base, `/sessions/${created.sessionId}/next`)).json()).turn;
    const blocked = await post(base, `/sessions/${created.sessionId}/end`);
    assert.equal(blocked.status, 409);
    assert.equal((await blocked.json()).code, 'PLAYBACK_IN_PROGRESS');
    assert.equal((await post(base, `/sessions/${created.sessionId}/turns/${turn.turnId}/ack`, { event: 'cancelled' })).status, 200);
    assert.equal((await post(base, `/sessions/${created.sessionId}/end`)).status, 200);
  });
});

test('an unseen generated turn can be cancelled atomically by the existing end endpoint', async () => {
  await withSystem(new FlowGemini(), async ({ base, sessions }) => {
    const created = await openListening(base);
    const generated = (await (await post(base, `/sessions/${created.sessionId}/messages`, {
      text: 'A substantive student concern should remain.',
    })).json()).turn;
    const ended = await post(base, `/sessions/${created.sessionId}/end`, { cancelPendingTurn: true });
    assert.equal(ended.status, 200);
    const report = await ended.json();
    assert.ok(report.transcript.some(turn => turn.text === 'A substantive student concern should remain.'));
    assert.ok(!report.transcript.some(turn => turn.turnId === generated.turnId));
    assert.equal(sessions.get(created.sessionId).turnEvents.get(generated.turnId), 'cancelled');
  });
});

test('no new debate turns are accepted after closure', async () => {
  await withSystem(new FlowGemini(), async ({ base }) => {
    const created = await openListening(base);
    await requestEnd(base, created.sessionId, 'Please conclude the session.');
    assert.equal((await post(base, `/sessions/${created.sessionId}/next`)).status, 409);
    assert.equal((await post(base, `/sessions/${created.sessionId}/messages`, { text: 'Continue.' })).status, 409);
  });
});

test('concurrent end requests return one cached report and one evaluation', async () => {
  const gemini = new FlowGemini();
  await withSystem(gemini, async ({ base }) => {
    const created = await openListening(base);
    const ai = (await (await post(base, `/sessions/${created.sessionId}/messages`, { text: 'Retraining access must be equitable.' })).json()).turn;
    await post(base, `/sessions/${created.sessionId}/turns/${ai.turnId}/ack`, { event: 'completed' });
    await post(base, `/sessions/${created.sessionId}/messages`, { text: "That's all, let's finish." });
    const [first, second] = await Promise.all([
      post(base, `/sessions/${created.sessionId}/end`),
      post(base, `/sessions/${created.sessionId}/end`),
    ]);
    assert.deepEqual(await first.json(), await second.json());
    assert.equal(gemini.calls.filter(call => call.responseMimeType === 'application/json').length, 1);
  });
});

test('latest student message is explicitly present in Gemini context', async () => {
  const gemini = new FlowGemini();
  await withSystem(gemini, async ({ base }) => {
    const created = await openListening(base);
    const latest = 'But what happens to people without access to education?';
    await post(base, `/sessions/${created.sessionId}/messages`, { text: latest });
    assert.match(gemini.calls[0].prompt, new RegExp(`Latest student contribution: ${latest.replace('?', '\\?')}`));
  });
});

test('recent transcript context remains chronological', async () => {
  const gemini = new FlowGemini();
  await withSystem(gemini, async ({ base }) => {
    const created = await openListening(base);
    const alex = (await (await post(base, `/sessions/${created.sessionId}/messages`, { text: 'First student point.' })).json()).turn;
    await post(base, `/sessions/${created.sessionId}/turns/${alex.turnId}/ack`, { event: 'completed' });
    await post(base, `/sessions/${created.sessionId}/messages`, { text: 'Second student point.' });
    const prompt = gemini.calls[1].prompt;
    assert.ok(prompt.indexOf('Student: First student point.') < prompt.indexOf(`Alex: ${alex.text}`));
    assert.ok(prompt.indexOf(`Alex: ${alex.text}`) < prompt.indexOf('Student: Second student point.'));
  });
});

test('Gemini context preserves accurate speaker attribution', async () => {
  const gemini = new FlowGemini();
  await withSystem(gemini, async ({ base }) => {
    const created = await openListening(base);
    const alex = (await (await post(base, `/sessions/${created.sessionId}/messages`, { text: 'Student evidence.' })).json()).turn;
    await post(base, `/sessions/${created.sessionId}/turns/${alex.turnId}/ack`, { event: 'completed' });
    await post(base, `/sessions/${created.sessionId}/next`);
    assert.match(gemini.calls[1].prompt, /Student: Student evidence\./);
    assert.match(gemini.calls[1].prompt, new RegExp(`Alex: ${alex.text}`));
  });
});

test('bounded context retains recent whole turns without excessive prompt growth', async () => {
  const gemini = new FlowGemini();
  await withSystem(gemini, async ({ base, sessions }) => {
    const created = await openListening(base);
    const session = sessions.get(created.sessionId);
    for (let index = 0; index < 40; index += 1) {
      sessions.appendTurn(session, index % 2 ? 'Alex' : 'Student', `marker-${index} ${'detail '.repeat(60)}`);
    }
    await post(base, `/sessions/${created.sessionId}/next`);
    const prompt = gemini.calls[0].prompt;
    assert.ok(prompt.length < 14_000);
    assert.doesNotMatch(prompt, /marker-0\b/);
    assert.match(prompt, /Student: marker-38\b/);
    assert.match(prompt, /Alex: marker-39\b/);
  });
});

test('feedback transcript excludes non-substantive ending commands', async () => {
  await withSystem(new FlowGemini(), async ({ base }) => {
    const created = await openListening(base);
    const ai = (await (await post(base, `/sessions/${created.sessionId}/messages`, { text: 'Workers need affordable retraining.' })).json()).turn;
    await post(base, `/sessions/${created.sessionId}/turns/${ai.turnId}/ack`, { event: 'completed' });
    const report = await (await requestEnd(base, created.sessionId, "Let's end the discussion.")).json();
    assert.equal(report.metrics.totalStudentTurns, 1);
    assert.ok(!report.transcript.some(turn => /end the discussion/i.test(turn.text)));
  });
});

test('existing exact turn acknowledgments remain valid', async () => {
  await withSystem(new FlowGemini(), async ({ base }) => {
    const created = await (await post(base, '/sessions', { topic: 'A topic' })).json();
    const response = await post(base, `/sessions/${created.sessionId}/turns/${created.turn.turnId}/ack`, { event: 'completed' });
    assert.deepEqual(await response.json(), { turnId: created.turn.turnId, event: 'completed', state: 'LISTENING' });
  });
});

test('later direct invitations influence the deterministic speaker choice', async () => {
  const gemini = new FlowGemini();
  await withSystem(gemini, async ({ base, sessions }) => {
    const created = await openListening(base);
    const session = sessions.get(created.sessionId);
    session.aiTurnCount = 7;
    sessions.appendTurn(session, 'Alex', 'A prior analytical point.');
    const response = await post(base, `/sessions/${created.sessionId}/messages`, { text: 'David, how would you bridge these concerns?' });
    assert.equal((await response.json()).turn.speaker, 'David');
  });
});

test('normal participant prompts request short conversational responses', async () => {
  const gemini = new FlowGemini();
  await withSystem(gemini, async ({ base }) => {
    const created = await openListening(base);
    await post(base, `/sessions/${created.sessionId}/next`);
    assert.match(gemini.calls[0].prompt, /target 20-45 words/);
    assert.match(gemini.calls[0].prompt, /Complete the final sentence naturally/);
    assert.equal(gemini.calls[0].maxOutputTokens, 96);
  });
});

test('requested demonstration flow stays contextual and ends without another debate turn', async () => {
  const gemini = new FlowGemini();
  await withSystem(gemini, async ({ base }) => {
    const created = await openListening(base);
    const firstText = 'AI might replace jobs faster than workers can retrain.';
    const first = (await (await post(base, `/sessions/${created.sessionId}/messages`, { text: firstText })).json()).turn;
    assert.match(gemini.calls[0].prompt, new RegExp(firstText.replace('.', '\\.')));
    await post(base, `/sessions/${created.sessionId}/turns/${first.turnId}/ack`, { event: 'completed' });

    const secondText = 'But what happens to people without access to education?';
    const second = (await (await post(base, `/sessions/${created.sessionId}/messages`, { text: secondText })).json()).turn;
    assert.match(gemini.calls[1].prompt, /Latest student contribution: But what happens to people without access to education\?/);
    await post(base, `/sessions/${created.sessionId}/turns/${second.turnId}/ack`, { event: 'completed' });

    const callsBeforeEnd = gemini.calls.length;
    const report = await (await requestEnd(base, created.sessionId, "Let's end the discussion.")).json();
    assert.equal(report.transcript.at(-1).speaker, 'Moderator');
    assert.equal(gemini.calls.filter(call => !call.responseMimeType).length, callsBeforeEnd);
  });
});
