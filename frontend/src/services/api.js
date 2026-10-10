import { DEFAULT_DISCUSSION_DURATION_MINUTES } from '../constants.js';

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

  async function requestAudio(path, { signal } = {}) {
    let response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method: 'POST',
        headers: { Accept: 'audio/mpeg', 'Content-Type': 'application/json' },
        body: '{}',
        signal,
      });
    } catch (error) {
      if (error?.name === 'AbortError') throw new ApiError('Alex voice request was cancelled.', 0, 'REQUEST_ABORTED');
      throw new ApiError('Unable to load Alex’s custom voice. Browser speech will be used.', 0, 'NETWORK_ERROR');
    }
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new ApiError(data.error || `Voice request failed (${response.status})`, response.status, data.code || 'ALEX_VOICE_UNAVAILABLE');
    }
    return response.blob();
  }

  return Object.freeze({
    request,
    checkHealth: () => request('/health'),
    createSession: (topic, durationMinutes = DEFAULT_DISCUSSION_DURATION_MINUTES) => request('/sessions', {
      method: 'POST', body: JSON.stringify({ topic, durationMinutes }),
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
    getAlexTurnAudio: (sessionId, turnId, options) => requestAudio(
      `/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/audio`,
      options,
    ),
    endSession: (sessionId, options = {}) => request(`/sessions/${encodeURIComponent(sessionId)}/end`, {
      method: 'POST', body: JSON.stringify({ cancelPendingTurn: options.cancelPendingTurn === true }),
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
export const getAlexTurnAudio = api.getAlexTurnAudio;
export const endSession = api.endSession;
