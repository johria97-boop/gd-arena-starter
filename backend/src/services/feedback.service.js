const AI_PARTICIPANTS = new Set(['Alex', 'Sarah', 'David']);
const KNOWN_SPEAKERS = ['Student', 'Alex', 'Sarah', 'David', 'Moderator'];
const MAX_EVALUATION_TURNS = 60;
const MAX_TURN_TEXT = 300;

export const FEEDBACK_CATEGORIES = Object.freeze([
  'opening_contribution',
  'argument_quality_and_relevance',
  'building_on_others',
  'listening_and_responsiveness',
  'handling_disagreements_and_interruptions',
  'closing_contribution',
]);

const IMPROVEMENTS = Object.freeze({
  opening_contribution: 'Start with a clear position and one supporting reason.',
  argument_quality_and_relevance: 'Use a relevant reason or example to support each main claim.',
  building_on_others: 'Name a prior speaker and extend or challenge one specific idea.',
  listening_and_responsiveness: 'Respond directly to the substance of an earlier contribution.',
  handling_disagreements_and_interruptions: 'Acknowledge the opposing point before explaining your disagreement.',
  closing_contribution: 'End with a concise synthesis and final takeaway.',
});

export class FeedbackValidationError extends Error { constructor(message) { super(message); this.name = 'FeedbackValidationError'; } }

export function countWords(text) {
  return typeof text === 'string' ? (text.match(/[\p{L}\p{N}]+(?:['-][\p{L}\p{N}]+)*/gu) || []).length : 0;
}

function round(value) { return Math.round(value * 100) / 100; }

export function calculateMetrics(transcript) {
  const speakers = Object.fromEntries(KNOWN_SPEAKERS.map(name => [name, { turns: 0, words: 0, wordPercentage: 0 }]));
  let totalWords = 0;
  for (const turn of transcript) {
    if (!speakers[turn.speaker]) speakers[turn.speaker] = { turns: 0, words: 0, wordPercentage: 0 };
    const words = countWords(turn.text);
    speakers[turn.speaker].turns += 1;
    speakers[turn.speaker].words += words;
    totalWords += words;
  }
  for (const stats of Object.values(speakers)) {
    stats.wordPercentage = totalWords ? round((stats.words / totalWords) * 100) : 0;
  }
  const student = speakers.Student;
  const timestamps = transcript.map(turn => Date.parse(turn.timestamp)).filter(Number.isFinite);
  const duration = timestamps.length > 1 ? (Math.max(...timestamps) - Math.min(...timestamps)) / 1000 : 0;
  return {
    totalStudentTurns: student.turns,
    totalAiParticipantTurns: transcript.filter(turn => AI_PARTICIPANTS.has(turn.speaker)).length,
    studentContributionPercentage: student.wordPercentage,
    totalStudentWords: student.words,
    totalDiscussionWords: totalWords,
    perSpeaker: speakers,
    discussionDurationSeconds: round(duration),
    averageStudentContributionWords: student.turns ? round(student.words / student.turns) : 0,
  };
}

export function createNotAssessedFeedback(reason = 'There is insufficient transcript evidence for this category.') {
  return FEEDBACK_CATEGORIES.map(category => ({
    category,
    status: 'not_assessed',
    score: null,
    explanation: reason,
    improvement: IMPROVEMENTS[category],
    evidenceTurnIds: [],
  }));
}

function requireText(value, field, maxLength) {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new FeedbackValidationError(`${field} must be a non-empty bounded string`);
  }
  return value.trim();
}

export function validateEvaluation(payload, transcript) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.feedback)) {
    throw new FeedbackValidationError('Feedback response must be an object with a feedback array');
  }
  if (payload.feedback.length !== FEEDBACK_CATEGORIES.length) {
    throw new FeedbackValidationError('Feedback response must contain all six categories');
  }
  const turns = new Map(transcript.map(turn => [turn.turnId, turn]));
  const byCategory = new Map();
  for (const item of payload.feedback) {
    if (!FEEDBACK_CATEGORIES.includes(item?.category) || byCategory.has(item.category)) {
      throw new FeedbackValidationError('Feedback categories must be unique and recognized');
    }
    if (!['assessed', 'not_assessed'].includes(item.status)) {
      throw new FeedbackValidationError('Feedback status must be assessed or not_assessed');
    }
    const evidence = item.evidenceTurnIds;
    if (!Array.isArray(evidence) || evidence.some(id => typeof id !== 'string' || !turns.has(id))) {
      throw new FeedbackValidationError('Feedback contains a nonexistent transcript turn reference');
    }
    if (new Set(evidence).size !== evidence.length) {
      throw new FeedbackValidationError('Feedback contains duplicate evidence references');
    }
    if (item.status === 'assessed') {
      if (!Number.isFinite(item.score) || item.score < 0 || item.score > 10) {
        throw new FeedbackValidationError('Assessed feedback score must be between 0 and 10');
      }
      if (!evidence.some(id => turns.get(id).speaker === 'Student')) {
        throw new FeedbackValidationError('Assessed feedback must cite a student turn');
      }
    } else if (item.score !== null || evidence.length) {
      throw new FeedbackValidationError('Not-assessed feedback must have a null score and no evidence');
    }
    const fallback = createNotAssessedFeedback().find(entry => entry.category === item.category);
    byCategory.set(item.category, item.status === 'not_assessed' ? fallback : {
      category: item.category, status: item.status, score: item.score,
      explanation: requireText(item.explanation, 'explanation', 600),
      improvement: requireText(item.improvement, 'improvement', 400), evidenceTurnIds: evidence,
    });
  }
  if (!Array.isArray(payload.recommendations) || !payload.recommendations.length || payload.recommendations.length > 5) {
    throw new FeedbackValidationError('Recommendations must contain between one and five items');
  }
  return {
    feedback: FEEDBACK_CATEGORIES.map(category => byCategory.get(category)),
    summary: requireText(payload.summary, 'summary', 1_000),
    recommendations: payload.recommendations.map(item => requireText(item, 'recommendation', 300)),
  };
}

