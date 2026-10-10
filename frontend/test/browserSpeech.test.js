import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserSpeechController } from '../src/services/browserSpeech.js';

function result(text, isFinal) {
  return Object.assign([{ transcript: text }], { isFinal });
}

function voiceEnvironment() {
  const recognitionInstances = [];
  class FakeRecognition {
    constructor() { recognitionInstances.push(this); }
    start() { this.onstart?.(); }
    stop() { this.stopped = true; this.onend?.(); }
    abort() { this.aborted = true; }
  }
  class FakeUtterance {
    constructor(text) { this.text = text; }
  }
  const voices = [
    { name: 'Voice One', lang: 'en-US' },
    { name: 'Voice Two', lang: 'en-GB' },
    { name: 'Voice Three', lang: 'en-AU' },
    { name: 'Voice Four', lang: 'en-IN' },
  ];
  const synthesis = {
    speaking: false,
    pending: false,
    utterances: [],
    getVoices: () => voices,
    speak(utterance) {
      this.utterances.push(utterance);
      this.current = utterance;
      utterance.onstart?.();
    },
    cancel() {
      this.current?.onerror?.({ error: 'canceled' });
      this.current = null;
    },
  };
  return {
    environment: {
      SpeechRecognition: FakeRecognition,
      SpeechSynthesisUtterance: FakeUtterance,
      speechSynthesis: synthesis,
      navigator: { language: 'en-IN' },
    },
    recognitionInstances,
    synthesis,
  };
}

function customVoiceEnvironment() {
  const setup = voiceEnvironment();
  const audios = [];
  const revokedUrls = [];
  class FakeAudio {
    constructor() { audios.push(this); }
    play() { this.played = true; this.onplay?.(); return Promise.resolve(); }
    pause() { this.paused = true; }
    removeAttribute(name) { if (name === 'src') this.src = ''; }
    load() { this.loaded = true; }
  }
  setup.environment.Audio = FakeAudio;
  setup.environment.URL = {
    createObjectURL: () => `blob:alex-${audios.length + 1}`,
    revokeObjectURL: url => revokedUrls.push(url),
  };
  return { ...setup, audios, revokedUrls };
}

const nextTask = () => new Promise(resolve => setTimeout(resolve, 0));

test('reports unsupported speech APIs without throwing', () => {
  const errors = [];
  const controller = new BrowserSpeechController({ environment: {}, handlers: { onError: error => errors.push(error) } });
  assert.deepEqual(controller.capabilities, { recognition: false, synthesis: false, customAudio: false });
  assert.equal(controller.startListening(), false);
  assert.equal(controller.playTurn({ turnId: 't1', speaker: 'Alex', text: 'Hello' }), false);
  assert.deepEqual(errors.map(error => error.code), ['unsupported', 'unsupported']);
});

test('returns interim text and commits each final recognition result once', () => {
  const { environment, recognitionInstances } = voiceEnvironment();
  const transcripts = [];
  const controller = new BrowserSpeechController({ environment, handlers: { onTranscript: value => transcripts.push(value) } });
  assert.equal(controller.startListening(), true);
  const recognition = recognitionInstances[0];
  recognition.onresult({ resultIndex: 0, results: [result('a developing idea', false)] });
  recognition.onresult({ resultIndex: 0, results: [result('my final idea', true)] });
  recognition.onresult({ resultIndex: 0, results: [result('my final idea', true)] });
  assert.equal(transcripts[0].interim, 'a developing idea');
  assert.equal(transcripts[1].final, 'my final idea');
  assert.equal(transcripts[2].final, '');
  assert.equal(transcripts[2].fullFinal, 'my final idea');
  controller.destroy();
});

test('maps microphone permission failures to a typed-input fallback', () => {
  const { environment, recognitionInstances } = voiceEnvironment();
  const errors = [];
  const states = [];
  const controller = new BrowserSpeechController({
    environment,
    handlers: { onError: error => errors.push(error), onRecognitionState: state => states.push(state) },
  });
  controller.startListening();
  recognitionInstances[0].onerror({ error: 'not-allowed' });
  assert.match(errors[0].message, /permission was denied/i);
  assert.equal(states.at(-1), false);
});

