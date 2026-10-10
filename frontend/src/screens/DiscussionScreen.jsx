import { useEffect, useRef, useState } from 'react';
import { ROOM_PARTICIPANTS, secondsUntilDeadline } from '../constants.js';
import { ArrowIcon, CheckIcon, ClockIcon, CloseIcon, MicIcon, StopIcon } from '../components/Icons.jsx';
import { useBrowserSpeech } from '../hooks/useBrowserSpeech.js';
import { getAlexTurnAudio } from '../services/api.js';

function formatTime(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
  return `${minutes}:${(totalSeconds % 60).toString().padStart(2, '0')}`;
}

function Participant({ person, active, pending, thinking, studentSpeaking }) {
  const isActive = active === person.name || (person.name === 'Student' && studentSpeaking);
  let status = person.name === 'Student' ? 'Ready' : 'Listening';
  if (pending === person.name && !isActive) status = 'Response ready';
  if (thinking && ['Alex', 'Sarah', 'David', 'Moderator'].includes(person.name)) status = 'Thinking';
  if (isActive) status = 'Speaking';
  return <article className={isActive ? 'room-person active' : 'room-person'}><div className={`avatar ${person.tone}`}>{person.initial}{isActive && <i />}</div><div><strong>{person.name === 'Student' ? 'You' : person.name}</strong><span>{person.role}</span></div><small>{status}</small></article>;
}

function PlaybackSync({ turn, busy, speech, allowAiInterruption, onAcknowledge, onAiInterrupt }) {
  const aiInterruptRef = useRef(onAiInterrupt);
  aiInterruptRef.current = onAiInterrupt;
  const isCurrent = speech.lastTurnId === turn.turnId;
  const playing = isCurrent && ['queued', 'playing'].includes(speech.playbackStatus);
  const speechStarted = isCurrent && speech.playbackStatus === 'playing';
  const settledEvent = isCurrent && ['completed', 'cancelled'].includes(speech.playbackStatus) ? speech.playbackStatus : null;
  const playbackSupported = turn.speaker === 'Alex'
    ? speech.customAudioSupported || speech.synthesisSupported
    : speech.synthesisSupported;
  const copy = playing
    ? `${turn.speaker} is being read aloud. Interrupting stops playback and reports this exact turn as cancelled.`
    : settledEvent
      ? 'Playback ended. The browser event is being synchronized with the discussion session.'
      : playbackSupported
        ? 'Browser audio did not start automatically. Play this response or continue without audio.'
        : 'Speech synthesis is unavailable here. Read the response, then continue without audio.';

  useEffect(() => {
    if (!speechStarted || !allowAiInterruption || !turn.interruption?.afterMs) return undefined;
    const timer = setTimeout(() => {
      if (!speech.cancelPlayback(false)) return;
      aiInterruptRef.current(turn.turnId);
    }, turn.interruption.afterMs);
    return () => clearTimeout(timer);
  }, [allowAiInterruption, speechStarted, speech.cancelPlayback, turn.interruption?.afterMs, turn.turnId]);

  function cancelTurn() {
    if (!speech.cancelPlayback()) onAcknowledge('cancelled', turn.turnId);
  }

  return <div className="playback-sync"><div><strong>Voice playback · {turn.speaker}</strong><span>{copy}</span></div><div>
    {playing && <button className="button secondary" type="button" disabled={busy} onClick={cancelTurn}><CloseIcon />Interrupt</button>}
    {settledEvent && <button className="button secondary" type="button" disabled={busy} onClick={() => onAcknowledge(settledEvent, turn.turnId)}><CheckIcon />Retry sync</button>}
    {!playing && !settledEvent && playbackSupported && <button className="button primary" type="button" disabled={busy} onClick={() => speech.playTurn(turn)}><MicIcon />Play response</button>}
    {!playing && !settledEvent && <button className="button secondary" type="button" disabled={busy} onClick={cancelTurn}>Continue without audio</button>}
  </div></div>;
}

