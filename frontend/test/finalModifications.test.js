import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { createApiClient } from '../src/services/api.js';
import { DEFAULT_DISCUSSION_DURATION_MINUTES, secondsUntilDeadline } from '../src/constants.js';
import { loadPracticeBooking, PRACTICE_BOOKING_KEY, savePracticeBooking } from '../src/services/practiceBooking.js';

test('practice setup and API use a five-minute default', async () => {
  assert.equal(DEFAULT_DISCUSSION_DURATION_MINUTES, 5);
  let body;
  const api = createApiClient({
    baseUrl: 'http://test.invalid/api',
    fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body);
      return { ok: true, status: 201, json: async () => ({ sessionId: 'id', turn: {} }) };
    },
  });
  await api.createSession('Topic');
  assert.deepEqual(body, { topic: 'Topic', durationMinutes: 5 });
});

test('remaining-time calculation reaches zero at the configured deadline', () => {
  assert.equal(secondsUntilDeadline(301_000, 1_000), 300);
  assert.equal(secondsUntilDeadline(1_000, 1_001), 0);
});

test('next practice booking is validated and persisted only in local storage', () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value) };
  const booking = { date: '2026-10-20', time: '18:30' };
  assert.equal(savePracticeBooking(booking, storage), true);
  assert.deepEqual(loadPracticeBooking(storage), booking);
  assert.ok(values.has(PRACTICE_BOOKING_KEY));
  assert.equal(savePracticeBooking({ date: 'tomorrow', time: 'later' }, storage), false);
});

test('global typography uses Times New Roman with a 2pt CSS lift', () => {
  const root = path.resolve(process.cwd(), 'src');
  const globalCss = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  assert.match(globalCss, /font-family: "Times New Roman", Times, serif/);
  assert.match(globalCss, /--font-lift: 2\.67px/);
  for (const file of ['styles.css', 'styles/setup.css', 'styles/discussion.css', 'styles/report.css']) {
    const css = fs.readFileSync(path.join(root, file), 'utf8');
    assert.doesNotMatch(css, /font-size:\s*(?!0\b)[0-9.]+px/);
  }
});
