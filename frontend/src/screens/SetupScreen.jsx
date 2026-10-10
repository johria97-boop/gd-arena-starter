import { useMemo, useState } from 'react';
import { PARTICIPANTS, TOPICS } from '../constants.js';
import { ArrowIcon, CheckIcon, MicIcon } from '../components/Icons.jsx';

export default function SetupScreen({ health, busy, error, onStart, onPreviewReport }) {
  const [selected, setSelected] = useState(TOPICS[0]);
  const [custom, setCustom] = useState('');
  const compatibility = useMemo(() => ({
    microphone: Boolean(navigator.mediaDevices?.getUserMedia),
    recognition: Boolean(window.SpeechRecognition || window.webkitSpeechRecognition),
    synthesis: Boolean(window.speechSynthesis && window.SpeechSynthesisUtterance),
  }), []);
  const topic = selected === 'custom' ? custom.trim() : selected;

  return <main className="page setup-page">
    <header className="site-header">
      <a className="brand" href="#top" aria-label="GD Arena home"><span className="brand-mark">GD</span><span>ARENA</span></a>
      <div className={`connection ${health}`}><span />{health === 'online' ? 'Backend connected' : health === 'offline' ? 'Backend offline' : 'Checking connection'}</div>
    </header>

    <section className="setup-hero" id="top">
      <div className="hero-copy">
        <p className="eyebrow">AI-POWERED GROUP DISCUSSION PRACTICE</p>
        <h1>Enter the room.<br /><em>Own the conversation.</em></h1>
        <p className="hero-lead">Practice structured group discussions with distinct AI personalities, then receive evidence-linked feedback on how you argued, listened, and responded.</p>
        <div className="hero-proof"><span><CheckIcon />Structured turns</span><span><CheckIcon />Evidence-based review</span><span><CheckIcon />Private practice</span></div>
      </div>
      <aside className="format-card" aria-label="Session format">
        <span className="format-number">05</span><p>voices in the room</p>
        <div className="format-line" />
        <dl><div><dt>Format</dt><dd>Live GD</dd></div><div><dt>Feedback</dt><dd>6 dimensions</dd></div><div><dt>Mode</dt><dd>Browser voice</dd></div></dl>
      </aside>
    </section>

    <section className="setup-grid">
      <div className="setup-panel topic-panel">
        <div className="section-heading"><span>01</span><div><h2>Choose your topic</h2><p>Select a prompt or bring your own.</p></div></div>
        <div className="topic-options" role="radiogroup" aria-label="Discussion topics">
          {TOPICS.map((item, index) => <button key={item} type="button" role="radio" aria-checked={selected === item} className={selected === item ? 'topic-option selected' : 'topic-option'} onClick={() => setSelected(item)}><span>0{index + 1}</span>{item}<i /></button>)}
          <button type="button" role="radio" aria-checked={selected === 'custom'} className={selected === 'custom' ? 'topic-option selected' : 'topic-option'} onClick={() => setSelected('custom')}><span>06</span>Write a custom topic<i /></button>
        </div>
        {selected === 'custom' && <div className="custom-topic"><label htmlFor="custom-topic">Custom discussion topic</label><textarea id="custom-topic" value={custom} onChange={event => setCustom(event.target.value)} maxLength={300} placeholder="Frame a clear, debatable question…" autoFocus /><small>{custom.length}/300</small></div>}
      </div>

      <div className="setup-side">
        <section className="setup-panel roster-panel">
          <div className="section-heading"><span>02</span><div><h2>Meet the panel</h2><p>Three distinct discussion styles.</p></div></div>
          <div className="setup-roster">{PARTICIPANTS.map(person => <article key={person.name} className="setup-person"><div className={`avatar ${person.tone}`}>{person.initial}</div><div><strong>{person.name}</strong><span>{person.role}</span><small>{person.detail}</small></div></article>)}</div>
          <div className="moderator-row"><div className="avatar slate">M</div><div><strong>Moderator</strong><span>Facilitates structure and timing</span></div></div>
        </section>
        <section className="compatibility-card">
          <div className="compatibility-icon"><MicIcon /></div><div><h3>Browser readiness</h3><p>Voice works through your browser when supported. Typed participation always remains available.</p><div className="compatibility-checks"><span className={compatibility.microphone ? 'supported' : 'unsupported'}>{compatibility.microphone ? 'Mic capable' : 'Mic unavailable'}</span><span className={compatibility.recognition ? 'supported' : 'unsupported'}>{compatibility.recognition ? 'Recognition ready' : 'Use typed input'}</span><span className={compatibility.synthesis ? 'supported' : 'unsupported'}>{compatibility.synthesis ? 'Playback ready' : 'Audio unavailable'}</span></div></div>
        </section>
      </div>
    </section>

    {error && <div className="form-error" role="alert">{error}</div>}
    <section className="setup-actions">
      <div><strong>Ready for a focused discussion?</strong><span>Allow 8–12 minutes for a useful practice session.</span></div>
      <button className="button primary large" type="button" disabled={!topic || busy} onClick={() => onStart(topic)}>{busy ? 'Preparing room…' : 'Start discussion'}<ArrowIcon /></button>
    </section>
    <button className="mock-preview-link" type="button" disabled={busy} onClick={onPreviewReport}>Preview feedback layout with clearly labelled F1 mock data</button>
    <footer className="site-footer"><span>GD Arena</span><span>Built for deliberate practice, not performance theatre.</span></footer>
  </main>;
}
