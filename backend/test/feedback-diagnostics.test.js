import assert from 'node:assert/strict';
import test from 'node:test';
import { GeminiService, GeminiServiceError } from '../src/services/gemini.service.js';
import {
  FEEDBACK_CATEGORIES,
  FeedbackService,
  FeedbackValidationError,
  classifyEvaluationFailure,
} from '../src/services/feedback.service.js';

const transcript = [{
  turnId: 'student-turn',
  speaker: 'Student',
  text: 'A real student contribution.',
  timestamp: new Date().toISOString(),
}];

const realisticTranscript = [
  { turnId: 'moderator-open', speaker: 'Moderator', text: 'Please begin.', timestamp: '2026-01-01T00:00:00.000Z' },
  { turnId: 'student-open', speaker: 'Student', text: 'AI can improve access, but institutions need clear accountability and teacher oversight.', timestamp: '2026-01-01T00:00:10.000Z' },
  { turnId: 'alex-point', speaker: 'Alex', text: 'Access gains should be measured against learning outcomes.', timestamp: '2026-01-01T00:00:20.000Z' },
  { turnId: 'student-response', speaker: 'Student', text: 'Alex, I agree measurement matters, and I would add independent audits to compare outcomes fairly.', timestamp: '2026-01-01T00:00:30.000Z' },
  { turnId: 'sarah-point', speaker: 'Sarah', text: 'Deployment should move quickly.', timestamp: '2026-01-01T00:00:40.000Z' },
  { turnId: 'student-close', speaker: 'Student', text: 'I disagree that speed should lead. In summary, access, evidence, and accountability must advance together.', timestamp: '2026-01-01T00:00:50.000Z' },
];

function realisticPayload({ closingAssessed = true } = {}) {
  const scores = [7, 8, 9, 8, 7, 9];
  return {
    feedback: FEEDBACK_CATEGORIES.map((category, index) => {
      const assessed = category !== 'closing_contribution' || closingAssessed;
      return {
        category,
        status: assessed ? 'assessed' : 'not_assessed',
        score: assessed ? scores[index] : null,
        explanation: assessed ? 'The cited student contribution demonstrates this behavior.' : 'No closing behavior was observed.',
        strength: assessed ? 'The contribution directly addresses the discussion.' : 'Not enough evidence was available.',
        improvementOpportunity: 'Develop the point with one more concrete example.',
        actionableNextStep: 'Name the prior point and add one verifiable example.',
        evidenceTurnIds: assessed ? ['student-response'] : [],
      };
    }),
    summary: 'The student contributes relevant, responsive arguments grounded in the discussion.',
    recommendations: ['Add a concrete example to each major claim.'],
  };
}

for (const [status, code] of [
  [401, 'GEMINI_INVALID_CREDENTIALS'],
  [403, 'GEMINI_PERMISSION_DENIED'],
  [404, 'GEMINI_MODEL_UNAVAILABLE'],
  [429, 'GEMINI_RATE_LIMITED'],
  [504, 'GEMINI_TIMEOUT'],
  [503, 'GEMINI_UPSTREAM_FAILURE'],
]) {
  test(`Gemini HTTP ${status} is safely classified as ${code}`, async () => {
    const gemini = new GeminiService({
      apiKey: 'test-key-never-logged',
      fetchImpl: async () => ({ ok: false, status, json: async () => ({}) }),
    });
    await assert.rejects(
      gemini.generate({ systemInstruction: 'test', prompt: 'test' }),
      error => error.code === code && !error.message.includes('test-key-never-logged'),
    );
  });
}

test('invalid-key details are classified without exposing the upstream response', async () => {
  const gemini = new GeminiService({
    apiKey: 'test-key-never-logged',
    fetchImpl: async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: { status: 'INVALID_ARGUMENT', message: 'API key not valid. Please pass a valid API key.' } }),
    }),
  });
  await assert.rejects(
    gemini.generate({ systemInstruction: 'test', prompt: 'test' }),
    error => error.code === 'GEMINI_INVALID_CREDENTIALS'
      && !error.message.includes('test-key-never-logged')
      && !error.message.includes('Please pass'),
  );
});

