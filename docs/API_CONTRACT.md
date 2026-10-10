# GD Arena API Contract - v0.3 (Phase B3)

Base URL: `http://localhost:4000/api` locally. JSON over HTTPS in production.

All errors contain `{ "error": "Human-readable explanation", "code": "STABLE_ERROR_CODE" }`
with an appropriate HTTP status. Clients written for v0.1 may continue reading only `error`.

The frontend owns microphone STT and browser TTS. The backend owns session state,
turn choice, transcript, AI prompts, and the active AI turn lifecycle. The frontend
must never imply that the backend directly detected a microphone interruption.

## Endpoints

- `GET /health` -> `200 { "ok": true, "service": "gd-arena-api" }`
- `POST /sessions` with `{ "topic": "..." }` ->
  `{ "sessionId": "...", "turn": { "turnId": "...", "speaker": "Moderator", "text": "..." } }`
- `POST /sessions/:id/messages` with `{ "text": "..." }` ->
  `{ "turn": { "turnId": "...", "speaker": "Alex|Sarah|David|Moderator", "text": "..." } }`
- `POST /sessions/:id/next` with `{}` ->
  `{ "turn": { "turnId": "...", "speaker": "...", "text": "..." } }`
- `POST /sessions/:id/turns/:turnId/ack` with
  `{ "event": "completed|cancelled" }` ->
  `{ "turnId": "...", "event": "completed|cancelled", "state": "LISTENING" }`
- `POST /sessions/:id/end` with `{}` -> the evaluation report described below.

The v0.1 success response formats for session creation, messages, and next turns
are unchanged. The end response retains `transcript` and `feedback` while adding
Phase B3 evaluation fields.

## Turn lifecycle

The backend uses one authoritative session state:

`READY -> SPEAKING -> LISTENING -> GENERATING -> SPEAKING`

`LISTENING -> ENDED` is terminal. A newly created session moves through `READY`
to `SPEAKING` when its moderator introduction is returned.

While `SPEAKING`, the frontend must acknowledge the active `turnId` before calling
`/messages`, `/next`, or `/end`:

- `completed` records successful browser playback and moves to `LISTENING`.
- `cancelled` invalidates and removes the uncompleted active turn, preserves all
  previously completed transcript entries, and moves to `LISTENING`.

To handle an interruption, the frontend cancels browser speech, posts `cancelled`
for the active turn, and only then posts the student's new message. Duplicate or
stale turn acknowledgments return `409`. Generation and playback conflicts also
return `409`. A Gemini failure restores the prior `LISTENING` state and transcript.

## Evaluation report

`POST /sessions/:id/end` closes the discussion and returns:

```json
{
  "sessionId": "uuid",
  "status": "complete|partial|insufficient_evidence",
  "transcript": [
    { "turnId": "uuid", "speaker": "Student", "text": "...", "timestamp": "..." }
  ],
  "metrics": {
    "totalStudentTurns": 2,
    "totalAiParticipantTurns": 3,
    "studentContributionPercentage": 24.5,
    "totalStudentWords": 38,
    "totalDiscussionWords": 155,
    "perSpeaker": {
      "Student": { "turns": 2, "words": 38, "wordPercentage": 24.5 }
    },
    "discussionDurationSeconds": 84.2,
    "averageStudentContributionWords": 19
  },
  "feedback": [
    {
      "category": "opening_contribution",
      "status": "assessed|not_assessed",
      "score": 7,
      "explanation": "Concise evidence-based explanation.",
      "improvement": "Specific next action.",
      "evidenceTurnIds": ["actual-transcript-turn-id"]
    }
  ],
  "summary": "Concise overall assessment.",
  "recommendations": ["Concrete recommendation."]
}
```

The six feedback categories are `opening_contribution`,
`argument_quality_and_relevance`, `building_on_others`,
`listening_and_responsiveness`, `handling_disagreements_and_interruptions`, and
`closing_contribution`. A `not_assessed` category has `score: null` and no evidence
IDs. All assessed evidence IDs refer to real stored transcript turns.

`studentContributionPercentage` and each per-speaker percentage are based on word
counts across the stored transcript, including Moderator turns. They are not audio
speaking-time measurements. `totalAiParticipantTurns` counts Alex, Sarah, and David,
not Moderator. No audio duration is inferred or returned.

`complete` means Gemini feedback passed validation. `partial` means deterministic
metrics and the transcript are available but AI evaluation failed validation or was
unavailable. `insufficient_evidence` means there were no student turns to evaluate.
Repeated end requests return the cached report and do not trigger another Gemini call.

## Fixed roles and ownership

Names are fixed: Alex, Sarah, David, Moderator, and Student. Inputs must be
validated. Secret API keys must never appear in a response. Each AI participant
has distinct instructions, and Moderator is a separate role.

Laptop A owns `frontend/**` and frontend `.env`. Laptop B owns `backend/**` and
this contract. Both review contract changes before implementing them.
