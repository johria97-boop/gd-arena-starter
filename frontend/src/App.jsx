import { useEffect, useRef, useState } from 'react';
import SiteLayout from './components/SiteLayout.jsx';
import { useBrowserRoute } from './hooks/useBrowserRoute.js';
import LandingScreen from './screens/LandingScreen.jsx';
import HowItWorksScreen from './screens/HowItWorksScreen.jsx';
import SetupScreen from './screens/SetupScreen.jsx';
import DiscussionScreen from './screens/DiscussionScreen.jsx';
import FeedbackScreen from './screens/FeedbackScreen.jsx';
import { activatePracticeSetup, resolveAppRoute, ROUTES } from './services/navigation.js';
import {
  acknowledgeTurn,
  checkHealth,
  createSession,
  endSession,
  requestNextTurn,
  sendStudentMessage,
} from './services/api.js';
import { getMockFeedbackReport } from './services/mockAdapter.js';
import { DEFAULT_DISCUSSION_DURATION_MINUTES } from './constants.js';

function localTurn(turn) {
  return { ...turn, timestamp: turn.timestamp || new Date().toISOString() };
}

const PAGE_TITLES = {
  [ROUTES.home]: 'GD Arena — AI Group Discussion Practice',
  [ROUTES.how]: 'How It Works — GD Arena',
  [ROUTES.setup]: 'Practice Setup — GD Arena',
  [ROUTES.discussion]: 'Live Discussion — GD Arena',
  [ROUTES.report]: 'Feedback Report — GD Arena',
};

function EmptyReport({ onSetup }) {
  return <main className="empty-page"><p className="eyebrow">FEEDBACK REPORT</p><h1>No report is available yet.</h1><p>Complete a discussion to generate transcript-grounded performance feedback and participation metrics.</p><button className="button primary large" type="button" onClick={onSetup}>Start a practice session</button></main>;
}

export default function App() {
  const { path, state: routeState, navigate } = useBrowserRoute();
  const [health, setHealth] = useState('checking');
  const [session, setSession] = useState(null);
  const [draft, setDraft] = useState('');
  const [report, setReport] = useState(null);
  const [reportTopic, setReportTopic] = useState('');
  const [isMockReport, setIsMockReport] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const sessionRef = useRef(session);
  const operationRef = useRef(null);
  const turnEventsRef = useRef(new Map());
  sessionRef.current = session;
  const route = resolveAppRoute(path, { hasSession: Boolean(session), hasReport: Boolean(report) });

  useEffect(() => {
    checkHealth().then(() => setHealth('online')).catch(() => setHealth('offline'));
  }, []);
  useEffect(() => {
    if (route.redirect) navigate(route.redirect, { replace: true, state: { notice: route.notice } });
  }, [route.redirect, route.notice, navigate]);
  useEffect(() => {
    document.title = PAGE_TITLES[route.path] || PAGE_TITLES[ROUTES.home];
    window.scrollTo({ top: 0, behavior: 'auto' });
  }, [route.path]);

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

  async function startDiscussion(topic, durationMinutes = DEFAULT_DISCUSSION_DURATION_MINUTES) {
    const token = beginOperation('create');
    if (!token) return false;
    try {
      const result = await createSession(topic, durationMinutes);
      if (!isCurrent(token)) return false;
      const opening = localTurn(result.turn);
      turnEventsRef.current.clear();
      const startedAt = Date.now();
      replaceSession({ sessionId: result.sessionId, topic, transcript: [opening], activeTurn: opening, startedAt, deadlineAt: startedAt + durationMinutes * 60_000, durationMinutes });
      setDraft('');
      navigate(ROUTES.discussion);
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
      if (result.endRequested) {
        updateSession(value => ({ ...value, transcript: value.transcript.filter(turn => turn.turnId !== optimistic.turnId) }));
        const finalReport = await endSession(current.sessionId);
        if (!isCurrent(token)) return false;
        setReport(finalReport); setReportTopic(current.topic); setIsMockReport(false); navigate(ROUTES.report);
        return true;
      }
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

  async function finishDiscussion(cancelTurnId = null) {
    const current = sessionRef.current;
    if (!current || operationRef.current?.kind === 'end') return false;
    const interruptedGeneration = !current.activeTurn
      && ['message', 'next'].includes(operationRef.current?.kind);
    const token = { kind: 'end', sessionId: current.sessionId };
    operationRef.current = token;
    setBusy(true);
    setError('');
    try {
      if (cancelTurnId && current.activeTurn?.turnId === cancelTurnId) {
        turnEventsRef.current.set(cancelTurnId, 'cancelled');
        try {
          await acknowledgeTurn(current.sessionId, cancelTurnId, 'cancelled');
        } catch (ackError) {
          if (!['DUPLICATE_TURN_EVENT', 'STALE_TURN_ID'].includes(ackError.code)) throw ackError;
        }
        if (!isCurrent(token)) return false;
        clearActiveTurn(current.sessionId, cancelTurnId, 'cancelled');
      }
      const result = await endSession(current.sessionId, { cancelPendingTurn: interruptedGeneration });
      if (!isCurrent(token)) return false;
      setReport(result); setReportTopic(current.topic); setIsMockReport(false); navigate(ROUTES.report);
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
    setIsMockReport(true); setError(''); navigate(ROUTES.report);
  }

  function resetFinishedPractice() {
    operationRef.current = null; turnEventsRef.current.clear(); replaceSession(null);
    setBusy(false); setDraft(''); setReport(null); setReportTopic(''); setIsMockReport(false); setError('');
  }

  function openPracticeSetup() {
    activatePracticeSetup({
      currentPath: route.path,
      navigate,
      onLeaveReport: resetFinishedPractice,
    });
  }

  function restart() {
    resetFinishedPractice();
    navigate(ROUTES.setup);
  }

  if (route.path === ROUTES.discussion && session) {
    return <DiscussionScreen session={session} busy={busy} error={error} draft={draft} onDraftChange={setDraft} onClearError={() => setError('')} onVoiceError={setError} onSend={sendMessage} onNext={nextTurn} onAcknowledge={acknowledgeActive} onEnd={finishDiscussion} />;
  }

  let content;
  if (route.path === ROUTES.home) content = <LandingScreen onSetup={() => navigate(ROUTES.setup)} onHow={() => navigate(ROUTES.how)} />;
  else if (route.path === ROUTES.how) content = <HowItWorksScreen onSetup={() => navigate(ROUTES.setup)} />;
  else if (route.path === ROUTES.report && report) content = <FeedbackScreen report={report} topic={reportTopic} isMock={isMockReport} onRestart={restart} />;
  else if (route.path === ROUTES.report) content = <EmptyReport onSetup={() => navigate(ROUTES.setup)} />;
  else content = <SetupScreen busy={busy} error={error} notice={routeState?.notice || route.notice} onStart={startDiscussion} onPreviewReport={previewReport} />;

  return <SiteLayout path={route.path} health={health} onNavigate={navigate} onPractice={openPracticeSetup}>{content}</SiteLayout>;
}