test('stops recognition after the bounded inactivity timeout', async () => {
  const { environment, recognitionInstances } = voiceEnvironment();
  const errors = [];
  const controller = new BrowserSpeechController({
    environment,
    recognitionTimeoutMs: 10,
    handlers: { onError: error => errors.push(error) },
  });
  controller.startListening();
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(recognitionInstances[0].stopped, true);
  assert.equal(errors.at(-1).code, 'timeout');
  assert.equal(controller.recognition, null);
});

test('acknowledges completed playback once with the exact turn ID', () => {
  const { environment, synthesis } = voiceEnvironment();
  const events = [];
  const controller = new BrowserSpeechController({ environment, handlers: { onTurnEvent: (...event) => events.push(event) } });
  controller.playTurn({ turnId: 'turn-alex', speaker: 'Alex', text: 'Evidence matters.' });
  const utterance = synthesis.utterances[0];
  utterance.onend();
  utterance.onend();
  assert.deepEqual(events, [['completed', 'turn-alex']]);
});

test('manual playback cancellation is acknowledged once despite browser error callbacks', () => {
  const { environment } = voiceEnvironment();
  const events = [];
  const controller = new BrowserSpeechController({ environment, handlers: { onTurnEvent: (...event) => events.push(event) } });
  controller.playTurn({ turnId: 'turn-sarah', speaker: 'Sarah', text: 'Let us challenge that.' });
  assert.equal(controller.cancelPlayback(), true);
  assert.equal(controller.cancelPlayback(), false);
  assert.deepEqual(events, [['cancelled', 'turn-sarah']]);
});

test('orchestrated ending can stop playback without emitting a competing acknowledgment', () => {
  const { environment, synthesis } = voiceEnvironment();
  const events = [];
  const controller = new BrowserSpeechController({ environment, handlers: { onTurnEvent: (...event) => events.push(event) } });
  controller.playTurn({ turnId: 'turn-ending', speaker: 'David', text: 'This turn is being interrupted to end.' });
  assert.equal(controller.cancelPlayback(false), true);
  assert.equal(synthesis.current, null);
  assert.deepEqual(events, []);
});

test('playback failures stay retryable and do not fabricate a cancellation event', () => {
  const { environment, synthesis } = voiceEnvironment();
  const events = [];
  const states = [];
  const controller = new BrowserSpeechController({
    environment,
    handlers: {
      onTurnEvent: (...event) => events.push(event),
      onPlaybackState: state => states.push(state),
    },
  });
  const turn = { turnId: 'turn-moderator', speaker: 'Moderator', text: 'Welcome to the discussion.' };
  assert.equal(controller.playTurn(turn), true);
  synthesis.utterances[0].onerror({ error: 'synthesis-failed' });
  assert.deepEqual(events, []);
  assert.equal(states.at(-1).status, 'error');
  assert.equal(controller.playTurn(turn), true);
});

test('selects distinct installed voices and restrained profiles when available', () => {
  const { environment, synthesis } = voiceEnvironment();
  const controller = new BrowserSpeechController({ environment });
  controller.playTurn({ turnId: 'turn-alex', speaker: 'Alex', text: 'Analysis.' });
  const alex = synthesis.utterances[0];
  alex.onend();
  controller.playTurn({ turnId: 'turn-sarah', speaker: 'Sarah', text: 'Challenge.' });
  const sarah = synthesis.utterances[1];
  assert.notEqual(alex.voice, sarah.voice);
  assert.ok(alex.rate >= 0.9 && alex.rate <= 1.1);
  assert.ok(sarah.pitch >= 0.9 && sarah.pitch <= 1.1);
  controller.destroy();
});