function promptTranscript(transcript) {
  const selected = transcript.length <= MAX_EVALUATION_TURNS
    ? transcript
    : [...transcript.slice(0, 30), ...transcript.slice(-30)];
  return selected.map(turn => ({
    turnId: turn.turnId,
    speaker: turn.speaker,
    text: turn.text.slice(0, MAX_TURN_TEXT),
  }));
}

function applyEvidenceAvailability(result, transcript) {
  const studentIndexes = transcript.flatMap((turn, index) => turn.speaker === 'Student' ? [index] : []);
  const followsAi = studentIndexes.some(index => transcript.slice(0, index).some(turn => AI_PARTICIPANTS.has(turn.speaker)));
  const available = {
    opening_contribution: studentIndexes.length > 0,
    argument_quality_and_relevance: studentIndexes.length > 0,
    building_on_others: followsAi,
    listening_and_responsiveness: followsAi,
    handling_disagreements_and_interruptions: followsAi,
    closing_contribution: studentIndexes.length > 1,
  };
  result.feedback = result.feedback.map(item => available[item.category]
    ? item
    : createNotAssessedFeedback().find(fallback => fallback.category === item.category));
  return result;
}

export class FeedbackService {
  constructor({ gemini }) {
    this.gemini = gemini;
  }

  calculateMetrics(transcript) { return calculateMetrics(transcript); }

  createNotAssessedFeedback(reason) { return createNotAssessedFeedback(reason); }

  async evaluate({ topic, transcript }) {
    const systemInstruction = [
      'You evaluate a student in a group discussion with Alex, Sarah, David, and a Moderator.',
      'Use only the supplied transcript. Never invent quotes, events, or turn IDs.',
      'Return concise JSON only. Mark unsupported categories not_assessed with score null and no evidence.',
    ].join(' ');
    const prompt = JSON.stringify({
      task: 'Evaluate the Student, not the AI participants.',
      topic,
      requiredCategories: FEEDBACK_CATEGORIES,
      schema: {
        feedback: [{ category: 'required category', status: 'assessed|not_assessed', score: '0-10|null', explanation: 'string', improvement: 'string', evidenceTurnIds: ['actual turnId'] }],
        summary: 'concise overall assessment',
        recommendations: ['up to five concrete recommendations'],
      },
      transcript: promptTranscript(transcript),
    });
    const text = await this.gemini.generate({
      systemInstruction,
      prompt,
      maxOutputTokens: 3_000,
      responseMimeType: 'application/json',
    });
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new FeedbackValidationError('Feedback response was not valid JSON');
    }
    return applyEvidenceAvailability(validateEvaluation(payload, transcript), transcript);
  }
}
