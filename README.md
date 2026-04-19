# luxury-language-api

Backend API for **Lux**, a browser-based pronunciation and conversation training platform for English learners. Handles Azure Speech pronunciation assessment, OpenAI-powered coaching and realtime WebRTC conversations, ElevenLabs voice cloning, learner attempt persistence, and admin analytics.

Frontend repo: [lux-frontend](https://github.com/MARKANDALL/lux-frontend)

---

## What This Backend Does

- **Pronunciation assessment** — accepts learner audio uploads, runs them through Azure Pronunciation Assessment, and normalizes the raw output into frontend-friendly summaries with ranked trouble phonemes and trouble words
- **Attempt persistence** — stores learner attempts in Postgres (`public.lux_attempts`) with support for both server-derived summaries and backward-compatible payload shapes
- **AI conversation orchestration** — generates scenario-driven conversation turns, suggested replies, and post-session reports with trouble rollups
- **GPT coaching pipeline** — layered structured coaching on top of Azure speech results, composed from modular pieces (extraction, scoring, personas, prompt construction, JSON repair, translation)
- **Realtime voice sessions** — brokers OpenAI Realtime API WebRTC handshakes for low-latency spoken interaction
- **Azure TTS with timing** — SSML-based text-to-speech with optional word-boundary timing capture for karaoke-style playback
- **Voice Mirror workflows** — ElevenLabs voice cloning, profile management, and synthesis of target text in the learner's own voice
- **Admin analytics** — browser-based admin dashboards for user progress, attempt inspection, and cohort overview

The backend's job is to keep provider keys and sensitive orchestration off the client, normalize unstable provider output into stable contracts the frontend can depend on, and support the product flows that connect assessment, coaching, practice, conversation, and progress into a single learner experience.

---

## Architecture

### Single-function router

All HTTP traffic enters through `api/router.js`, a single Vercel Function that dispatches `/api/:route` requests to handlers in `routes/`. This pattern keeps the deployment under the Vercel Hobby plan's 12-function limit without sacrificing modularity.

The router is shaped to handle two transport modes in one entrypoint:

- **`bodyParser: false`** at the router level, so multipart/form-data audio uploads pass through untouched to routes like `assess`
- **Manual JSON hydration** for the majority of routes that expect JSON bodies

Admin routes gate on a shared `ADMIN_TOKEN` via the `x-admin-token` header. Most routes are lazy-loaded per-request so a single bad import cannot take down the whole API surface.

### Modular coaching pipeline

The `pronunciation-gpt` route is not a single GPT call. It is a composed pipeline with separate modules for:

- Azure result extraction and normalization (`azureExtract.js`)
- Scoring helpers (`scoring.js`)
- Learner history summaries (`historySummary.js`)
- Coaching personas (`personas.js`)
- Prompt construction (`prompt.js`)
- Structured output with JSON repair fallback (`json.js`)
- Translation support (`translate.js`)
- Final coach orchestration (`runCoach.js`)

This makes feedback structured and maintainable, and keeps the coaching behavior inspectable rather than being a black-box single prompt.

---

## Stack

- **Runtime:** Node.js 18+, ES modules
- **Platform:** Vercel serverless (single-function router)
- **Data:** Postgres via `pg` pool (`lib/pool.js`), Supabase admin client (`lib/supabase.js`)
- **Speech:** Azure Cognitive Services Speech SDK, formidable for multipart, fluent-ffmpeg + @ffmpeg-installer/ffmpeg + node-wav for audio handling
- **AI:** OpenAI for coaching and realtime, `jsonrepair` for structured model output
- **Voice cloning:** ElevenLabs (`lib/voice.js`)
- **Testing:** Vitest with supertest for contract tests on router, attempt insertion, and assess-route behavior

---

## Key Routes

- `assess` — Azure pronunciation assessment on multipart audio uploads
- `evaluate` — alternate evaluation pathway for speech-analysis workflows
- `attempt` / `update-attempt` — persist and update learner attempts in Postgres
- `user-recent` — fetch recent attempts for a specific learner
- `convo-turn` — generate AI conversation turns and suggested replies
- `convo-report` — aggregate recent turns into a post-session report with trouble rollups
- `pronunciation-gpt` — modular GPT-based coaching layered on Azure results
- `tts` — Azure TTS with SSML and optional word-boundary timing
- `realtime-webrtc-session` — OpenAI Realtime API WebRTC handshake
- `voice-clone` — create, check, or delete a user's ElevenLabs voice clone
- `voice-mirror` — synthesize target text in a user's cloned voice
- `admin-recent`, `admin-user-stats`, `admin-label-user` — admin analytics surfaces
- `alt-meaning` — alternate-meaning support route
- `migrate` — migration and maintenance support

---

## Admin Dashboards

Browser-based admin pages are served directly from this repo under `admin/`:

- `admin/index.html` — User Progress
- `admin/user.html` — Attempts
- `admin/overview.html` — Cohort Overview

These are protected by `ADMIN_TOKEN` and provide operational visibility into learner activity, attempt trends, trouble sounds, and cohort movement.

---

## Environment Variables

Configured in Vercel → Project → Settings → Environment Variables:

- `AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION`, `AZURE_REGION` — Azure Cognitive Services
- `OPENAI_API_KEY` — GPT and Realtime API
- `ELEVENLABS_API_KEY` — voice cloning
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE` — Supabase admin client
- `DATABASE_URL`, `POSTGRES_URL` — Postgres connection strings
- `ADMIN_TOKEN` — shared secret for admin endpoints
- `CORS_ORIGINS` — allowed origins for cross-origin requests
- `ENABLE_PROSODY` — feature flag for prosody analysis

---

## Development

```bash
npm install
npm test              # run Vitest contract tests
npm run test:watch    # watch mode
npm run hygiene       # backend hygiene report
```

The current script set is centered on test and hygiene workflows. Local development typically runs via the Vercel CLI or alongside the frontend dev server, which proxies `/api/*` to this backend.

---

## Status

Solo development project by [Mark Huguley](https://github.com/MARKANDALL). Active, evolving, and paired closely with the [lux-frontend](https://github.com/MARKANDALL/lux-frontend) repository. Stable central plumbing in most domains; active exploration in voice cloning, realtime, and coaching.

---

## License

Released under the [MIT License](LICENSE) — use, learn from, or remix the code freely. The product, pedagogy, and scenarios remain Mark Huguley's work.