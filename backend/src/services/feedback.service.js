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

export class FeedbackValidationError extends Error {
  constructor(message, code = 'FEEDBACK_SCHEMA_INVALID') {
    super(message);
    this.name = 'FeedbackValidationError';
    this.code = code;
  }
}

const FAILURE_DETAILS = Object.freeze({
  GEMINI_NOT_CONFIGURED: ['missing_configuration', false, 'AI feedback is not configured on the server.'],
  GEMINI_INVALID_CREDENTIALS: ['invalid_credentials', false, 'AI feedback credentials were rejected.'],
  GEMINI_PERMISSION_DENIED: ['permission_denied', false, 'The configured AI account cannot access feedback generation.'],
  GEMINI_MODEL_UNAVAILABLE: ['model_unavailable', false, 'The configured AI model is unavailable.'],
  GEMINI_RATE_LIMITED: ['rate_or_quota_limit', true, 'AI feedback quota or rate limit was reached. Try a new session later.'],
  GEMINI_TIMEOUT: ['timeout', true, 'AI feedback generation timed out. Try a new session later.'],
  GEMINI_REQUEST_REJECTED: ['request_rejected', false, 'The AI service rejected the feedback request.'],
  GEMINI_UPSTREAM_FAILURE: ['upstream_service', true, 'The AI feedback service is temporarily unavailable.'],
  GEMINI_API_ERROR: ['upstream_service', true, 'The AI feedback service rejected the request.'],
  GEMINI_UNAVAILABLE: ['upstream_service', true, 'The AI feedback service is temporarily unavailable.'],
  GEMINI_NETWORK_ERROR: ['network', true, 'The server could not reach the AI feedback service.'],
  GEMINI_INVALID_RESPONSE: ['invalid_provider_response', true, 'The AI service returned an empty or invalid response.'],
  GEMINI_OUTPUT_TRUNCATED: ['incomplete_response', true, 'AI feedback exceeded the response limit before it was complete.'],
  FEEDBACK_MALFORMED_JSON: ['malformed_json', true, 'AI feedback was not valid structured JSON.'],
  FEEDBACK_SCHEMA_INVALID: ['validation_mismatch', true, 'AI feedback did not match the required six-category format.'],
  FEEDBACK_INVALID_EVIDENCE: ['invalid_evidence', true, 'AI feedback referenced evidence that is not in the transcript.'],
});

export function classifyEvaluationFailure(error) {
  const code = typeof error?.code === 'string' && FAILURE_DETAILS[error.code]
    ? error.code
    : 'FEEDBACK_UNEXPECTED_ERROR';
  const [category, retryable, message] = FAILURE_DETAILS[code]
    || ['unexpected_error', true, 'AI feedback could not be generated.'];
  return { code, category, retryable, message };
}

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
    strength: null,
    improvementOpportunity: IMPROVEMENTS[category],
    actionableNextStep: IMPROVEMENTS[category],
    improvement: IMPROVEMENTS[category],
    evidenceTurnIds: [],
  }));
}