export default function DiscussionScreen({ session, busy, error, draft, onDraftChange, onStudentIntent, onListeningChange, onClearError, onVoiceError, onSend, onNext, onAcknowledge, onEnd }) {
  const [remaining, setRemaining] = useState(() => secondsUntilDeadline(session.deadlineAt));
  const [timeExpired, setTimeExpired] = useState(false);
  const deadlineHandled = useRef(false);
  const transcriptEnd = useRef(null);
  const inputRef = useRef(null);
  const listeningChangeRef = useRef(onListeningChange);
  listeningChangeRef.current = onListeningChange;
  const speech = useBrowserSpeech({
    loadCustomAudio(turn, options) {
      return getAlexTurnAudio(session.sessionId, turn.turnId, options);
    },
    onFinalTranscript(text) {
      onDraftChange(current => [current.trim(), text].filter(Boolean).join(' ').slice(0, 2000));
      setTimeout(() => inputRef.current?.focus(), 0);
    },
    onTurnEvent: onAcknowledge,
    onError: onVoiceError,
  });

  useEffect(() => {
    function updateTimer() {
      const seconds = secondsUntilDeadline(session.deadlineAt);
      setRemaining(seconds);
      if (seconds > 0 || deadlineHandled.current) return;
      deadlineHandled.current = true;
      setTimeExpired(true);
      speech.stopListening();
      const activeTurnId = session.activeTurn?.turnId || null;
      if (activeTurnId) speech.cancelPlayback(false);
      onEnd(activeTurnId);
    }
    updateTimer();
    const timer = setInterval(updateTimer, 500);
    return () => clearInterval(timer);
  }, [session.deadlineAt, session.activeTurn?.turnId, onEnd, speech.stopListening, speech.cancelPlayback]);
  useEffect(() => {
    transcriptEnd.current?.scrollIntoView({ behavior: 'smooth' });
  }, [session.transcript.length, busy]);
  useEffect(() => {
    if (session.activeTurn && !speech.listening) speech.playTurn(session.activeTurn);
  }, [session.activeTurn?.turnId, speech.listening, speech.playTurn]);
  useEffect(() => {
    listeningChangeRef.current?.(speech.listening);
  }, [speech.listening]);

  const activeSpeaker = speech.speakingSpeaker;
  const canInteract = !busy && !timeExpired;
  const floorOpen = canInteract && !session.activeTurn;
  const visibleError = error || speech.error;
  const phase = busy ? 'generating' : activeSpeaker ? 'speaking' : session.activeTurn ? 'ready' : 'listening';

  async function submit(event) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !canInteract) return;
    onStudentIntent();
    speech.stopListening();
    const interruptTurnId = session.activeTurn?.turnId || null;
    if (interruptTurnId) speech.cancelPlayback(false);
    onDraftChange('');
    const sent = await onSend(text, interruptTurnId);
    if (!sent) onDraftChange(text);
  }

  async function toggleListening() {
    if (!canInteract) return;
    onStudentIntent();
    if (speech.listening) speech.stopListening();
    else if (session.activeTurn) {
      const turnId = session.activeTurn.turnId;
      speech.cancelPlayback(false);
      speech.startListening();
      await onAcknowledge('cancelled', turnId);
    } else speech.startListening();
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  function clearVisibleError() {
    speech.clearError();
    onClearError();
  }

  function endDiscussion() {
    deadlineHandled.current = true;
    speech.stopListening();
    const activeTurnId = session.activeTurn?.turnId || null;
    if (activeTurnId) speech.cancelPlayback(false);
    onEnd(activeTurnId);
  }

  return <main className="room-page">
    <header className="room-header">
      <div className="brand compact"><span className="brand-mark">GD</span><span>ARENA</span></div>
      <div className="room-topic"><span>Discussion topic</span><strong>{session.topic}</strong></div>
      <div className="room-timer" aria-label={`${formatTime(remaining)} remaining`}><ClockIcon /><span>{formatTime(remaining)}</span></div>
      <button className="button danger subtle" type="button" disabled={busy && Boolean(session.activeTurn)} onClick={endDiscussion}><StopIcon />End discussion</button>
    </header>

    <div className="room-layout">
      <aside className="room-sidebar">
        <div className="sidebar-label"><span>Room</span><small>{session.sessionId.slice(0, 8)}</small></div>
        <div className="room-roster">{ROOM_PARTICIPANTS.map(person => <Participant key={person.name} person={person} active={activeSpeaker} pending={session.activeTurn?.speaker} thinking={busy && !session.activeTurn} studentSpeaking={speech.listening} />)}</div>
        <div className="phase-note"><span><MicIcon /></span><p>Recognition is manual and pauses for AI playback. Typed input always remains available.</p></div>
      </aside>

      <section className="conversation-panel">
        <div className="conversation-heading"><div><p className="eyebrow">LIVE TRANSCRIPT</p><h1>{activeSpeaker ? `${activeSpeaker} has the floor` : session.activeTurn ? `${session.activeTurn.speaker}'s response is ready` : busy ? 'Preparing the next response' : speech.listening ? 'Listening to your contribution' : 'The floor is open'}</h1></div><span className={`phase-pill ${phase}`}>{busy ? 'Generating' : activeSpeaker ? 'Speaking' : session.activeTurn ? 'Response ready' : speech.listening ? 'Listening to you' : 'Listening'}</span></div>
        {timeExpired && <div className="room-concluded" role="status">Time is up. The discussion has concluded; your feedback report is being prepared.</div>}
        {visibleError && <div className="room-error" role="alert"><span>{visibleError}</span><button type="button" onClick={clearVisibleError} aria-label="Dismiss error"><CloseIcon /></button></div>}
        <div className="transcript" aria-live="polite">
          {session.transcript.map(turn => <article className={`transcript-turn speaker-${turn.speaker.toLowerCase()}`} key={turn.turnId}><div className="turn-meta"><span>{turn.speaker === 'Student' ? 'You' : turn.speaker}</span><time>{new Date(turn.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div><p>{turn.text}</p></article>)}
          {busy && !session.activeTurn && <article className="transcript-turn typing-turn"><div className="turn-meta"><span>AI participant</span><small>Composing a response</small></div><div className="typing-dots"><i /><i /><i /></div></article>}
          <div ref={transcriptEnd} />
        </div>

        {session.activeTurn && <PlaybackSync turn={session.activeTurn} busy={busy} speech={speech} allowAiInterruption={!draft.trim() && !speech.listening} onAcknowledge={onAcknowledge} onAiInterrupt={turnId => onNext({ interruptTurnId: turnId })} />}

        <form className="composer" onSubmit={submit}>
          <button className={speech.listening ? 'mic-button active' : 'mic-button'} type="button" disabled={!canInteract || !speech.recognitionSupported} onClick={toggleListening} aria-pressed={speech.listening} title={speech.recognitionSupported ? 'Talk now; active AI playback will stop' : 'Speech recognition is unavailable; use typed input'}><MicIcon muted={!speech.listening} /><span>{speech.listening ? 'Stop speaking' : session.activeTurn ? 'Talk / interrupt' : 'Start speaking'}</span></button>
          <div className="composer-input"><label htmlFor="student-message">Your contribution</label><textarea ref={inputRef} id="student-message" value={draft} onChange={event => onDraftChange(event.target.value)} placeholder={canInteract ? 'Speak or type your contribution…' : 'Preparing the next turn…'} maxLength={2000} rows={2} /><small>{draft.length}/2000</small>{speech.interimTranscript && <div className="voice-interim" aria-live="polite">Hearing: {speech.interimTranscript}</div>}</div>
          <button className="send-button" type="submit" disabled={!canInteract || !draft.trim()} aria-label="Send contribution"><ArrowIcon /></button>
        </form>
        <div className="room-actions"><button className="text-action" type="button" disabled={!floorOpen} onClick={() => { onStudentIntent(); speech.stopListening(); onNext(); }}>Invite another AI perspective <ArrowIcon /></button><span>{speech.recognitionSupported ? 'Review recognized text before sending.' : 'Voice recognition unavailable — typed input is active.'}</span></div>
      </section>
    </div>
  </main>;
}
