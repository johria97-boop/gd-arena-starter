const API_ROOT = 'https://api.elevenlabs.io/v1/text-to-speech';
const ALEX_VOICE_ID = 'r0imMlXQMfKJCEU7ezMP';
const DEFAULT_MODEL = 'eleven_flash_v2_5';
const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_TEXT_LENGTH = 2_000;
const MAX_AUDIO_BYTES = 1_000_000;
const MAX_CACHE_ENTRIES = 20;
const MAX_ERROR_BODY_BYTES = 16_000;

export class TtsServiceError extends Error {
  constructor(message, status = 503, code = 'ALEX_VOICE_UNAVAILABLE') {
    super(message);
    this.name = 'TtsServiceError';
    this.status = status;
    this.code = code;
  }
}

async function readBoundedAudio(response, maxBytes) {
  if (Number(response.headers.get('content-length')) > maxBytes) {
    throw new TtsServiceError('Custom voice response was too large', 502, 'ALEX_VOICE_INVALID_RESPONSE');
  }
  if (!response.body?.getReader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw new TtsServiceError('Custom voice response was too large', 502, 'ALEX_VOICE_INVALID_RESPONSE');
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new TtsServiceError('Custom voice response was too large', 502, 'ALEX_VOICE_INVALID_RESPONSE');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, size);
}

function safeDiagnosticToken(value, fallback = null) {
  return typeof value === 'string' && value.length <= 100 && /^[a-z0-9_.-]+$/i.test(value)
    ? value
    : fallback;
}

async function boundedErrorText(response) {
  if (Number(response.headers.get('content-length')) > MAX_ERROR_BODY_BYTES) return '';
  if (!response.body?.getReader) {
    const text = await response.text();
    return Buffer.byteLength(text) <= MAX_ERROR_BODY_BYTES ? text : '';
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    size += value.byteLength;
    if (size > MAX_ERROR_BODY_BYTES) {
      await reader.cancel();
      return '';
    }
    text += decoder.decode(value, { stream: true });
  }
}

async function upstreamErrorCode(response) {
  try {
    const text = await boundedErrorText(response);
    if (!text) return null;
    const payload = JSON.parse(text);
    const detail = payload?.detail;
    const candidates = [
      detail?.status, detail?.code, detail?.type,
      payload?.status, payload?.code, payload?.type,
    ];
    const code = candidates.find(value => safeDiagnosticToken(value));
    return code?.toLowerCase() || null;
  } catch {
    return null;
  }
}

function classifyUpstreamError(status, code) {
  if (['insufficient_credits', 'quota_exceeded', 'payment_required'].includes(code) || status === 402) {
    return ['insufficient_credits', 'ALEX_VOICE_INSUFFICIENT_CREDITS', 'Alex custom voice has insufficient credits; using browser speech'];
  }
  if (['voice_not_found', 'voice_access_denied'].includes(code) || status === 404) {
    return ['voice_inaccessible', 'ALEX_VOICE_INACCESSIBLE', 'Alex custom voice is unavailable to this account; using browser speech'];
  }
  if (['rate_limit_exceeded', 'concurrent_limit_exceeded', 'system_busy'].includes(code) || status === 429) {
    return ['rate_limited', 'ALEX_VOICE_RATE_LIMITED', 'Alex custom voice is busy; using browser speech'];
  }
  if (['invalid_api_key', 'missing_api_key', 'api_key_id_used_as_api_key', 'authentication_error'].includes(code) || status === 401) {
    return ['invalid_credentials', 'ALEX_VOICE_INVALID_CREDENTIALS', 'Alex custom voice credentials were rejected; using browser speech'];
  }
  if (['forbidden', 'insufficient_permissions', 'model_access_denied'].includes(code) || status === 403) {
    return ['permission_denied', 'ALEX_VOICE_PERMISSION_DENIED', 'Alex custom voice permission was denied; using browser speech'];
  }
  if ([408, 504].includes(status)) {
    return ['timeout', 'ALEX_VOICE_TIMEOUT', 'Alex custom voice timed out; using browser speech'];
  }
  if (status >= 500) {
    return ['upstream_service_failure', 'ALEX_VOICE_UPSTREAM_FAILURE', 'Alex custom voice service is temporarily unavailable'];
  }
  return ['upstream_request_rejected', 'ALEX_VOICE_UPSTREAM_REJECTED', 'Alex custom voice request was rejected; using browser speech'];
}

