const DEFAULT_RECOGNITION_TIMEOUT_MS = 30_000;
const MAX_SETTLED_TURNS = 100;

const VOICE_PROFILES = Object.freeze({
  Moderator: { index: 0, rate: 0.96, pitch: 0.98 },
  Alex: { index: 1, rate: 0.98, pitch: 0.92 },
  Sarah: { index: 2, rate: 1.04, pitch: 1.02 },
  David: { index: 3, rate: 0.94, pitch: 1.08 },
});

function recognitionMessage(code) {
  if (code === 'not-allowed' || code === 'service-not-allowed') {
    return 'Microphone permission was denied. Allow access in browser settings or use typed input.';
  }
  if (code === 'audio-capture') return 'No working microphone was found. You can continue with typed input.';
  if (code === 'no-speech') return 'No speech was detected. Try again or type your contribution.';
  if (code === 'network') return 'Browser speech recognition lost its network service. Typed input is still available.';
  if (code === 'timeout') return 'Listening timed out. Start the microphone again or use typed input.';
  return 'Speech recognition stopped unexpectedly. You can retry or use typed input.';
}

export class BrowserSpeechController {
  constructor({ environment, recognitionTimeoutMs = DEFAULT_RECOGNITION_TIMEOUT_MS, customVoiceLoader, handlers = {} } = {}) {
    this.environment = environment || (typeof window === 'undefined' ? {} : window);
    this.Recognition = this.environment.SpeechRecognition || this.environment.webkitSpeechRecognition;
    this.synthesis = this.environment.speechSynthesis;
    this.Utterance = this.environment.SpeechSynthesisUtterance;
    this.Audio = this.environment.Audio;
    this.URL = this.environment.URL;
    this.customVoiceLoader = customVoiceLoader;
    this.recognitionTimeoutMs = recognitionTimeoutMs;
    this.handlers = handlers;
    this.recognition = null;
    this.recognitionTimer = null;
    this.finalResults = new Map();
    this.playback = null;
    this.settledTurnIds = new Set();
  }

  get capabilities() {
    return {
      recognition: Boolean(this.Recognition),
      synthesis: Boolean(this.synthesis && this.Utterance),
      customAudio: Boolean(this.customVoiceLoader && this.Audio && this.URL?.createObjectURL),
    };
  }

  startListening() {
    if (!this.capabilities.recognition) {
      this.emitError('recognition', 'unsupported', 'Speech recognition is not supported in this browser. Use typed input instead.');
      return false;
    }
    if (this.recognition) return true;

    const recognition = new this.Recognition();
    this.finalResults.clear();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = this.environment.navigator?.language || 'en-US';
    recognition.onstart = () => this.handlers.onRecognitionState?.(true);
    recognition.onresult = event => this.handleRecognitionResult(recognition, event);
    recognition.onerror = event => this.handleRecognitionError(recognition, event.error || 'unknown');
    recognition.onend = () => this.finishRecognition(recognition);
    this.recognition = recognition;

    try {
      recognition.start();
      this.handlers.onRecognitionState?.(true);
      this.scheduleRecognitionTimeout();
      return true;
    } catch {
      this.recognition = null;
      this.emitError('recognition', 'start-failed', 'The microphone could not start. Retry or use typed input.');
      this.handlers.onRecognitionState?.(false);
      return false;
    }
  }

  stopListening() {
    const recognition = this.recognition;
    if (!recognition) return false;
    this.recognition = null;
    this.clearRecognitionTimeout();
    this.handlers.onRecognitionState?.(false);
    try { recognition.stop(); } catch { /* Browser already stopped it. */ }
    return true;
  }

  handleRecognitionResult(recognition, event) {
    if (this.recognition !== recognition) return;
    const newFinal = [];
    const interim = [];
    for (let index = event.resultIndex || 0; index < event.results.length; index += 1) {
      const result = event.results[index];
      const text = result?.[0]?.transcript?.trim();
      if (!text) continue;
      if (result.isFinal) {
        if (!this.finalResults.has(index)) {
          this.finalResults.set(index, text);
          newFinal.push(text);
        }
      } else {
        interim.push(text);
      }
    }
    this.handlers.onTranscript?.({
      interim: interim.join(' '),
      final: newFinal.join(' '),
      fullFinal: [...this.finalResults.values()].join(' '),
    });
    this.scheduleRecognitionTimeout();
  }

