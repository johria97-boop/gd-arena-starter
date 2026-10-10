import express from 'express';
import cors from 'cors';
import { DiscussionEngine } from './engine/discussion.engine.js';
import { createDiscussionRouter } from './routes/discussion.routes.js';
import { GeminiService } from './services/gemini.service.js';
import { FeedbackService } from './services/feedback.service.js';
import { ElevenLabsTtsService } from './services/elevenlabs-tts.service.js';
import { SessionStore } from './store/sessions.js';

export function createApp({
  sessions = new SessionStore(),
  gemini = new GeminiService(),
  feedback = new FeedbackService({ gemini }),
  tts = new ElevenLabsTtsService(),
} = {}) {
  const app = express();
  app.use(cors({ origin: (process.env.FRONTEND_ORIGIN || 'http://localhost:5173').split(',') }));
  app.use(express.json({ limit: '16kb' }));
  app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'gd-arena-api' }));
  app.use('/api', createDiscussionRouter({
    sessions,
    engine: new DiscussionEngine({ sessions, gemini, feedback }),
    tts,
  }));
  app.use((req, res) => res.status(404).json({ error: 'Endpoint not found', code: 'ENDPOINT_NOT_FOUND' }));
  app.use((err, _req, res, _next) => {
    console.error(err.message);
    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
      return res.status(400).json({ error: 'Request body must be valid JSON', code: 'INVALID_JSON' });
    }
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  });
  return app;
}
