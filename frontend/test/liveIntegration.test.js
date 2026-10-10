import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer as createViteServer } from 'vite';
import { createApp } from '../../backend/src/app.js';
import { FEEDBACK_CATEGORIES } from '../../backend/src/services/feedback.service.js';
import { GeminiServiceError } from '../../backend/src/services/gemini.service.js';
import { ApiError, createApiClient } from '../src/services/api.js';

class IntegrationGemini {
  constructor({ failures = 0, failureCode = 'GEMINI_UNAVAILABLE' } = {}) {
    this.calls = [];
    this.failures = failures;
    this.failureCode = failureCode;
  }

  async generate(input) {
    this.calls.push(input);
    if (input.responseMimeType === 'application/json') {
      const request = JSON.parse(input.prompt);
      const studentId = request.transcript.find(turn => turn.speaker === 'Student').turnId;
      return JSON.stringify({
        feedback: FEEDBACK_CATEGORIES.map((category, index) => ({
          category,
          status: 'assessed',
          score: 6 + (index % 3),
          explanation: 'The student made a relevant, transcript-supported contribution.',
          strength: 'The student directly responds to transcript evidence.',
          improvementOpportunity: 'The argument would benefit from a more concrete example.',
          actionableNextStep: 'Name the prior speaker and add one verifiable example.',
          improvement: 'Connect the next point to a named speaker and add one concrete example.',
          evidenceTurnIds: [studentId],
        })),
        summary: 'The student contributed relevant ideas and can make speaker connections more explicit.',
        recommendations: ['Name the prior speaker.', 'Support the main claim with one concrete example.'],
      });
    }
    if (this.failures > 0) {
      this.failures -= 1;
      const message = this.failureCode === 'GEMINI_RATE_LIMITED'
        ? 'AI service is busy; please try again shortly'
        : 'AI service is temporarily unavailable';
      throw new GeminiServiceError(message, this.failureCode);
    }
    const speaker = input.prompt.match(/Now contribute as (Alex|Sarah|David|Moderator)/)?.[1] || 'Participant';
    return `${speaker} responds directly to the previous contribution with a focused point.`;
  }
}