  handleRecognitionError(recognition, code) {
    if (this.recognition !== recognition) return;
    this.recognition = null;
    this.clearRecognitionTimeout();
    this.handlers.onRecognitionState?.(false);
    this.emitError('recognition', code, recognitionMessage(code));
  }

  finishRecognition(recognition) {
    if (this.recognition !== recognition) return;
    this.recognition = null;
    this.clearRecognitionTimeout();
    this.handlers.onRecognitionState?.(false);
  }

  scheduleRecognitionTimeout() {
    this.clearRecognitionTimeout();
    this.recognitionTimer = setTimeout(() => {
      if (!this.recognition) return;
      this.emitError('recognition', 'timeout', recognitionMessage('timeout'));
      this.stopListening();
    }, this.recognitionTimeoutMs);
  }

  clearRecognitionTimeout() {
    if (this.recognitionTimer) clearTimeout(this.recognitionTimer);
    this.recognitionTimer = null;
  }

  playTurn(turn) {
    const useCustomVoice = turn?.speaker === 'Alex' && this.capabilities.customAudio;
    if (!useCustomVoice && !this.capabilities.synthesis) {
      this.emitError('playback', 'unsupported', 'Speech playback is not supported in this browser. Read the response and continue without audio.');
      return false;
    }
    if (!turn?.turnId || !turn?.speaker || !turn?.text) return false;
    if (this.recognition) return false;
    if (this.playback || this.settledTurnIds.has(turn.turnId)) return false;

    const playback = {
      turnId: turn.turnId,
      speaker: turn.speaker,
      turn,
      settled: false,
      abortController: new AbortController(),
      utterance: null,
      audio: null,
      objectUrl: null,
    };
    this.playback = playback;
    this.handlers.onPlaybackState?.({ status: 'queued', turnId: turn.turnId, speaker: turn.speaker });
    if (useCustomVoice) this.playCustomTurn(playback);
    else this.playBrowserTurn(playback);
    return true;
  }

  playBrowserTurn(playback) {
    if (playback.settled || this.playback !== playback) return false;
    if (!this.capabilities.synthesis) {
      this.failPlayback(playback);
      return false;
    }
    const { turn } = playback;
    const utterance = new this.Utterance(turn.text);
    const profile = VOICE_PROFILES[turn.speaker] || VOICE_PROFILES.Moderator;
    const voices = this.synthesis.getVoices?.() || [];
    const englishVoices = voices.filter(voice => /^en([_-]|$)/i.test(voice.lang || ''));
    const voicePool = englishVoices.length ? englishVoices : voices;
    if (voicePool.length) utterance.voice = voicePool[profile.index % voicePool.length];
    utterance.rate = profile.rate;
    utterance.pitch = profile.pitch;
    utterance.volume = 1;

    playback.utterance = utterance;
    utterance.onstart = () => this.handlers.onPlaybackState?.({ status: 'playing', turnId: turn.turnId, speaker: turn.speaker });
    utterance.onend = () => this.settlePlayback(playback, 'completed');
    utterance.onerror = event => {
      if (playback.settled) return;
      this.emitError('playback', event.error || 'playback-failed', 'AI voice playback stopped. You can retry or continue without audio.');
      this.failPlayback(playback);
    };

    try {
      if (this.synthesis.speaking || this.synthesis.pending) this.synthesis.cancel();
      this.synthesis.speak(utterance);
      return true;
    } catch {
      this.emitError('playback', 'playback-failed', 'AI voice playback could not start. You can retry or continue without audio.');
      this.failPlayback(playback);
      return false;
    }
  }

