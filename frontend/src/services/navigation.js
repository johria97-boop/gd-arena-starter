export const ROUTES = Object.freeze({
  home: '/',
  how: '/how-it-works',
  setup: '/setup',
  discussion: '/discussion',
  report: '/report',
});

const KNOWN_ROUTES = new Set(Object.values(ROUTES));

export function normalizePath(pathname = '/') {
  const clean = `/${String(pathname).split(/[?#]/)[0].split('/').filter(Boolean).join('/')}`;
  const path = clean === '/' ? clean : clean.replace(/\/$/, '');
  return KNOWN_ROUTES.has(path) ? path : ROUTES.home;
}

export function resolveAppRoute(pathname, { hasSession = false, hasReport = false } = {}) {
  const path = normalizePath(pathname);
  if (path === ROUTES.discussion && !hasSession) {
    return {
      path: ROUTES.setup,
      redirect: ROUTES.setup,
      notice: 'No active discussion was found. Start a new practice session to enter the room.',
    };
  }
  if (path === ROUTES.report && !hasReport) {
    return { path, emptyReport: true };
  }
  return { path };
}

export function updateBrowserHistory(browserWindow, destination, { replace = false, state = null } = {}) {
  const path = normalizePath(destination);
  browserWindow.history[replace ? 'replaceState' : 'pushState'](state, '', path);
  return path;
}

export function activatePracticeSetup({ currentPath, navigate, documentRef = globalThis.document, onLeaveReport }) {
  const path = normalizePath(currentPath);
  if (path === ROUTES.setup) {
    const start = documentRef?.getElementById('practice-start');
    start?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    start?.focus?.({ preventScroll: true });
    return 'focused';
  }
  if (path === ROUTES.report) onLeaveReport?.();
  navigate(ROUTES.setup);
  return 'navigated';
}

export function subscribeToHistory(browserWindow, callback) {
  const handlePopState = () => callback({
    path: normalizePath(browserWindow.location.pathname),
    state: browserWindow.history.state,
  });
  browserWindow.addEventListener('popstate', handlePopState);
  return () => browserWindow.removeEventListener('popstate', handlePopState);
}
