# luxury-language-api

Backend API for **Lux**, a browser-based English pronunciation and AI conversation training platform. Handles Azure Speech pronunciation assessment, OpenAI-powered coaching and realtime WebRTC conversations, and ElevenLabs voice cloning for the Voice Mirror feature.

Frontend repo: [lux-frontend](https://github.com/MARKANDALL/lux-frontend)

## Stack

- **Runtime:** Node.js 18+, ES modules
- **Platform:** Vercel serverless (single-function router pattern to stay under the Hobby plan's 12-function limit)
- **Data:** Postgres via `pg` connection pool, Supabase for auth and storage
- **Speech:** Azure Cognitive Services Speech SDK (pronunciation assessment, TTS)
- **AI:** OpenAI GPT (coaching, scenario generation), OpenAI Realtime API (WebRTC voice conversations)
- **Voice cloning:** ElevenLabs IVC API
- **Testing:** Vitest with supertest for route contract tests

## Architecture

All HTTP traffic enters through `api/router.js`, a single Vercel Function that dispatches `/api/:route` requests to handlers in `routes/`. Routes are lazy-loaded per-request to keep cold starts fast. Admin routes gate on a shared `ADMIN_TOKEN` via `x-admin-token` header.

Key routes:
- `assess` — Azure pronunciation assessment on multipart audio uploads
- `attempt` / `update-attempt` — persist attempts to Postgres (`public.lux_attempts`)
- `convo-turn` / `convo-report` — AI conversation turns and post-session feedback
- `pronunciation-gpt` — GPT-based coaching layered on Azure results
- `realtime-webrtc-session` — issues OpenAI Realtime API session tokens
- `tts` — Azure TTS with SSML support
- `voice-mirror` / `voice-clone` — ElevenLabs voice profile creation

## Environment variables

Configured in Vercel → Project → Settings → Environment Variables:

- `AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION` — Azure Cognitive Services
- `AZURE_REGION` — additional Azure region config
- `OPENAI_API_KEY` — GPT and Realtime API
- `ELEVENLABS_API_KEY` — Voice cloning
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE` — Supabase admin client
- `DATABASE_URL`, `POSTGRES_URL` — Postgres connection strings
- `ADMIN_TOKEN` — shared secret for admin endpoints
- `CORS_ORIGINS` — allowed origins for cross-origin requests
- `ENABLE_PROSODY` — feature flag for prosody analysis

## Development

```bash
npm install
npm test              # run Vitest contract tests
npm run test:watch    # watch mode
npm run hygiene       # backend hygiene report
```

## Status

Solo development project by [@MARKANDALL](https://github.com/MARKANDALL). Active since mid-2024.