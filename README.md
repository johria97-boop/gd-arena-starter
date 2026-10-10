# GD Arena — Phase 0 starter

**Problem statement 2.** Voice-first AI group discussion practice with three AI participants plus a moderator. Phase 0 contains the initial room UI and a working backend connection; voice conversation and feedback are not yet implemented.

## Done / Left / Plan
Done: separate frontend/backend, participant previews, `/api/health`, basic server test, documented API plan. Left: Gemini calls, server-side turn management, STT/TTS, transcript/report, deployed demo. Plan: implement in that order, then test microphone, network failure, mobile and a full discussion.

## Architecture and why
React/Vite frontend: fast UI and browser voice APIs. Express backend: server-owned Gemini key and authoritative conversation state. Initial communication uses simple REST. See `docs/API_CONTRACT.md`.

## How to run
Requires Node.js 20.19+ or 22.12+.

Laptop B / backend:
```bash
cd backend
npm install
# Copy .env.example to .env, customize FRONTEND_ORIGIN if needed
npm run dev
npm test
```
Laptop A / frontend:
```bash
cd frontend
npm install
# Copy .env.example to .env and adjust VITE_API_BASE_URL if accessing a different laptop
npm run dev -- --host 0.0.0.0
```
Open http://localhost:5173. Laptop A must connect to Laptop B's reachable IP, not `localhost`, when running across two computers.

## Tools and AI used
React, Vite, Express, CORS and dotenv. Gemini planned but **not yet connected**. AI participants will be labelled as such.

## Who it is for
Students preparing for placement group discussions who need repeatable practice and concrete feedback.

## Git collaboration
One repo. `feature/frontend` owns only `frontend/**`; `feature/backend` owns `backend/**` and the API contract. Merge verified commits to `main`; never commit `.env`, generated assets or `node_modules`.