export class ElevenLabsTtsService {
  constructor({
    apiKey = process.env.ELEVENLABS_API_KEY,
    model = process.env.ELEVENLABS_MODEL || DEFAULT_MODEL,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = globalThis.fetch,
    maxCacheEntries = MAX_CACHE_ENTRIES,
    logger = console,
  } = {}) {
    this.apiKey = apiKey?.trim();
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
    this.maxCacheEntries = maxCacheEntries;
    this.logger = logger;
    this.cache = new Map();
    this.inflight = new Map();
    this.released = new Set();
  }

  diagnose(category, details = {}) {
    this.logger.warn?.('[alex-tts]', JSON.stringify({
      event: 'synthesis_failed',
      provider: 'elevenlabs',
      category,
      voiceId: ALEX_VOICE_ID,
      model: safeDiagnosticToken(this.model, 'invalid_model_value'),
      ...details,
    }));
  }

  async audioForTurn({ sessionId, turnId, text }) {
    const key = `${sessionId}:${turnId}`;
    if (this.cache.has(key)) {
      const audio = this.cache.get(key);
      this.cache.delete(key);
      this.cache.set(key, audio);
      return audio;
    }
    if (this.inflight.has(key)) return this.inflight.get(key);
    const request = this.synthesize(text).then(audio => {
      if (!this.released.has(key)) {
        this.cache.set(key, audio);
        while (this.cache.size > this.maxCacheEntries) this.cache.delete(this.cache.keys().next().value);
      }
      return audio;
    }).finally(() => {
      this.inflight.delete(key);
      this.released.delete(key);
    });
    this.inflight.set(key, request);
    return request;
  }

  release(sessionId, turnId) {
    const key = `${sessionId}:${turnId}`;
    this.cache.delete(key);
    if (this.inflight.has(key)) this.released.add(key);
  }

  async synthesize(text) {
    if (!this.apiKey?.trim()) {
      this.diagnose('missing_configuration');
      throw new TtsServiceError('Alex custom voice is not configured', 503, 'ALEX_VOICE_NOT_CONFIGURED');
    }
    if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT_LENGTH) {
      throw new TtsServiceError('Alex turn text is invalid for speech', 400, 'INVALID_TTS_TEXT');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(
        `${API_ROOT}/${ALEX_VOICE_ID}?output_format=mp3_44100_128`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'xi-api-key': this.apiKey },
          body: JSON.stringify({ text: text.trim(), model_id: this.model }),
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        const providerCode = await upstreamErrorCode(response);
        const [category, code, message] = classifyUpstreamError(response.status, providerCode);
        this.diagnose(category, { upstreamStatus: response.status, upstreamCode: providerCode });
        throw new TtsServiceError(message, 503, code);
      }
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.toLowerCase().startsWith('audio/')) {
        this.diagnose('invalid_response', { upstreamStatus: response.status });
        throw new TtsServiceError('Alex custom voice returned invalid audio', 502, 'ALEX_VOICE_INVALID_RESPONSE');
      }
      let audio;
      try {
        audio = await readBoundedAudio(response, MAX_AUDIO_BYTES);
      } catch (error) {
        this.diagnose('invalid_response', { upstreamStatus: response.status });
        throw error;
      }
      if (!audio.length) {
        this.diagnose('invalid_response', { upstreamStatus: response.status });
        throw new TtsServiceError('Alex custom voice returned invalid audio', 502, 'ALEX_VOICE_INVALID_RESPONSE');
      }
      return { buffer: audio, contentType };
    } catch (error) {
      if (error instanceof TtsServiceError) throw error;
      if (error?.name === 'AbortError') {
        this.diagnose('timeout');
        throw new TtsServiceError('Alex custom voice timed out; using browser speech', 503, 'ALEX_VOICE_TIMEOUT');
      }
      this.diagnose('network_failure', { errorName: safeDiagnosticToken(error?.name, 'Error') });
      throw new TtsServiceError('Alex custom voice service could not be reached', 503, 'ALEX_VOICE_UPSTREAM_FAILURE');
    } finally {
      clearTimeout(timeout);
    }
  }
}

export const ALEX_CUSTOM_VOICE_ID = ALEX_VOICE_ID;
