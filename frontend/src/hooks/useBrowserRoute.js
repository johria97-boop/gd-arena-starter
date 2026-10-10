import { useCallback, useEffect, useState } from 'react';
import { normalizePath, subscribeToHistory, updateBrowserHistory } from '../services/navigation.js';

function readRoute() {
  if (typeof window === 'undefined') return { path: '/', state: null };
  return { path: normalizePath(window.location.pathname), state: window.history.state };
}

export function useBrowserRoute() {
  const [route, setRoute] = useState(readRoute);

  useEffect(() => {
    return subscribeToHistory(window, setRoute);
  }, []);

  const navigate = useCallback((destination, options = {}) => {
    const path = updateBrowserHistory(window, destination, options);
    setRoute({ path, state: options.state || null });
  }, []);

  return { ...route, navigate };
}