export function calculateOverallScore(feedback) {
  const scores = feedback.filter(item => item.status === 'assessed' && Number.isFinite(item.score)).map(item => item.score);
  return scores.length ? Math.round((scores.reduce((sum, score) => sum + score, 0) / scores.length) * 10) / 10 : null;
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
      throw new FeedbackValidationError('Feedback contains a nonexistent transcript turn reference', 'FEEDBACK_INVALID_EVIDENCE');
    }
    if (new Set(evidence).size !== evidence.length) {
      throw new FeedbackValidationError('Feedback contains duplicate evidence references', 'FEEDBACK_INVALID_EVIDENCE');
    }
    if (item.status === 'assessed') {
      if (!Number.isFinite(item.score) || item.score < 0 || item.score > 10) {
        throw new FeedbackValidationError('Assessed feedback score must be between 0 and 10');
      }
      if (!evidence.some(id => turns.get(id).speaker === 'Student')) {
        throw new FeedbackValidationError('Assessed feedback must cite a student turn', 'FEEDBACK_INVALID_EVIDENCE');
      }
    } else if (item.score !== null || evidence.length) {
      throw new FeedbackValidationError('Not-assessed feedback must have a null score and no evidence');
    }
    const fallback = createNotAssessedFeedback().find(entry => entry.category === item.category);
    byCategory.set(item.category, item.status === 'not_assessed' ? fallback : {
      category: item.category, status: item.status, score: item.score,
      explanation: requireText(item.explanation, 'explanation', 600),
      strength: requireText(item.strength ?? item.explanation, 'strength', 300),
      improvementOpportunity: requireText(item.improvementOpportunity ?? item.improvement, 'improvementOpportunity', 400),
      actionableNextStep: requireText(item.actionableNextStep ?? item.improvement, 'actionableNextStep', 400),
      improvement: requireText(item.actionableNextStep ?? item.improvement, 'actionableNextStep', 400),
      evidenceTurnIds: evidence,
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

function evaluationSchema(transcript) {
  const turnIds = [...new Set(transcript.map(turn => turn.turnId))];
  const boundedText = (description, maximum = 600) => ({
    type: 'string',
    description: `${description} Keep this under ${maximum} characters.`,
  });
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      feedback: {
        type: 'array',
        minItems: FEEDBACK_CATEGORIES.length,
        maxItems: FEEDBACK_CATEGORIES.length,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            category: { type: 'string', enum: FEEDBACK_CATEGORIES },
            status: { type: 'string', enum: ['assessed', 'not_assessed'] },
            score: { type: ['number', 'null'], minimum: 0, maximum: 10 },
            explanation: boundedText('Evidence-linked assessment using only cited Student turns.'),
            strength: boundedText('A demonstrated strength, or a brief insufficient-evidence statement.', 300),
            improvementOpportunity: boundedText('A specific improvement opportunity.', 400),
            actionableNextStep: boundedText('One practical action for the next discussion.', 400),
            evidenceTurnIds: {
              type: 'array',
              maxItems: 4,
              items: { type: 'string', enum: turnIds },
              description: 'Only exact turnId values from the supplied transcript. Empty when not_assessed.',
            },
          },
          required: [
            'category', 'status', 'score', 'explanation', 'strength',
            'improvementOpportunity', 'actionableNextStep', 'evidenceTurnIds',
          ],
        },
      },
      summary: boundedText('Concise overall assessment grounded in the transcript.', 1_000),
      recommendations: {
        type: 'array',
        minItems: 1,
        maxItems: 5,
        items: boundedText('Concrete recommendation grounded in the evaluation.', 300),
      },
    },
    required: ['feedback', 'summary', 'recommendations'],
  };
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
      'Return detailed but concise JSON matching the supplied response schema.',
      'Mark unsupported categories not_assessed with score null and no evidence. Still return all six categories exactly once.',
      'Ground every assessed explanation, strength, and improvement in cited Student turns.',
      'Use exact transcript turn IDs. Never assess disagreement or closing unless that behavior is actually present.',
    ].join(' ');
    const prompt = JSON.stringify({
      task: 'Evaluate the Student, not the AI participants.',
      topic,
      requiredCategories: FEEDBACK_CATEGORIES,
      evaluationGuidance: {
        opening_contribution: 'Assess the opening position, communication clarity, and initial confidence.',
        argument_quality_and_relevance: 'Assess relevance, reasoning, evidence, and critical thinking.',
        building_on_others: 'Assess collaboration and how specifically the student develops another speaker’s idea.',
        listening_and_responsiveness: 'Assess whether responses engage the substance of prior turns.',
        handling_disagreements_and_interruptions: 'Assess respectful disagreement, composure, and collaborative language only when evidenced.',
        closing_contribution: 'Assess synthesis, clarity, and confidence in the student’s closing contribution.',
      },
      participationNote: 'Participation statistics are calculated separately; do not invent speaking time, confidence, or participation observations unsupported by the transcript.',
      schema: {
        feedback: [{
          category: 'required category', status: 'assessed|not_assessed', score: '0-10|null',
          explanation: 'evidence-linked string', strength: 'string', improvementOpportunity: 'string',
          actionableNextStep: 'string', evidenceTurnIds: ['actual turnId'],
        }],
        summary: 'concise overall assessment',
        recommendations: ['up to five concrete recommendations'],
      },
      transcript: promptTranscript(transcript),
    });
    const request = {
      systemInstruction,
      prompt,
      maxOutputTokens: 4_096,
      responseMimeType: 'application/json',
      responseJsonSchema: evaluationSchema(transcript),
      timeoutMs: 30_000,
    };
    let text;
    try {
      text = await this.gemini.generate(request);
    } catch (error) {
      const transient = new Set(['GEMINI_TIMEOUT', 'GEMINI_NETWORK_ERROR', 'GEMINI_UPSTREAM_FAILURE', 'GEMINI_INVALID_RESPONSE']);
      if (!transient.has(error?.code)) throw error;
      text = await this.gemini.generate(request);
    }
    let payload;
    try {
      const structuredText = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
      payload = JSON.parse(structuredText);
    } catch {
      throw new FeedbackValidationError('Feedback response was not valid JSON', 'FEEDBACK_MALFORMED_JSON');
    }
    const evaluation = applyEvidenceAvailability(validateEvaluation(payload, transcript), transcript);
    return { ...evaluation, overallScore: calculateOverallScore(evaluation.feedback) };
  }
}