  async playCustomTurn(playback) {
    try {
      const blob = await this.customVoiceLoader(playback.turn, { signal: playback.abortController.signal });
      if (playback.settled || this.playback !== playback) return;
      const objectUrl = this.URL.createObjectURL(blob);
      playback.objectUrl = objectUrl;
      const audio = new this.Audio();
      playback.audio = audio;
      audio.onplay = () => this.handlers.onPlaybackState?.({ status: 'playing', turnId: playback.turnId, speaker: playback.speaker });
      audio.onended = () => this.settlePlayback(playback, 'completed');
      audio.onerror = () => this.fallbackToBrowser(playback, { code: 'ALEX_AUDIO_PLAYBACK_FAILED' });
      audio.src = objectUrl;
      const playResult = audio.play();
      if (playResult?.catch) playResult.catch(() => this.fallbackToBrowser(playback, { code: 'ALEX_AUDIO_PLAYBACK_FAILED' }));
    } catch (error) {
      if (playback.settled || this.playback !== playback) return;
      this.fallbackToBrowser(playback, error);
    }
  }

  fallbackToBrowser(playback, error = {}) {
    if (playback.settled || this.playback !== playback || playback.fallbackStarted) return;
    playback.fallbackStarted = true;
    this.cleanupCustomAudio(playback);
    const configured = error.code !== 'ALEX_VOICE_NOT_CONFIGURED';
    this.emitError(
      'custom-playback',
      error.code || 'ALEX_VOICE_UNAVAILABLE',
      configured
        ? 'Alex’s custom voice is temporarily unavailable. Using browser speech for this turn.'
        : 'Alex’s custom voice is not configured yet. Using browser speech temporarily.',
    );
    this.playBrowserTurn(playback);
  }

  failPlayback(playback) {
    if (playback.settled) return;
    playback.settled = true;
    if (this.playback === playback) this.playback = null;
    this.cleanupPlayback(playback);
    this.handlers.onPlaybackState?.({ status: 'error', turnId: playback.turnId, speaker: null });
  }

  cancelPlayback(notify = true) {
    if (!this.playback) return false;
    const playback = this.playback;
    this.settlePlayback(playback, 'cancelled', notify);
    try { this.synthesis.cancel(); } catch { /* Nothing else to stop. */ }
    return true;
  }

  settlePlayback(playback, event, notify = true) {
    if (playback.settled) return;
    playback.settled = true;
    if (this.playback === playback) this.playback = null;
    this.cleanupPlayback(playback);
    this.settledTurnIds.add(playback.turnId);
    if (this.settledTurnIds.size > MAX_SETTLED_TURNS) {
      this.settledTurnIds.delete(this.settledTurnIds.values().next().value);
    }
    this.handlers.onPlaybackState?.({ status: event, turnId: playback.turnId, speaker: null });
    if (notify) this.handlers.onTurnEvent?.(event, playback.turnId);
  }

  cleanupCustomAudio(playback) {
    if (playback.audio) {
      playback.audio.onplay = null;
      playback.audio.onended = null;
      playback.audio.onerror = null;
      try { playback.audio.pause(); } catch { /* Audio is already stopped. */ }
      try { playback.audio.removeAttribute?.('src'); playback.audio.load?.(); } catch { /* Resource is already released. */ }
      playback.audio = null;
    }
    if (playback.objectUrl) {
      try { this.URL.revokeObjectURL(playback.objectUrl); } catch { /* URL is already released. */ }
      playback.objectUrl = null;
    }
  }

  cleanupPlayback(playback) {
    playback.abortController?.abort();
    this.cleanupCustomAudio(playback);
  }

  emitError(source, code, message) {
    this.handlers.onError?.({ source, code, message });
  }

  destroy() {
    this.clearRecognitionTimeout();
    const recognition = this.recognition;
    this.recognition = null;
    try { recognition?.abort(); } catch { /* Recognition is already closed. */ }
    if (this.playback) {
      this.playback.settled = true;
      this.cleanupPlayback(this.playback);
    }
    this.playback = null;
    try { this.synthesis?.cancel(); } catch { /* Playback is already closed. */ }
    this.handlers = {};
  }
}
