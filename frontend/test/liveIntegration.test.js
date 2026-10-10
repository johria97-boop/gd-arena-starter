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

    const alex = (await api.sendStudentMessage(created.sessionId, 'AI should expand access while teachers guide its use.')).turn;
    assert.equal(alex.speaker, 'Alex');
    await api.acknowledgeTurn(created.sessionId, alex.turnId, 'completed');

    const sarah = (await api.requestNextTurn(created.sessionId)).turn;
    assert.equal(sarah.speaker, 'Sarah');
    assert.match(gemini.calls.at(-1).prompt, /Alex: Alex responds directly/);
    await api.acknowledgeTurn(created.sessionId, sarah.turnId, 'completed');

    const david = (await api.requestNextTurn(created.sessionId)).turn;
    assert.equal(david.speaker, 'David');
    await api.acknowledgeTurn(created.sessionId, david.turnId, 'cancelled');

    const resumed = (await api.sendStudentMessage(created.sessionId, 'Sarah, I agree on safeguards, but access should remain central.')).turn;
    assert.equal(resumed.speaker, 'Alex');
    await api.acknowledgeTurn(created.sessionId, resumed.turnId, 'completed');

    const report = await api.endSession(created.sessionId);
    assert.equal(report.status, 'complete');
    assert.equal(report.feedback.length, 6);
    assert.equal(report.transcript.at(-1).speaker, 'Moderator');
    assert.ok(report.transcript.some(turn => turn.speaker === 'Student'));
    assert.ok(!report.transcript.some(turn => turn.turnId === david.turnId));
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
    assert.match(html, new RegExp(`turn-${report.feedback.find(item => item.evidenceTurnIds.length).evidenceTurnIds[0]}`));

    const partial = renderToStaticMarkup(createElement(FeedbackScreen, { report: { ...report, status: 'partial' }, topic: 'Topic', isMock: false, onRestart() {} }));
    const insufficient = renderToStaticMarkup(createElement(FeedbackScreen, { report: { ...report, status: 'insufficient_evidence' }, topic: 'Topic', isMock: false, onRestart() {} }));
    assert.match(partial, /Partial evaluation/);
    assert.match(insufficient, /Not enough evidence/);
  } finally {
    await vite.close();
  }
}