async function withApi(gemini, run) {
  const server = createApp({ gemini }).listen(0);
  try {
    const { port } = server.address();
    await run(createApiClient({ baseUrl: `http://127.0.0.1:${port}/api` }), gemini);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('complete client contract supports opening, discussion, interruption, closing, and feedback', async () => {
  await withApi(new IntegrationGemini(), async (api, gemini) => {
    const created = await api.createSession('Should AI reshape professional education?');
    assert.equal(created.turn.speaker, 'Moderator');
    await api.acknowledgeTurn(created.sessionId, created.turn.turnId, 'completed');
    await assert.rejects(
      api.acknowledgeTurn(created.sessionId, created.turn.turnId, 'completed'),
      error => error instanceof ApiError && error.code === 'DUPLICATE_TURN_EVENT',
    );

    const firstAi = (await api.sendStudentMessage(created.sessionId, 'AI should expand access while teachers guide its use.')).turn;
    assert.ok(['Alex', 'Sarah', 'David'].includes(firstAi.speaker));
    await api.acknowledgeTurn(created.sessionId, firstAi.turnId, 'completed');

    const secondAi = (await api.requestNextTurn(created.sessionId)).turn;
    assert.ok(['Alex', 'Sarah', 'David'].includes(secondAi.speaker));
    assert.notEqual(secondAi.speaker, firstAi.speaker);
    assert.match(gemini.calls.at(-1).prompt, new RegExp(`${firstAi.speaker}: ${firstAi.speaker} responds directly`));
    await api.acknowledgeTurn(created.sessionId, secondAi.turnId, 'completed');

    const thirdAi = (await api.requestNextTurn(created.sessionId)).turn;
    assert.ok(['Alex', 'Sarah', 'David'].includes(thirdAi.speaker));
    assert.ok(new Set([firstAi.speaker, secondAi.speaker, thirdAi.speaker]).size >= 2);
    await api.acknowledgeTurn(created.sessionId, thirdAi.turnId, 'cancelled');

    const resumed = (await api.sendStudentMessage(created.sessionId, 'Sarah, I agree on safeguards, but access should remain central.')).turn;
    assert.ok(['Alex', 'Sarah', 'David'].includes(resumed.speaker));
    await api.acknowledgeTurn(created.sessionId, resumed.turnId, 'completed');

    const report = await api.endSession(created.sessionId);
    assert.equal(report.status, 'complete');
    assert.equal(report.feedback.length, 6);
    assert.equal(report.transcript.at(-1).speaker, 'Moderator');
    assert.ok(report.transcript.some(turn => turn.speaker === 'Student'));
    assert.ok(!report.transcript.some(turn => turn.turnId === thirdAi.turnId));
    await assertReportRenders(report);
  });
});

test('Gemini rate limits are structured, recoverable, and do not retain failed student text', async () => {
  await withApi(new IntegrationGemini({ failures: 1, failureCode: 'GEMINI_RATE_LIMITED' }), async api => {
    const created = await api.createSession('Can responsible AI improve education?');
    await api.acknowledgeTurn(created.sessionId, created.turn.turnId, 'completed');
    await assert.rejects(
      api.sendStudentMessage(created.sessionId, 'This contribution should roll back if generation fails.'),
      error => error instanceof ApiError && error.code === 'GEMINI_RATE_LIMITED',
    );
    const recovered = (await api.requestNextTurn(created.sessionId)).turn;
    assert.equal(recovered.speaker, 'Alex');
    await api.acknowledgeTurn(created.sessionId, recovered.turnId, 'completed');
    const report = await api.endSession(created.sessionId);
    assert.equal(report.status, 'insufficient_evidence');
    assert.equal(report.metrics.totalStudentTurns, 0);
  });
});

test('ending intent stops debate generation and reuses the existing report endpoint', async () => {
  await withApi(new IntegrationGemini(), async (api, gemini) => {
    const created = await api.createSession('Will AI create more jobs than it replaces?');
    await api.acknowledgeTurn(created.sessionId, created.turn.turnId, 'completed');
    const intent = await api.sendStudentMessage(created.sessionId, "Let's end the discussion.");
    assert.deepEqual(intent, { endRequested: true });
    assert.equal(gemini.calls.length, 0);
    const report = await api.endSession(created.sessionId);
    assert.equal(report.status, 'insufficient_evidence');
    assert.ok(!report.transcript.some(turn => /end the discussion/i.test(turn.text)));
  });
});

test('network failures become stable frontend API errors', async () => {
  const api = createApiClient({
    baseUrl: 'http://unreachable.invalid/api',
    fetchImpl: async () => { throw new TypeError('socket unavailable'); },
  });
  await assert.rejects(
    api.checkHealth(),
    error => error instanceof ApiError && error.code === 'NETWORK_ERROR' && error.status === 0,
  );
});

test('Alex audio client requests the exact turn as binary without exposing credentials', async () => {
  const calls = [];
  const api = createApiClient({
    baseUrl: 'http://voice.test/api',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, blob: async () => new Blob(['mock-audio']) };
    },
  });
  const audio = await api.getAlexTurnAudio('session/id', 'turn/id');
  assert.equal(audio.size, 10);
  assert.equal(calls[0].url, 'http://voice.test/api/sessions/session%2Fid/turns/turn%2Fid/audio');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.body, '{}');
  assert.ok(!JSON.stringify(calls[0]).includes('apiKey'));
});

test('client sends exact interruption IDs and opts into automatic continuation metadata', async () => {
  const calls = [];
  const api = createApiClient({
    baseUrl: 'http://discussion.test/api',
    fetchImpl: async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body) });
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    },
  });
  await api.sendStudentMessage('session-id', 'My point', { interruptTurnId: 'active-turn' });
  await api.requestNextTurn('session-id', { interruptTurnId: 'ai-turn' });
  await api.acknowledgeTurn('session-id', 'turn-id', 'completed');
  assert.deepEqual(calls[0].body, { text: 'My point', interruptTurnId: 'active-turn' });
  assert.deepEqual(calls[1].body, { interruptTurnId: 'ai-turn' });
  assert.deepEqual(calls[2].body, { event: 'completed', requestContinuation: true });
});

