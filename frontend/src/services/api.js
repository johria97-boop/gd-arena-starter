const DEFAULT_BASE_URL = (import.meta.env?.VITE_API_BASE_URL || 'http://localhost:4000/api').replace(/\/$/, '');

export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export function createApiClient({ baseUrl = DEFAULT_BASE_URL, fetchImpl = globalThis.fetch } = {}) {
  const base = baseUrl.replace(/\/$/, '');

  async function request(path, options = {}) {
    let response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        ...options,
        headers: { 'Content-Type': 'application/json', ...options.headers },
      });
    } catch {
      throw new ApiError('Unable to reach the discussion server. Check your connection and try again.', 0, 'NETWORK_ERROR');
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new ApiError(data.error || `Request failed (${response.status})`, response.status, data.code || 'REQUEST_FAILED');
    }
    return data;
  }

  return Object.freeze({
    request,
    checkHealth: () => request('/health'),
    createSession: topic => request('/sessions', {
      method: 'POST', body: JSON.stringify({ topic }),
    }),
    sendStudentMessage: (sessionId, text) => request(`/sessions/${encodeURIComponent(sessionId)}/messages`, {
      method: 'POST', body: JSON.stringify({ text }),
    }),
    requestNextTurn: sessionId => request(`/sessions/${encodeURIComponent(sessionId)}/next`, {
      method: 'POST', body: '{}',
    }),
    acknowledgeTurn: (sessionId, turnId, event) => request(
      `/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/ack`,
      { method: 'POST', body: JSON.stringify({ event }) },
    ),
    endSession: sessionId => request(`/sessions/${encodeURIComponent(sessionId)}/end`, {
      method: 'POST', body: '{}',
    }),
  });
}

const api = createApiClient();

export const apiRequest = api.request;
export const checkHealth = api.checkHealth;
export const createSession = api.createSession;
export const sendStudentMessage = api.sendStudentMessage;
export const requestNextTurn = api.requestNextTurn;
export const acknowledgeTurn = api.acknowledgeTurn;
export const endSession = api.endSession;
