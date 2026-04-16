You are auditing the Lux Pronunciation Tool BACKEND (luxury-language-api) for code health regressions introduced in the last 24 hours of commits. Be surgical, factual, and concise — Mark wants signal, not noise.

SCOPE: Scan all .js and .mjs files under the repo root. Skip node_modules/, .vercel/, _ARCHIVE/, and any folder starting with an underscore.

CANARY FILES — never flag or suggest changes to these (they are the spine of the backend):
- api/router.js
- lib/pool.js
- lib/supabase.js
- lib/voice.js
- vercel.json
- package.json
- routes/evaluate.js

Observations about canaries go in the "Notes" section at the end of the report, not as findings.

CHECKS:

1. POSTGRES POOL DRIFT — Every route that queries Postgres should import the shared pool from lib/pool.js. Find any route file that creates its own `new Pool(...)` or writes to `globalThis.__lux_pool` directly instead of using `import { pool } from "../lib/pool.js"`. Historical context: this 12-line pool-init block was copy-pasted across 6 route files before the lib/pool.js refactor in Feb-March 2026; drift could return.

2. SILENT CATCHES — Find catch blocks whose body is empty `{}`, or contains neither a console.error/console.warn/logger call, nor a rethrow, nor a deliberate error response (res.status(500).json(...)). Routes should at minimum log the error before returning.

3. MISSING AUTH GATE ON PAID ROUTES — Find any route under routes/ that calls OpenAI, Azure Speech, ElevenLabs, or any external paid API WITHOUT an auth check at the top of the handler. The canonical admin-token pattern is:

   const token = (req.headers["x-admin-token"] || "").toString().trim() || (req.query?.token || "").toString().trim();
   const expected = (process.env.ADMIN_TOKEN || "").toString().trim();
   if (!expected || token !== expected) return res.status(401).json({ error: "unauthorized" });

Identify routes by: files importing `openai`, files using `@azure/cognitiveservices-*`, or files making fetch/axios calls to paid-tier HTTPS endpoints.

4. CORS DRIFT — Find any route handler that does not either (a) handle OPTIONS preflight with a 204 response, or (b) set Access-Control-Allow-Origin headers. CORS was tightened in early 2026 to remove wildcard '*' origins; regressions here are security-sensitive.

5. ENV VAR DRIFT — List any `process.env.VARIABLE_NAME` reference in code that has no corresponding entry in .env.example at repo root. Also list entries in .env.example that are referenced nowhere in code. If .env.example does not exist, report that fact.

DO NOT FLAG:
- .GOLD / .GOLD.N backup files
- Canary files
- Anything inside _ARCHIVE/ or underscore-prefixed folders
- Comment-only mentions of pool/CORS/env vars — only flag actual code

Self-check per finding: "what would make this a false positive?" If the answer is "it's inside a comment" or "this is the canonical pattern" or "this route delegates to a lib/ helper that has the check," do not flag.

OUTPUT:
- Create kodama-reports/backend-nightly/YYYY-MM-DD.md
- Open draft PR titled "Backend nightly health scan — YYYY-MM-DD"
- Comment summary on the GitHub issue titled "Backend Nightly Health Tracker". If no such issue exists, create it first and use that.

REPORT STRUCTURE:
# Backend Nightly Health Scan — YYYY-MM-DD

## Summary
[X] pool drift | [X] silent catches | [X] missing auth gate | [X] CORS drift | [X] env var drift

## Findings
### 1. Postgres pool drift
[For each finding: `file/path.js:LINE` — one-sentence description]
[If none: "✅ Clean"]

[Repeat for each category]

## Notes
[Observations about canaries or broader patterns]

RULES:
- Do not fix anything. Report only.
- Be exact about line numbers.
- If all checks pass, still create the report — say "✅ All checks passed" prominently.
