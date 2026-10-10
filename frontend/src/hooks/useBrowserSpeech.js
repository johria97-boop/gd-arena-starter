import { useCallback, useEffect, useRef, useState } from 'react';
import { BrowserSpeechController } from '../services/browserSpeech.js';

function browserCapabilities() {
  if (typeof window === 'undefined') return { recognition: false, synthesis: false };
  return {
    recognition: Boolean(window.SpeechRecognition || window.webkitSpeechRecognition),
    synthesis: Boolean(window.speechSynthesis && window.SpeechSynthesisUtterance),
  };
}

export function useBrowserSpeech({ onFinalTranscript, onTurnEvent, onError } = {}) {
  const callbacks = useRef({ onFinalTranscript, onTurnEvent, onError });
  const controllerRef = useRef(null);
  const [capabilities, setCapabilities] = useState(browserCapabilities);
  const [state, setState] = useState({
    listening: false,
    interimTranscript: '',
    playbackStatus: 'idle',
    speakingSpeaker: null,
    lastTurnId: null,
    error: '',
  });
  callbacks.current = { onFinalTranscript, onTurnEvent, onError };

  useEffect(() => {
    const controller = new BrowserSpeechController({ handlers: {
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
    } });
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
  const cancelPlayback = useCallback(() => controllerRef.current?.cancelPlayback() || false, []);
  const clearError = useCallback(() => setState(current => ({ ...current, error: '' })), []);

  return {
    ...state,
    recognitionSupported: capabilities.recognition,
    synthesisSupported: capabilities.synthesis,
    startListening,
    stopListening,
    playTurn,
    cancelPlayback,
    clearError,
  };
}
