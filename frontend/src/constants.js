export const TOPICS = [
  'Will AI create more jobs than it replaces?',
  'Should social media platforms regulate misinformation?',
  'Is remote work the future of professional life?',
  'Should financial literacy be mandatory in college?',
  'Can economic growth and sustainability coexist?',
];

export const PARTICIPANTS = [
  { name: 'Alex', role: 'Analytical', detail: 'Evidence and logic', initial: 'A', tone: 'teal' },
  { name: 'Sarah', role: 'Dominant', detail: 'Challenges assumptions', initial: 'S', tone: 'blue' },
  { name: 'David', role: 'Supportive', detail: 'Builds common ground', initial: 'D', tone: 'violet' },
];

export const ROOM_PARTICIPANTS = [
  { name: 'Moderator', role: 'Facilitator', initial: 'M', tone: 'slate' },
  ...PARTICIPANTS,
  { name: 'Student', role: 'You', initial: 'Y', tone: 'amber' },
];

export const CATEGORY_LABELS = {
  opening_contribution: 'Opening contribution',
  argument_quality_and_relevance: 'Argument quality & relevance',
  building_on_others: 'Building on others',
  listening_and_responsiveness: 'Listening & responsiveness',
  handling_disagreements_and_interruptions: 'Handling disagreement',
  closing_contribution: 'Closing contribution',
};
export const DEFAULT_DISCUSSION_DURATION_MINUTES = 5;

export function secondsUntilDeadline(deadlineAt, now = Date.now()) {
  return Math.max(0, Math.ceil((deadlineAt - now) / 1000));
}