test('malformed and schema-invalid feedback have distinct safe categories', async () => {
  const malformed = new FeedbackService({ gemini: { async generate() { return 'not json'; } } });
  await assert.rejects(
    malformed.evaluate({ topic: 'Topic', transcript }),
    error => error instanceof FeedbackValidationError
      && classifyEvaluationFailure(error).category === 'malformed_json',
  );

  const incomplete = new FeedbackService({ gemini: { async generate() { return JSON.stringify({ feedback: [] }); } } });
  await assert.rejects(
    incomplete.evaluate({ topic: 'Topic', transcript }),
    error => error instanceof FeedbackValidationError
      && classifyEvaluationFailure(error).category === 'validation_mismatch',
  );
});

test('bounded JSON code fences are extracted before strict feedback validation', async () => {
  const payload = {
    feedback: FEEDBACK_CATEGORIES.map(category => ({
      category,
      status: 'assessed',
      score: 8,
      explanation: 'The contribution is supported by the cited student turn.',
      improvement: 'Add one contrasting example.',
      evidenceTurnIds: ['student-turn'],
    })),
    summary: 'A transcript-grounded summary.',
    recommendations: ['Add a contrasting example.'],
  };
  const service = new FeedbackService({ gemini: { async generate() { return `\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``; } } });
  const result = await service.evaluate({ topic: 'Topic', transcript });
  assert.equal(result.overallScore, 8);
});

test('evaluation requests enforce a realistic Gemini JSON schema and validate numeric scores', async () => {
  let request;
  const service = new FeedbackService({ gemini: { async generate(input) { request = input; return JSON.stringify(realisticPayload()); } } });
  const result = await service.evaluate({ topic: 'Responsible AI adoption', transcript: realisticTranscript });
  assert.equal(request.responseMimeType, 'application/json');
  assert.equal(request.maxOutputTokens, 4_096);
  assert.equal(request.timeoutMs, 30_000);
  assert.equal(request.responseJsonSchema.properties.feedback.minItems, 6);
  assert.deepEqual(request.responseJsonSchema.properties.feedback.items.properties.category.enum, FEEDBACK_CATEGORIES);
  assert.deepEqual(request.responseJsonSchema.properties.feedback.items.properties.evidenceTurnIds.items.enum, realisticTranscript.map(turn => turn.turnId));
  assert.equal(result.feedback.length, 6);
  assert.equal(result.overallScore, 8);
  assert.equal(result.feedback[0].actionableNextStep, 'Name the prior point and add one verifiable example.');
});

test('partially assessed feedback excludes not-assessed categories from the overall mean', async () => {
  const service = new FeedbackService({ gemini: { async generate() { return JSON.stringify(realisticPayload({ closingAssessed: false })); } } });
  const result = await service.evaluate({ topic: 'Responsible AI adoption', transcript: realisticTranscript });
  assert.equal(result.feedback.at(-1).status, 'not_assessed');
  assert.equal(result.feedback.at(-1).score, null);
  assert.equal(result.overallScore, 7.8);
});

test('feedback retries one timeout but never retries exhausted quota', async () => {
  let timeoutCalls = 0;
  const recovering = new FeedbackService({ gemini: { async generate() {
    timeoutCalls += 1;
    if (timeoutCalls === 1) throw new GeminiServiceError('timeout', 'GEMINI_TIMEOUT');
    return JSON.stringify(realisticPayload());
  } } });
  const result = await recovering.evaluate({ topic: 'Responsible AI adoption', transcript: realisticTranscript });
  assert.equal(timeoutCalls, 2);
  assert.equal(result.overallScore, 8);

  let quotaCalls = 0;
  const exhausted = new FeedbackService({ gemini: { async generate() {
    quotaCalls += 1;
    throw new GeminiServiceError('quota', 'GEMINI_RATE_LIMITED');
  } } });
  await assert.rejects(exhausted.evaluate({ topic: 'Responsible AI adoption', transcript: realisticTranscript }), { code: 'GEMINI_RATE_LIMITED' });
  assert.equal(quotaCalls, 1);
});

test('Gemini REST request forwards responseJsonSchema without changing ordinary text calls', async () => {
  let requestBody;
  const gemini = new GeminiService({
    apiKey: 'test-key-never-logged',
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] }) };
    },
  });
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] };
  await gemini.generate({ systemInstruction: 'test', prompt: 'test', responseMimeType: 'application/json', responseJsonSchema: schema });
  assert.deepEqual(requestBody.generationConfig.responseJsonSchema, schema);
  assert.equal(requestBody.generationConfig.responseMimeType, 'application/json');
});
