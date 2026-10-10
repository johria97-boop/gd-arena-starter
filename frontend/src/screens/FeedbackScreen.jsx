import { CATEGORY_LABELS } from '../constants.js';
import { CheckIcon, RestartIcon } from '../components/Icons.jsx';

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
  const average = assessed.length ? Math.round((assessed.reduce((sum, item) => sum + item.score, 0) / assessed.length) * 10) / 10 : null;
  const strengths = [...assessed].sort((a, b) => b.score - a.score).slice(0, 3);
  const speakers = Object.entries(report.metrics?.perSpeaker || {}).filter(([, value]) => value.turns > 0);

  return <main className="report-page">
    {isMock && <div className="mock-banner"><strong>F1 mock report preview</strong><span>This clearly labelled adapter demonstrates the report UI only. Production sessions use `/api/sessions/:id/end`.</span></div>}
    {report.status !== 'complete' && <div className={`report-status ${report.status}`}><strong>{report.status === 'partial' ? 'Partial evaluation' : 'Not enough evidence'}</strong><span>{report.status === 'partial' ? 'Your transcript and metrics are safe, but AI feedback was unavailable.' : 'Add student contributions to receive scored feedback.'}</span></div>}

    <section className="report-hero">
      <div><p className="eyebrow">DISCUSSION REVIEW</p><h1>Your performance,<br /><em>grounded in evidence.</em></h1><p className="report-topic">{topic || 'Practice discussion'}</p></div>
      <div className="overall-score"><span>Overall assessed score</span><strong>{average ?? '—'}</strong><small>{average === null ? 'Not assessed' : 'out of 10'}</small></div>
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
      <div className="report-section-heading"><span className="section-number">03</span><div><p className="eyebrow">SIX DIMENSIONS</p><h2>What the transcript shows</h2></div></div>
      <div className="category-grid">{report.feedback.map(item => <article className="category-card" key={item.category}><div className="category-top"><div><span>{item.status === 'assessed' ? 'Assessed' : 'Not assessed'}</span><h3>{CATEGORY_LABELS[item.category] || item.category}</h3></div><Score value={item.score} /></div><p>{item.explanation}</p><div className="improvement"><strong>Next move</strong><span>{item.improvement}</span></div>{item.evidenceTurnIds.length > 0 && <div className="evidence-links"><span>Evidence</span>{item.evidenceTurnIds.map(id => <a key={id} href={`#turn-${id}`}>{id.slice(0, 8)}</a>)}</div>}</article>)}</div>
    </section>

    <section className="insights-grid">
      <article><p className="eyebrow">STRENGTHS</p><h2>Keep doing this</h2>{strengths.length ? <ul>{strengths.map(item => <li key={item.category}><CheckIcon /><span><strong>{CATEGORY_LABELS[item.category]}</strong>{item.explanation}</span></li>)}</ul> : <p className="empty-copy">More discussion evidence is needed before strengths can be assessed.</p>}</article>
      <article><p className="eyebrow">NEXT SESSION</p><h2>Focus your practice</h2>{report.recommendations.length ? <ol>{report.recommendations.map(item => <li key={item}>{item}</li>)}</ol> : <p className="empty-copy">Recommendations were unavailable for this report.</p>}</article>
    </section>

    <section className="report-transcript">
      <div className="report-section-heading"><span className="section-number">04</span><div><p className="eyebrow">SOURCE OF TRUTH</p><h2>Evidence transcript</h2></div></div>
      <div className="report-turns">{report.transcript.map(turn => <article id={`turn-${turn.turnId}`} key={turn.turnId}><div><strong>{turn.speaker === 'Student' ? 'You' : turn.speaker}</strong><time>{new Date(turn.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div><p>{turn.text}</p><small>{turn.turnId}</small></article>)}</div>
    </section>
    <section className="restart-card"><div><p className="eyebrow">ITERATE</p><h2>One room is practice.<br />The next one is progress.</h2></div><button className="button primary large" type="button" onClick={onRestart}><RestartIcon />Start another discussion</button></section>
  </main>;
}
