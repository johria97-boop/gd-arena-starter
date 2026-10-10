import { PARTICIPANTS } from '../constants.js';
import { ArrowIcon } from '../components/Icons.jsx';

const STEPS = [
  ['01', 'Prepare your room', 'Choose a relevant topic and set a clear intention for the skills you want to improve.'],
  ['02', 'Join the discussion', 'Speak or type while distinct AI participants question, challenge, and build on your points.'],
  ['03', 'Review the evidence', 'See participation metrics and feedback linked directly to moments in your transcript.'],
];

const SKILLS = [
  ['Start with confidence', 'Learn to enter early with a clear, relevant opening.'],
  ['Build on other ideas', 'Connect to a speaker’s point and move the room forward.'],
  ['Respond to disagreement', 'Stay constructive and composed when challenged.'],
  ['Strengthen arguments', 'Support claims with reasoning, examples, and relevance.'],
  ['Communicate with clarity', 'Make each contribution concise, purposeful, and easy to follow.'],
];

export default function HowItWorksScreen({ onSetup }) {
  return <main className="how-page">
    <section className="page-intro"><p className="eyebrow">HOW IT WORKS</p><h1>Practice the whole conversation,<br /><em>not just your answer.</em></h1><p>GD Arena gives you a realistic place to rehearse how you enter, respond, listen, and build momentum across a complete group discussion.</p></section>
    <section className="workflow-section"><div className="section-intro"><p className="eyebrow">THREE SIMPLE STEPS</p><h2>From preparation to useful feedback.</h2></div><div className="step-grid">{STEPS.map(([number, title, copy]) => <article key={number}><span>{number}</span><h3>{title}</h3><p>{copy}</p></article>)}</div></section>
    <section className="practice-section"><div className="section-intro"><p className="eyebrow">TARGETED PRACTICE</p><h2>Practice the part that feels hard.</h2><p>Each session helps you isolate the habits that make group discussions demanding.</p></div><div className="practice-rows">{SKILLS.map(([title, copy], index) => <article key={title}><span>0{index + 1}</span><div><h3>{title}</h3><p>{copy}</p></div></article>)}</div></section>
    <section className="participant-section"><div className="section-intro"><p className="eyebrow">THE PRACTICE ROOM</p><h2>Different voices. Real dynamics.</h2><p>Every participant has a consistent role, while the moderator keeps the discussion structured.</p></div><div className="participant-grid">{PARTICIPANTS.map(person => <article key={person.name}><span className={`avatar ${person.tone}`}>{person.initial}</span><div><h3>{person.name}</h3><strong>{person.role}</strong><p>{person.detail}</p></div></article>)}<article><span className="avatar slate">M</span><div><h3>Moderator</h3><strong>Facilitator</strong><p>Introduces the topic, maintains structure, and closes the session.</p></div></article></div></section>
    <section className="landing-cta"><div><p className="eyebrow">YOUR NEXT DISCUSSION</p><h2>Turn preparation into<br />a stronger contribution.</h2></div><button className="button primary large" type="button" onClick={onSetup}>Set up a practice<ArrowIcon /></button></section>
  </main>;
}