test('discussion room keeps typed interruption available while an AI turn is active', async () => {
  const vite = await createViteServer({
    root: path.resolve(process.cwd()), logLevel: 'silent',
    server: { middlewareMode: true }, appType: 'custom',
  });
  try {
    const { default: DiscussionScreen } = await vite.ssrLoadModule('/src/screens/DiscussionScreen.jsx');
    const activeTurn = { turnId: 'active-turn', speaker: 'Sarah', text: 'A current AI contribution.', timestamp: new Date().toISOString() };
    const html = renderToStaticMarkup(createElement(DiscussionScreen, {
      session: { sessionId: 'session-id', topic: 'Topic', transcript: [activeTurn], activeTurn, deadlineAt: Date.now() + 60_000 },
      busy: false, error: '', draft: 'I want to respond now.',
      onDraftChange() {}, onStudentIntent() {}, onListeningChange() {}, onClearError() {}, onVoiceError() {},
      onSend() {}, onNext() {}, onAcknowledge() {}, onEnd() {},
    }));
    assert.match(html, /Talk \/ interrupt/);
    const sendButton = html.match(/<button class="send-button"[^>]*>/)?.[0] || '';
    assert.match(sendButton, /aria-label="Send contribution"/);
    assert.doesNotMatch(sendButton, /disabled/);
  } finally {
    await vite.close();
  }
});

async function assertReportRenders(report) {
  const vite = await createViteServer({
    root: path.resolve(process.cwd()),
    logLevel: 'silent',
    server: { middlewareMode: true },
    appType: 'custom',
  });
  try {
    const { default: FeedbackScreen } = await vite.ssrLoadModule('/src/screens/FeedbackScreen.jsx');
    const html = renderToStaticMarkup(createElement(FeedbackScreen, {
      report,
      topic: 'Should AI reshape professional education?',
      isMock: false,
      onRestart() {},
    }));
    assert.match(html, /grounded in evidence/i);
    assert.match(html, /The student contributed relevant ideas/);
    assert.match(html, /Evidence transcript/);
    assert.match(html, /communication clarity/i);
    assert.match(html, /What to strengthen/);
    assert.match(html, /Book Your Next Practice Slot/);
    assert.match(html, /not a server-side reservation/i);
    assert.match(html, new RegExp(`turn-${report.feedback.find(item => item.evidenceTurnIds.length).evidenceTurnIds[0]}`));

    assert.match(html, /Overall assessed score/);
    assert.match(html, />7</);
    assert.match(html, /out of 10/);
    assert.match(html, /Strength/);
    assert.match(html, /Opportunity/);
    assert.match(html, /Next move/);
    assert.match(html, /directly responds to transcript evidence/);
    assert.match(html, /benefit from a more concrete example/);
    assert.match(html, /Name the prior speaker and add one verifiable example/);

    const partial = renderToStaticMarkup(createElement(FeedbackScreen, { report: { ...report, status: 'partial', overallScore: null, evaluationError: { message: 'AI feedback generation timed out.' } }, topic: 'Topic', isMock: false, onRestart() {} }));
    const insufficient = renderToStaticMarkup(createElement(FeedbackScreen, { report: { ...report, status: 'insufficient_evidence', overallScore: null }, topic: 'Topic', isMock: false, onRestart() {} }));
    assert.match(partial, /Partial evaluation/);
    assert.match(partial, /Feedback unavailable/);
    assert.match(partial, /timed out/);
    assert.match(insufficient, /Not enough evidence/);
    assert.doesNotMatch(insufficient, /out of 10/);
  } finally {
    await vite.close();
  }
}
