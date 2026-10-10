// TEMPORARY F1 UI PREVIEW ONLY. This data is never used as an API fallback.
const now = Date.now();
const transcript = [
  { turnId: 'mock-moderator-1', speaker: 'Moderator', text: 'Welcome. Let us examine whether AI creates more jobs than it replaces.', timestamp: new Date(now).toISOString() },
  { turnId: 'mock-student-1', speaker: 'Student', text: 'AI will displace routine roles, but it can also create new work around supervision, safety, and training.', timestamp: new Date(now + 18_000).toISOString() },
  { turnId: 'mock-alex-1', speaker: 'Alex', text: 'That distinction matters, but the transition cost may be uneven across industries.', timestamp: new Date(now + 34_000).toISOString() },
  { turnId: 'mock-student-2', speaker: 'Student', text: 'Building on Alex, reskilling policy should target the industries facing the fastest displacement.', timestamp: new Date(now + 51_000).toISOString() },
  { turnId: 'mock-moderator-2', speaker: 'Moderator', text: 'Thank you. This concludes the discussion.', timestamp: new Date(now + 72_000).toISOString() },
];

const categories = [
  ['opening_contribution', 7, 'You established a balanced position early.', 'State your central claim in the first sentence.'],
  ['argument_quality_and_relevance', 8, 'Your points stayed relevant and included practical policy reasoning.', 'Add one concrete example or source.'],
  ['building_on_others', 8, 'You explicitly extended Alex’s transition-cost point.', 'Compare your view with another participant as well.'],
  ['listening_and_responsiveness', 7, 'Your follow-up addressed the concern raised immediately before it.', 'Summarize the prior point before responding.'],
  ['handling_disagreements_and_interruptions', null, 'There was not enough evidence to assess this category.', 'Acknowledge disagreement before presenting your counterpoint.'],
  ['closing_contribution', null, 'There was not enough evidence to assess this category.', 'Finish with a one-sentence synthesis.'],
];

export function getMockFeedbackReport() {
  return {
    sessionId: 'mock-f1-preview', status: 'complete', transcript,
    metrics: {
      totalStudentTurns: 2, totalAiParticipantTurns: 1, studentContributionPercentage: 34.6,
      totalStudentWords: 34, totalDiscussionWords: 98, discussionDurationSeconds: 72,
      averageStudentContributionWords: 17,
      perSpeaker: {
        Student: { turns: 2, words: 34, wordPercentage: 34.6 },
        Alex: { turns: 1, words: 14, wordPercentage: 14.3 },
        Sarah: { turns: 0, words: 0, wordPercentage: 0 },
        David: { turns: 0, words: 0, wordPercentage: 0 },
        Moderator: { turns: 2, words: 50, wordPercentage: 51.1 },
      },
    },
    feedback: categories.map(([category, score, explanation, improvement], index) => ({
      category, status: score === null ? 'not_assessed' : 'assessed', score, explanation, improvement,
      evidenceTurnIds: score === null ? [] : [index > 1 ? 'mock-student-2' : 'mock-student-1'],
    })),
    summary: 'You offered a balanced position and improved when responding directly to another speaker. Stronger evidence and a deliberate closing would make the contribution more persuasive.',
    recommendations: ['Lead with a sharper thesis.', 'Use one concrete example per major claim.', 'Close by synthesizing the strongest competing views.'],
  };
}
