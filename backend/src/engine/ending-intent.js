const CLEAR_PATTERNS = Object.freeze([
  /^(?:please\s+)?(?:let'?s|lets)\s+(?:end|finish)\s+(?:(?:this|the|our)\s+)?(?:discussion|conversation|topic|session)\s*(?:now|here)?$/,
  /^(?:please\s+)?(?:end|stop|finish|conclude)\s+(?:(?:this|the|our)\s+)?(?:discussion|conversation|topic|session)\s*(?:now|here)?$/,
  /^we\s+should\s+wrap\s+up\s+(?:the\s+(?:discussion|conversation|topic|session)\s+)?now$/,
  /^(?:please\s+)?wrap\s+up\s+(?:(?:this|the|our)\s+)?(?:discussion|conversation|topic|session)(?:\s+now)?$/,
  /^(?:that'?s|thats)\s+all\s+(?:so\s+)?(?:let'?s|lets)\s+finish$/,
  /^can\s+we\s+end\s+here$/,
]);

const NON_COMMAND_PATTERNS = Object.freeze([
  /\b(?:do\s+not|don'?t|should\s+not|shouldn'?t)\b.*\b(?:end|stop|finish|conclude|wrap\s+up)\b/,
  /^why\s+did\s+.*\b(?:end|stop|finish|conclude)\b/,
  /^imagine\s+.*\b(?:end|stop|finish|conclude)\b/,
  /\bdiscuss\s+when\b.*\b(?:end|stop|finish|conclude)\b/,
]);

function normalize(text) {
  return text
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/[^a-z0-9'\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function classifyEndingIntent(text) {
  if (typeof text !== 'string') return 'none';
  const normalized = normalize(text);
  if (!normalized || NON_COMMAND_PATTERNS.some(pattern => pattern.test(normalized))) return 'none';
  if (CLEAR_PATTERNS.some(pattern => pattern.test(normalized))) return 'end';
  if (/^(?:should|could|would)\s+we\s+(?:end|stop|finish|wrap\s+up|conclude)\b/.test(normalized)) return 'ambiguous';
  return 'none';
}
