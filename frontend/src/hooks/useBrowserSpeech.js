import { useCallback, useEffect, useRef, useState } from 'react';
import { BrowserSpeechController } from '../services/browserSpeech.js';

function browserCapabilities(hasCustomVoice = false) {
  if (typeof window === 'undefined') return { recognition: false, synthesis: false, customAudio: false };
  return {
    recognition: Boolean(window.SpeechRecognition || window.webkitSpeechRecognition),
    synthesis: Boolean(window.speechSynthesis && window.SpeechSynthesisUtterance),
    customAudio: Boolean(hasCustomVoice && window.Audio && window.URL?.createObjectURL),
  };
}

export function useBrowserSpeech({ loadCustomAudio, onFinalTranscript, onTurnEvent, onError } = {}) {
  const callbacks = useRef({ loadCustomAudio, onFinalTranscript, onTurnEvent, onError });
  const controllerRef = useRef(null);
  const [capabilities, setCapabilities] = useState(() => browserCapabilities(Boolean(loadCustomAudio)));
  const [state, setState] = useState({
    listening: false,
    interimTranscript: '',
    playbackStatus: 'idle',
    speakingSpeaker: null,
    lastTurnId: null,
    error: '',
  });
  callbacks.current = { loadCustomAudio, onFinalTranscript, onTurnEvent, onError };

  useEffect(() => {
    const controller = new BrowserSpeechController({
      customVoiceLoader: loadCustomAudio
        ? (turn, options) => callbacks.current.loadCustomAudio(turn, options)
        : null,
      handlers: {
      onRecognitionState(listening) {
        setState(current => ({ ...current, listening, interimTranscript: listening ? current.interimTranscript : '' }));
      },
      onTranscript(result) {
        setState(current => ({ ...current, interimTranscript: result.interim }));
        if (result.final) callbacks.current.onFinalTranscript?.(result.final);
      },
      onPlaybackState(playback) {
        setState(current => ({
          ...current,
          playbackStatus: playback.status,
          speakingSpeaker: ['queued', 'playing'].includes(playback.status) ? playback.speaker : null,
          lastTurnId: playback.turnId,
        }));
      },
      onTurnEvent(event, turnId) {
        callbacks.current.onTurnEvent?.(event, turnId);
      },
      onError(details) {
        setState(current => ({ ...current, error: details.message }));
        callbacks.current.onError?.(details.message);
      },
      },
    });
    controllerRef.current = controller;
    setCapabilities(controller.capabilities);
    return () => {
      controller.destroy();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, []);

  const startListening = useCallback(() => {
    setState(current => ({ ...current, error: '', interimTranscript: '' }));
    return controllerRef.current?.startListening() || false;
  }, []);
  const stopListening = useCallback(() => controllerRef.current?.stopListening() || false, []);
  const playTurn = useCallback(turn => {
    setState(current => ({ ...current, error: '' }));
    return controllerRef.current?.playTurn(turn) || false;
  }, []);
  const cancelPlayback = useCallback((notify = true) => controllerRef.current?.cancelPlayback(notify) || false, []);
  const clearError = useCallback(() => setState(current => ({ ...current, error: '' })), []);

  return {
    ...state,
    recognitionSupported: capabilities.recognition,
    synthesisSupported: capabilities.synthesis,
    customAudioSupported: capabilities.customAudio,
    startListening,
    stopListening,
    playTurn,
    cancelPlayback,
    clearError,
  };
}
