import { PARTICIPANTS } from '../constants.js';
import { ArrowIcon, CheckIcon, MicIcon } from '../components/Icons.jsx';

function RoomPreview() {
  return <aside className="room-preview" aria-label="Practice room preview">
    <div className="preview-top"><div><span className="live-dot" />Practice room</div><span>04:26</span></div>
    <div className="preview-topic"><small>DISCUSSION TOPIC</small><strong>Can economic growth and sustainability coexist?</strong></div>
    <div className="speaker-stage"><div className="preview-avatar">M</div><div className="speaker-copy"><span>Moderator is speaking</span><p>Let’s begin by defining what sustainable growth should mean in practice.</p><div className="voice-wave" aria-hidden="true">{[18, 30, 22, 38, 26, 34, 17, 28, 20].map((height, index) => <i key={index} style={{ height }} />)}</div></div></div>
    <div className="preview-roster">{PARTICIPANTS.map(person => <div key={person.name}><span className={`avatar ${person.tone}`}>{person.initial}</span><strong>{person.name}</strong><small>{person.role}</small></div>)}<div><span className="avatar amber">Y</span><strong>You</strong><small>Ready</small></div></div>
    <div className="preview-control"><span><MicIcon />Your microphone is ready</span><span>Hold to speak</span></div>
  </aside>;
}

export default function LandingScreen({ onSetup, onHow }) {
  return <main className="home-page" id="top">
    <section className="landing-hero"><div className="hero-copy"><p className="eyebrow">AI-POWERED GROUP DISCUSSION PRACTICE</p><h1>Make room for<br /><em>your point.</em></h1><p className="hero-lead">Build the clarity, confidence, and listening skills that placement discussions demand—in a private room designed for deliberate practice.</p><div className="hero-actions"><button className="button primary large" type="button" onClick={onSetup}>Start practicing<ArrowIcon /></button><button className="button secondary large" type="button" onClick={onHow}>How it works</button></div><p className="hero-note"><CheckIcon />No performance pressure. Typed participation always available.</p></div><RoomPreview /></section>
    <section className="benefits-strip" aria-label="Practice benefits"><div><strong>Real discussion dynamics</strong><span>Distinct AI personalities keep the room active.</span></div><div><strong>Voice or typed input</strong><span>Participate in the way that works for your browser.</span></div><div><strong>Evidence-based review</strong><span>Feedback points back to your actual transcript.</span></div></section>
  </main>;
}
