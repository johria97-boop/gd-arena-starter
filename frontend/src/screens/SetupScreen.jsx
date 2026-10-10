import { useMemo, useState } from 'react';
import { PARTICIPANTS, TOPICS } from '../constants.js';
import { ArrowIcon, CheckIcon, MicIcon } from '../components/Icons.jsx';

const MODES = ['Balanced discussion', 'Placement GD'];
const DIFFICULTIES = ['Foundation', 'Standard', 'Challenge'];
const DURATIONS = ['8 min', '10 min', '12 min'];
const FOCUSES = ['Balanced participation', 'Stronger arguments', 'Listening & response', 'Confident delivery'];

function ChoiceGroup({ label, note, options, value, onChange }) {
  return <fieldset className="choice-field"><legend>{label}</legend>{note && <p>{note}</p>}<div>{options.map(option => <button key={option} type="button" className={value === option ? 'choice selected' : 'choice'} onClick={() => onChange(option)} aria-pressed={value === option}>{option}</button>)}</div></fieldset>;
}

export default function SetupScreen({ busy, error, notice, onStart, onPreviewReport }) {
  const [selected, setSelected] = useState(TOPICS[0]);
  const [custom, setCustom] = useState('');
  const [mode, setMode] = useState(MODES[0]);
  const [difficulty, setDifficulty] = useState(DIFFICULTIES[1]);
  const [duration, setDuration] = useState(DURATIONS[1]);
  const [focus, setFocus] = useState(FOCUSES[0]);
  const compatibility = useMemo(() => ({
    microphone: Boolean(navigator.mediaDevices?.getUserMedia),
    recognition: Boolean(window.SpeechRecognition || window.webkitSpeechRecognition),
    synthesis: Boolean(window.speechSynthesis && window.SpeechSynthesisUtterance),
  }), []);
  const topic = selected === 'custom' ? custom.trim() : selected;

  return <main className="setup-page setup-view">
    {notice && <div className="route-notice" role="status">{notice}</div>}
    <section className="setup-hero" id="top">
      <div className="hero-copy">
        <p className="eyebrow">PRACTICE SETUP</p>
        <h1>Shape your next<br /><em>discussion.</em></h1>
        <p className="hero-lead">Choose a topic, set a practice intention, and enter the room when you’re ready.</p>
      </div>
      <aside className="format-card" aria-label="Session format">
        <span className="format-number">05</span><p>voices in your room</p>
        <div className="format-line" />
        <dl><div><dt>Format</dt><dd>Live GD</dd></div><div><dt>Feedback</dt><dd>6 dimensions</dd></div><div><dt>Mode</dt><dd>Browser voice</dd></div></dl>
      </aside>
    </section>

    <section className="setup-grid">
      <div className="setup-panel topic-panel">
        <div className="section-heading"><span>01</span><div><h2>Choose your topic</h2><p>Select a prompt or bring your own.</p></div></div>
        <div className="topic-options" role="radiogroup" aria-label="Discussion topics">
          {TOPICS.map((item, index) => <button key={item} type="button" role="radio" aria-checked={selected === item} className={selected === item ? 'topic-option selected' : 'topic-option'} onClick={() => setSelected(item)}><span className="topic-number">0{index + 1}</span><span className="topic-label">{item}</span><i /></button>)}
          <button type="button" role="radio" aria-checked={selected === 'custom'} className={selected === 'custom' ? 'topic-option selected' : 'topic-option'} onClick={() => setSelected('custom')}><span className="topic-number">06</span><span className="topic-label">Write a custom topic</span><i /></button>
        </div>
        {selected === 'custom' && <div className="custom-topic"><label htmlFor="custom-topic">Custom discussion topic</label><textarea id="custom-topic" value={custom} onChange={event => setCustom(event.target.value)} maxLength={300} placeholder="Frame a clear, debatable question…" autoFocus /><small>{custom.length}/300</small></div>}
        <div className="practice-preferences">
          <div className="section-heading"><span>02</span><div><h2>Set your practice intention</h2><p>Planning preferences do not change the current AI prompt.</p></div></div>
          <div className="preference-grid">
            <ChoiceGroup label="Discussion mode" options={MODES} value={mode} onChange={setMode} />
            <ChoiceGroup label="Difficulty level" options={DIFFICULTIES} value={difficulty} onChange={setDifficulty} />
            <ChoiceGroup label="Suggested duration" note="The room timer is open-ended." options={DURATIONS} value={duration} onChange={setDuration} />
            <label className="select-field"><span>Practice focus <small>Optional</small></span><select value={focus} onChange={event => setFocus(event.target.value)}>{FOCUSES.map(item => <option key={item}>{item}</option>)}</select></label>
          </div>
        </div>
      </div>

      <div className="setup-side">
        <section className="setup-panel plan-card">
          <p className="eyebrow">YOUR PRACTICE PLAN</p><h2>Ready when you are.</h2>
          <dl><div><dt>Topic</dt><dd>{topic || 'Add a custom topic'}</dd></div><div><dt>Mode</dt><dd>{mode}</dd></div><div><dt>Difficulty</dt><dd>{difficulty}</dd></div><div><dt>Duration</dt><dd>{duration} suggested</dd></div><div><dt>Focus</dt><dd>{focus}</dd></div></dl>
          <div className="plan-panel"><span>In the room</span><div>{PARTICIPANTS.map(person => <span className={`avatar ${person.tone}`} key={person.name}>{person.initial}</span>)}<span className="avatar slate">M</span><span className="avatar amber">Y</span></div><small>Moderator, 3 AI participants, and you</small></div>
          <button className="button primary large plan-start" type="button" disabled={!topic || busy} onClick={() => onStart(topic)}>{busy ? 'Preparing room…' : 'Start discussion'}<ArrowIcon /></button>
          <p className="plan-note"><CheckIcon />Only your topic is sent to the current discussion engine.</p>
        </section>
        <section className="compatibility-card">
          <div className="compatibility-icon"><MicIcon /></div><div><h3>Browser readiness</h3><p>Voice works through your browser when supported. Typed participation always remains available.</p><div className="compatibility-checks"><span className={compatibility.microphone ? 'supported' : 'unsupported'}>{compatibility.microphone ? 'Mic capable' : 'Mic unavailable'}</span><span className={compatibility.recognition ? 'supported' : 'unsupported'}>{compatibility.recognition ? 'Recognition ready' : 'Use typed input'}</span><span className={compatibility.synthesis ? 'supported' : 'unsupported'}>{compatibility.synthesis ? 'Playback ready' : 'Audio unavailable'}</span></div></div>
        </section>
      </div>
    </section>

    {error && <div className="form-error" role="alert">{error}</div>}
    <button className="mock-preview-link" type="button" disabled={busy} onClick={onPreviewReport}>Preview feedback layout with clearly labelled F1 mock data</button>
  </main>;
}