test('cleanup aborts recognition and cancels playback without emitting a turn event', () => {
  const { environment, recognitionInstances, synthesis } = voiceEnvironment();
  const events = [];
  const recognitionController = new BrowserSpeechController({ environment });
  recognitionController.startListening();
  recognitionController.destroy();
  assert.equal(recognitionInstances[0].aborted, true);

  const playbackController = new BrowserSpeechController({ environment, handlers: { onTurnEvent: (...event) => events.push(event) } });
  playbackController.playTurn({ turnId: 'turn-david', speaker: 'David', text: 'Let us build on that.' });
  playbackController.destroy();
  assert.equal(synthesis.current, null);
  assert.deepEqual(events, []);
});

test('routes Alex through custom audio while other speakers retain browser synthesis', async () => {
  const { environment, audios, synthesis } = customVoiceEnvironment();
  const loaded = [];
  const events = [];
  const controller = new BrowserSpeechController({
    environment,
    customVoiceLoader: async turn => { loaded.push(turn.turnId); return new Blob(['audio']); },
    handlers: { onTurnEvent: (...event) => events.push(event) },
  });
  controller.playTurn({ turnId: 'alex-custom', speaker: 'Alex', text: 'A bounded argument.' });
  await nextTask();
  assert.deepEqual(loaded, ['alex-custom']);
  assert.equal(audios[0].played, true);
  assert.equal(synthesis.utterances.length, 0);
  const finishAlex = audios[0].onended;
  finishAlex();
  finishAlex();
  assert.deepEqual(events, [['completed', 'alex-custom']]);

  for (const speaker of ['Sarah', 'David', 'Moderator']) {
    controller.playTurn({ turnId: `${speaker}-browser`, speaker, text: `${speaker} keeps browser speech.` });
    synthesis.utterances.at(-1).onend();
  }
  assert.equal(synthesis.utterances.length, 3);
  assert.deepEqual(loaded, ['alex-custom']);
});

test('falls back to Alex browser speech when custom voice is not configured', async () => {
  const { environment, synthesis } = customVoiceEnvironment();
  const errors = [];
  const events = [];
  const controller = new BrowserSpeechController({
    environment,
    customVoiceLoader: async () => { throw Object.assign(new Error('missing'), { code: 'ALEX_VOICE_NOT_CONFIGURED' }); },
    handlers: {
      onError: error => errors.push(error),
      onTurnEvent: (...event) => events.push(event),
    },
  });
  controller.playTurn({ turnId: 'alex-fallback', speaker: 'Alex', text: 'Keep the transcript intact.' });
  await nextTask();
  assert.equal(synthesis.utterances.length, 1);
  assert.match(errors[0].message, /not configured/i);
  assert.deepEqual(events, []);
  synthesis.utterances[0].onend();
  assert.deepEqual(events, [['completed', 'alex-fallback']]);
});

test('intentional Alex interruption cancels exact custom turn and releases audio once', async () => {
  const { environment, audios, revokedUrls } = customVoiceEnvironment();
  const events = [];
  const controller = new BrowserSpeechController({
    environment,
    customVoiceLoader: async () => new Blob(['audio']),
    handlers: { onTurnEvent: (...event) => events.push(event) },
  });
  controller.playTurn({ turnId: 'alex-cancel', speaker: 'Alex', text: 'Interrupt this turn.' });
  await nextTask();
  assert.equal(controller.cancelPlayback(), true);
  assert.equal(controller.cancelPlayback(), false);
  assert.equal(audios[0].paused, true);
  assert.deepEqual(revokedUrls, ['blob:alex-1']);
  assert.deepEqual(events, [['cancelled', 'alex-cancel']]);
});

test('destroy aborts an in-flight custom request without fabricating an acknowledgment', () => {
  const { environment } = customVoiceEnvironment();
  const events = [];
  let requestSignal;
  const controller = new BrowserSpeechController({
    environment,
    customVoiceLoader: (_turn, { signal }) => {
      requestSignal = signal;
      return new Promise(() => {});
    },
    handlers: { onTurnEvent: (...event) => events.push(event) },
  });
  controller.playTurn({ turnId: 'alex-cleanup', speaker: 'Alex', text: 'Leave the room safely.' });
  controller.destroy();
  assert.equal(requestSignal.aborted, true);
  assert.deepEqual(events, []);
});
