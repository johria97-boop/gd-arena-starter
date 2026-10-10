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

  async generate({ systemInstruction, prompt, maxOutputTokens = 180, responseMimeType }) {
    if (!this.apiKey) {
      throw new GeminiServiceError('AI service is not configured', 'GEMINI_NOT_CONFIGURED');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const generationConfig = {
        maxOutputTokens: Math.min(Math.max(Number(maxOutputTokens) || 180, 64), 4_096),
      };
      if (responseMimeType) generationConfig.responseMimeType = responseMimeType;
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
        const code = response.status === 429 ? 'GEMINI_RATE_LIMITED' : 'GEMINI_API_ERROR';
        throw new GeminiServiceError(
          response.status === 429
            ? 'AI service is busy; please try again shortly'
            : 'AI service is temporarily unavailable',
          code,
        );
      }

      const payload = await response.json();
      const parts = payload?.candidates?.[0]?.content?.parts;
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
      throw new GeminiServiceError('AI service is temporarily unavailable');
    } finally {
      clearTimeout(timeout);
    }
  }
}
