const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_TIMEOUT_MS = 15_000;

export class GeminiServiceError extends Error {
  constructor(message, code = 'GEMINI_UNAVAILABLE') {
    super(message);
    this.name = 'GeminiServiceError';
    this.code = code;
    this.status = 503;
  }
}

function upstreamHint(payload) {
  const details = Array.isArray(payload?.error?.details) ? payload.error.details : [];
  return [payload?.error?.status, payload?.error?.message, ...details.map(item => item?.reason)].filter(Boolean).join(' ');
}

function upstreamFailure(status, hint = '') {
  if (/API_KEY_INVALID|API key not valid|UNAUTHENTICATED/i.test(hint)) return ['AI credentials were rejected', 'GEMINI_INVALID_CREDENTIALS'];
  if (/RESOURCE_EXHAUSTED|quota/i.test(hint)) return ['AI quota or rate limit was reached; please try again later', 'GEMINI_RATE_LIMITED'];
  if (/model.+(?:not found|unavailable)|NOT_FOUND/i.test(hint)) return ['The configured AI model is unavailable', 'GEMINI_MODEL_UNAVAILABLE'];
  if (status === 401) return ['AI credentials were rejected', 'GEMINI_INVALID_CREDENTIALS'];
  if (status === 403) return ['AI credentials do not have permission for this request', 'GEMINI_PERMISSION_DENIED'];
  if (status === 404) return ['The configured AI model is unavailable', 'GEMINI_MODEL_UNAVAILABLE'];
  if (status === 429) return ['AI quota or rate limit was reached; please try again later', 'GEMINI_RATE_LIMITED'];
  if ([408, 504].includes(status)) return ['AI service request timed out', 'GEMINI_TIMEOUT'];
  if (status === 400) return ['The AI service rejected the evaluation request', 'GEMINI_REQUEST_REJECTED'];
  if (status >= 500) return ['AI service is temporarily unavailable', 'GEMINI_UPSTREAM_FAILURE'];
  return ['AI service request failed', 'GEMINI_API_ERROR'];
}

export class GeminiService {
  constructor({
    apiKey = process.env.GEMINI_API_KEY,
    model = process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = globalThis.fetch,
  } = {}) {
    this.apiKey = apiKey;
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
  }

  async generate({
    systemInstruction,
    prompt,
    maxOutputTokens = 180,
    responseMimeType,
    responseJsonSchema,
    timeoutMs = this.timeoutMs,
  }) {
    if (!this.apiKey) {
      throw new GeminiServiceError('AI service is not configured', 'GEMINI_NOT_CONFIGURED');
    }

    const controller = new AbortController();
    const boundedTimeout = Math.min(Math.max(Number(timeoutMs) || this.timeoutMs, 1_000), 30_000);
    const timeout = setTimeout(() => controller.abort(), boundedTimeout);
    try {
      const generationConfig = {
        maxOutputTokens: Math.min(Math.max(Number(maxOutputTokens) || 180, 64), 4_096),
      };
      if (responseMimeType) generationConfig.responseMimeType = responseMimeType;
      if (responseJsonSchema) generationConfig.responseJsonSchema = responseJsonSchema;
      const response = await this.fetch(
        `${API_ROOT}/${encodeURIComponent(this.model)}:generateContent`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': this.apiKey,
          },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemInstruction }] },
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig,
          }),
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        let errorPayload = null;
        try {
          if (typeof response.json === 'function') errorPayload = await response.json();
        } catch {
          // Classification can safely fall back to HTTP status alone.
        }
        const [message, code] = upstreamFailure(response.status, upstreamHint(errorPayload));
        throw new GeminiServiceError(message, code);
      }

      const payload = await response.json();
      const candidate = payload?.candidates?.[0];
      if (candidate?.finishReason === 'MAX_TOKENS') {
        throw new GeminiServiceError('AI service returned an incomplete response', 'GEMINI_OUTPUT_TRUNCATED');
      }
      const parts = candidate?.content?.parts;
      const text = Array.isArray(parts)
        ? parts.map(part => part?.text).filter(Boolean).join('').trim()
        : '';
      if (!text) throw new GeminiServiceError('AI service returned an invalid response', 'GEMINI_INVALID_RESPONSE');
      return text;
    } catch (error) {
      if (error instanceof GeminiServiceError) throw error;
      if (error?.name === 'AbortError') {
        throw new GeminiServiceError('AI service request timed out', 'GEMINI_TIMEOUT');
      }
      throw new GeminiServiceError('Unable to reach the AI service', 'GEMINI_NETWORK_ERROR');
    } finally {
      clearTimeout(timeout);
    }
  }
}
