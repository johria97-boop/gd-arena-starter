import { useEffect, useRef, useState } from 'react';
import SetupScreen from './screens/SetupScreen.jsx';
import DiscussionScreen from './screens/DiscussionScreen.jsx';
import FeedbackScreen from './screens/FeedbackScreen.jsx';
import {
  acknowledgeTurn,
  checkHealth,
  createSession,
  endSession,
  requestNextTurn,
  sendStudentMessage,
} from './services/api.js';
import { getMockFeedbackReport } from './services/mockAdapter.js';

function localTurn(turn) {
  return { ...turn, timestamp: turn.timestamp || new Date().toISOString() };
}

export default function App() {
  const [screen, setScreen] = useState('setup');
  const [health, setHealth] = useState('checking');
  const [session, setSession] = useState(null);
  const [report, setReport] = useState(null);
  const [reportTopic, setReportTopic] = useState('');
  const [isMockReport, setIsMockReport] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const sessionRef = useRef(session);
  const operationRef = useRef(null);
  const turnEventsRef = useRef(new Map());
  sessionRef.current = session;

  useEffect(() => {
    checkHealth().then(() => setHealth('online')).catch(() => setHealth('offline'));
  }, []);

  function replaceSession(next) {
    sessionRef.current = next;
    setSession(next);
  }

  function updateSession(updater) {
    const next = updater(sessionRef.current);
    sessionRef.current = next;
    setSession(next);
  }

  function beginOperation(kind, sessionId = null) {
    if (operationRef.current) return null;
    const token = { kind, sessionId };
    operationRef.current = token;
    setBusy(true);
    setError('');
    return token;
  }

  function isCurrent(token) {
    return operationRef.current === token
      && (!token.sessionId || sessionRef.current?.sessionId === token.sessionId);
  }

  function finishOperation(token) {
    if (operationRef.current !== token) return;
    operationRef.current = null;
    setBusy(false);
  }

  async function startDiscussion(topic) {
    const token = beginOperation('create');
    if (!token) return false;
    try {
      const result = await createSession(topic);
      if (!isCurrent(token)) return false;
      const opening = localTurn(result.turn);
      turnEventsRef.current.clear();
      replaceSession({ sessionId: result.sessionId, topic, transcript: [opening], activeTurn: opening, startedAt: Date.now() });
      setScreen('discussion');
      return true;
    } catch (requestError) {
      if (isCurrent(token)) {
        setError(requestError.message);
        if (requestError.code === 'NETWORK_ERROR') setHealth('offline');
      }
      return false;
    } finally {
      finishOperation(token);
    }
  }

  function clearActiveTurn(sessionId, turnId, event) {
    updateSession(current => current?.sessionId === sessionId && current.activeTurn?.turnId === turnId ? ({
      ...current,
      transcript: event === 'cancelled' ? current.transcript.filter(turn => turn.turnId !== turnId) : current.transcript,
      activeTurn: null,
    }) : current);
  }

  async function acknowledgeActive(event, turnId = sessionRef.current?.activeTurn?.turnId) {
    const current = sessionRef.current;
    if (!current?.activeTurn || current.activeTurn.turnId !== turnId) return false;
    const selectedEvent = turnEventsRef.current.get(turnId);
    if (selectedEvent && selectedEvent !== event) return false;
    const token = beginOperation(`ack:${event}`, current.sessionId);
    if (!token) return false;
    turnEventsRef.current.set(turnId, event);
    try {
      await acknowledgeTurn(current.sessionId, turnId, event);
      if (!isCurrent(token)) return false;
      clearActiveTurn(current.sessionId, turnId, event);
      return true;
    } catch (requestError) {
      if (!isCurrent(token)) return false;
      if (requestError.code === 'DUPLICATE_TURN_EVENT') {
        clearActiveTurn(current.sessionId, turnId, event);
        return true;
      }
      setError(requestError.message);
      return false;
    } finally {
      finishOperation(token);
    }
  }

  async function sendMessage(text) {
    const current = sessionRef.current;
    const token = current && beginOperation('message', current.sessionId);
    if (!token) return false;
    const optimistic = { turnId: `local-${crypto.randomUUID()}`, speaker: 'Student', text, timestamp: new Date().toISOString() };
    updateSession(value => ({ ...value, transcript: [...value.transcript, optimistic] }));
    try {
      const result = await sendStudentMessage(current.sessionId, text);
      if (!isCurrent(token)) return false;
      const turn = localTurn(result.turn);
      updateSession(value => ({ ...value, transcript: [...value.transcript, turn], activeTurn: turn }));
      return true;
    } catch (requestError) {
      if (isCurrent(token)) {
        updateSession(value => ({ ...value, transcript: value.transcript.filter(turn => turn.turnId !== optimistic.turnId) }));
        setError(requestError.message);
      }
      return false;
    } finally {
      finishOperation(token);
    }
  }

  async function nextTurn() {
    const current = sessionRef.current;
    const token = current && beginOperation('next', current.sessionId);
    if (!token) return false;
    try {
      const result = await requestNextTurn(current.sessionId);
      if (!isCurrent(token)) return false;
      const turn = localTurn(result.turn);
      updateSession(value => ({ ...value, transcript: [...value.transcript, turn], activeTurn: turn }));
      return true;
    } catch (requestError) {
      if (isCurrent(token)) setError(requestError.message);
      return false;
    } finally {
      finishOperation(token);
    }
  }

  async function finishDiscussion() {
    const current = sessionRef.current;
    const token = current && beginOperation('end', current.sessionId);
    if (!token) return false;
    try {
      const result = await endSession(current.sessionId);
      if (!isCurrent(token)) return false;
      setReport(result); setReportTopic(current.topic); setIsMockReport(false); setScreen('feedback');
      return true;
    } catch (requestError) {
      if (isCurrent(token)) setError(requestError.message);
      return false;
    } finally {
      finishOperation(token);
    }
  }

  function previewReport() {
    if (operationRef.current) return;
    setReport(getMockFeedbackReport()); setReportTopic('Will AI create more jobs than it replaces?');
    setIsMockReport(true); setError(''); setScreen('feedback');
  }

  function restart() {
    operationRef.current = null; turnEventsRef.current.clear(); replaceSession(null);
    setBusy(false); setReport(null); setReportTopic(''); setIsMockReport(false); setError(''); setScreen('setup');
  }

  if (screen === 'discussion' && session) return <DiscussionScreen session={session} busy={busy} error={error} onClearError={() => setError('')} onVoiceError={setError} onSend={sendMessage} onNext={nextTurn} onAcknowledge={acknowledgeActive} onEnd={finishDiscussion} />;
  if (screen === 'feedback' && report) return <FeedbackScreen report={report} topic={reportTopic} isMock={isMockReport} onRestart={restart} />;
  return <SetupScreen health={health} busy={busy} error={error} onStart={startDiscussion} onPreviewReport={previewReport} />;
}
