import assert from 'node:assert/strict';
import test from 'node:test';
import { activatePracticeSetup, normalizePath, resolveAppRoute, ROUTES, subscribeToHistory, updateBrowserHistory } from '../src/services/navigation.js';

function fakeBrowser(start = '/') {
  const listeners = new Set();
  const calls = [];
  const browser = {
    location: { pathname: start },
    history: {
      state: null,
      pushState(state, unused, path) { calls.push(['push', path]); this.state = state; browser.location.pathname = path; },
      replaceState(state, unused, path) { calls.push(['replace', path]); this.state = state; browser.location.pathname = path; },
    },
    addEventListener(type, listener) { if (type === 'popstate') listeners.add(listener); },
    removeEventListener(type, listener) { if (type === 'popstate') listeners.delete(listener); },
    pop(path, state = null) { this.location.pathname = path; this.history.state = state; listeners.forEach(listener => listener()); },
  };
  return { browser, calls, listeners };
}

test('home, how-it-works, and setup are stable direct routes', () => {
  assert.equal(normalizePath('/'), ROUTES.home);
  assert.equal(normalizePath('/how-it-works/'), ROUTES.how);
  assert.equal(normalizePath('/setup?from=home'), ROUTES.setup);
});

test('unknown direct routes recover to home', () => {
  assert.equal(normalizePath('/missing-page'), ROUTES.home);
});

test('starting a discussion pushes the dedicated room route', () => {
  const { browser, calls } = fakeBrowser(ROUTES.setup);
  assert.equal(updateBrowserHistory(browser, ROUTES.discussion), ROUTES.discussion);
  assert.deepEqual(calls, [['push', ROUTES.discussion]]);
});

test('an active session may render the discussion route', () => {
  assert.deepEqual(resolveAppRoute(ROUTES.discussion, { hasSession: true }), { path: ROUTES.discussion });
});

test('missing discussion state redirects to setup with recovery guidance', () => {
  const result = resolveAppRoute(ROUTES.discussion);
  assert.equal(result.path, ROUTES.setup);
  assert.equal(result.redirect, ROUTES.setup);
  assert.match(result.notice, /No active discussion/i);
});

test('report routing preserves valid reports and exposes a safe empty state', () => {
  assert.deepEqual(resolveAppRoute(ROUTES.report, { hasReport: true }), { path: ROUTES.report });
  assert.deepEqual(resolveAppRoute(ROUTES.report), { path: ROUTES.report, emptyReport: true });
});

test('redirect replacements carry route recovery state', () => {
  const { browser, calls } = fakeBrowser(ROUTES.discussion);
  updateBrowserHistory(browser, ROUTES.setup, { replace: true, state: { notice: 'recover' } });
  assert.deepEqual(calls, [['replace', ROUTES.setup]]);
  assert.deepEqual(browser.history.state, { notice: 'recover' });
});

test('browser back and forward popstate updates are observed and cleaned up', () => {
  const { browser, listeners } = fakeBrowser(ROUTES.setup);
  const routes = [];
  const unsubscribe = subscribeToHistory(browser, route => routes.push(route));
  browser.pop(ROUTES.home);
  browser.pop(ROUTES.how, { source: 'forward' });
  assert.deepEqual(routes, [{ path: ROUTES.home, state: null }, { path: ROUTES.how, state: { source: 'forward' } }]);
  unsubscribe();
  assert.equal(listeners.size, 0);
});

for (const currentPath of [ROUTES.home, ROUTES.how]) {
  test(`header Start Practicing navigates from ${currentPath}`, () => {
    const destinations = [];
    const result = activatePracticeSetup({ currentPath, navigate: path => destinations.push(path), documentRef: null });
    assert.equal(result, 'navigated');
    assert.deepEqual(destinations, [ROUTES.setup]);
  });
}

test('header Start Practicing focuses the real discussion action while already on setup', () => {
  const events = [];
  const start = {
    scrollIntoView(options) { events.push(['scroll', options.block]); },
    focus(options) { events.push(['focus', options.preventScroll]); },
  };
  const result = activatePracticeSetup({
    currentPath: ROUTES.setup,
    navigate() { events.push(['navigate']); },
    documentRef: { getElementById(id) { assert.equal(id, 'practice-start'); return start; } },
  });
  assert.equal(result, 'focused');
  assert.deepEqual(events, [['scroll', 'center'], ['focus', true]]);
});

test('starting practice from a report clears completed state before opening setup', () => {
  const events = [];
  activatePracticeSetup({
    currentPath: ROUTES.report,
    onLeaveReport: () => events.push('reset'),
    navigate: path => events.push(path),
    documentRef: null,
  });
  assert.deepEqual(events, ['reset', ROUTES.setup]);
});
