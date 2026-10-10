import { useState } from 'react';
import { CATEGORY_LABELS } from '../constants.js';
import { CheckIcon, RestartIcon } from '../components/Icons.jsx';
import { formatPracticeBooking, loadPracticeBooking, savePracticeBooking } from '../services/practiceBooking.js';

function formatDuration(seconds = 0) {
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return minutes ? `${minutes}m ${remainder}s` : `${remainder}s`;
}

function Score({ value }) {
  return value === null || value === undefined
    ? <span className="score not-assessed">N/A</span>
    : <span className="score" style={{ '--score': `${value * 10}%` }}><strong>{value}</strong><small>/10</small></span>;
}

export default function FeedbackScreen({ report, topic, isMock, onRestart }) {
  const assessed = report.feedback.filter(item => item.status === 'assessed');
  const overallScore = Number.isFinite(report.overallScore) ? report.overallScore : null;
  const strengths = assessed.filter(item => item.score >= 6.5).sort((a, b) => b.score - a.score).slice(0, 3);
  const opportunities = [...assessed].sort((a, b) => a.score - b.score).slice(0, 3);
  const speakers = Object.entries(report.metrics?.perSpeaker || {}).filter(([, value]) => value.turns > 0);
  const [booking, setBooking] = useState(() => loadPracticeBooking());
  const [date, setDate] = useState(booking?.date || '');
  const [time, setTime] = useState(booking?.time || '');

  function confirmBooking(event) {
    event.preventDefault();
    const next = { date, time };
    if (savePracticeBooking(next)) setBooking(next);
  }

  return <main className="report-page">
    {isMock && <div className="mock-banner"><strong>F1 mock report preview</strong><span>This clearly labelled adapter demonstrates the report UI only. Production sessions use `/api/sessions/:id/end`.</span></div>}
    {report.status !== 'complete' && <div className={`report-status ${report.status}`}><strong>{report.status === 'partial' ? 'Partial evaluation' : 'Not enough evidence'}</strong><span>{report.status === 'partial' ? (report.evaluationError?.message || 'Your transcript and metrics are safe, but AI feedback was unavailable.') : 'The transcript does not contain enough student evidence to calculate a meaningful score.'}</span></div>}

    <section className="report-hero">
      <div><p className="eyebrow">DISCUSSION REVIEW</p><h1>Your performance,<br /><em>grounded in evidence.</em></h1><p className="report-topic">{topic || 'Practice discussion'}</p></div>
      <div className="overall-score"><span>Overall assessed score</span><strong>{overallScore ?? '—'}</strong><small>{overallScore !== null ? 'out of 10' : report.status === 'partial' ? 'Feedback unavailable' : 'Not enough evidence'}</small></div>
    </section>

    <section className="summary-card"><span className="section-number">01</span><div><p className="eyebrow">OVERALL SUMMARY</p><h2>{report.summary}</h2></div></section>

    <section className="metrics-section">
      <div className="report-section-heading"><span className="section-number">02</span><div><p className="eyebrow">PARTICIPATION</p><h2>How you showed up</h2></div></div>
      <div className="metric-grid">
        <article><span>Your turns</span><strong>{report.metrics?.totalStudentTurns ?? 0}</strong><small>contributions</small></article>
        <article><span>Your words</span><strong>{report.metrics?.totalStudentWords ?? 0}</strong><small>across the discussion</small></article>
        <article><span>Word share</span><strong>{report.metrics?.studentContributionPercentage ?? 0}%</strong><small>not speaking time</small></article>
        <article><span>Discussion span</span><strong>{formatDuration(report.metrics?.discussionDurationSeconds)}</strong><small>from transcript timestamps</small></article>
      </div>
      <div className="speaker-breakdown"><div><h3>Contribution by speaker</h3><p>Percentage of transcript words</p></div><div className="speaker-bars">{speakers.map(([speaker, stats]) => <div className="speaker-bar" key={speaker}><span>{speaker === 'Student' ? 'You' : speaker}</span><div><i style={{ width: `${stats.wordPercentage}%` }} /></div><strong>{stats.wordPercentage}%</strong></div>)}</div></div>
    </section>

    <section className="category-section">
      <div className="report-section-heading"><span className="section-number">03</span><div><p className="eyebrow">SIX DIMENSIONS</p><h2>What the transcript shows</h2><p>These categories cover communication clarity, argument quality, critical thinking, listening and responsiveness, confidence and participation, and respectful collaboration.</p></div></div>
      <div className="category-grid">{report.feedback.map(item => <article className="category-card" key={item.category}><div className="category-top"><div><span>{item.status === 'assessed' ? 'Assessed' : 'Not assessed'}</span><h3>{CATEGORY_LABELS[item.category] || item.category}</h3></div><Score value={item.score} /></div><p>{item.explanation}</p>{item.status === 'assessed' && item.strength && <div className="improvement"><strong>Strength</strong><span>{item.strength}</span></div>}{item.status === 'assessed' && item.improvementOpportunity && <div className="improvement"><strong>Opportunity</strong><span>{item.improvementOpportunity}</span></div>}<div className="improvement"><strong>Next move</strong><span>{item.actionableNextStep || item.improvement}</span></div>{item.evidenceTurnIds.length > 0 && <div className="evidence-links"><span>Evidence</span>{item.evidenceTurnIds.map(id => <a key={id} href={`#turn-${id}`}>{id.slice(0, 8)}</a>)}</div>}</article>)}</div>
    </section>

    <section className="insights-grid">
      <article><p className="eyebrow">STRENGTHS</p><h2>Keep doing this</h2>{strengths.length ? <ul>{strengths.map(item => <li key={item.category}><CheckIcon /><span><strong>{CATEGORY_LABELS[item.category]}</strong>{item.strength || item.explanation}</span></li>)}</ul> : <p className="empty-copy">More discussion evidence is needed before strengths can be assessed.</p>}</article>
      <article><p className="eyebrow">IMPROVEMENT OPPORTUNITIES</p><h2>What to strengthen</h2>{opportunities.length ? <ul>{opportunities.map(item => <li key={item.category}><span><strong>{CATEGORY_LABELS[item.category]}</strong>{item.improvementOpportunity || item.improvement}</span></li>)}</ul> : <p className="empty-copy">More discussion evidence is needed before weaknesses can be assessed.</p>}<h3 className="recommendation-heading">Specific recommendations</h3>{report.recommendations.length ? <ol>{report.recommendations.map(item => <li key={item}>{item}</li>)}</ol> : <p className="empty-copy">Recommendations were unavailable for this report.</p>}</article>
    </section>

    <section className="report-transcript">
      <div className="report-section-heading"><span className="section-number">04</span><div><p className="eyebrow">SOURCE OF TRUTH</p><h2>Evidence transcript</h2></div></div>
      <div className="report-turns">{report.transcript.map(turn => <article id={`turn-${turn.turnId}`} key={turn.turnId}><div><strong>{turn.speaker === 'Student' ? 'You' : turn.speaker}</strong><time>{new Date(turn.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div><p>{turn.text}</p><small>{turn.turnId}</small></article>)}</div>
    </section>
    <section className="booking-card">
      <div><p className="eyebrow">KEEP PRACTISING</p><h2>Book Your Next Practice Slot</h2><p>This reminder is saved only in this browser. It is not a server-side reservation.</p></div>
      <form onSubmit={confirmBooking}><label>Date<input type="date" required value={date} onChange={event => setDate(event.target.value)} /></label><label>Preferred time<input type="time" required value={time} onChange={event => setTime(event.target.value)} /></label><button className="button secondary" type="submit">Confirm practice slot</button></form>
      {booking && <p className="booking-confirmation" role="status"><CheckIcon /><span>Next practice: <strong>{formatPracticeBooking(booking)}</strong></span></p>}
    </section>
    <section className="restart-card"><div><p className="eyebrow">ITERATE</p><h2>One room is practice.<br />The next one is progress.</h2></div><button className="button primary large" type="button" onClick={onRestart}><RestartIcon />Start another discussion</button></section>
  </main>;
}
