You are performing a weekly architecture audit on the Lux Pronunciation Tool BACKEND (luxury-language-api).

SCOPE: Scan routes/, lib/, api/. Skip node_modules/, .vercel/, underscore-prefixed folders.

CANARY FILES (inform, don't flag):
- api/router.js
- lib/pool.js
- lib/supabase.js
- lib/voice.js
- vercel.json
- package.json
- routes/evaluate.js

RUN SEQUENTIALLY — do one check at a time, fully, before moving to the next. No parallel sub-agents. The frontend weekly variant of this routine has timed out when running too many checks concurrently.

CHECKS:

1. OVERSIZED ROUTE FILES — List any file under routes/ longer than 400 lines. For each: line count, one-line description of what the route does, and whether it could reasonably be split (multiple unrelated responsibilities = yes; one heavy handler with unavoidable complexity = no).

2. LIB HELPER USAGE — For each file in lib/, count how many route files import from it. Flag:
   - lib helpers imported by 0 routes (dead code candidate)
   - lib helpers imported by exactly 1 route (may belong IN that route rather than as a shared helper)
   Also list the top 3 most-imported lib helpers — these are the true canaries and should be treated with extra care.

3. ROUTER HEALTH — Read api/router.js. Count routes registered in the ROUTES const. List:
   - Routes imported at top of file but not present in ROUTES (dead import)
   - Entries in ROUTES that reference an undefined symbol (broken registration)
   - Any lazy-loaded route whose lazyRoute() target file does not exist

DO NOT CHECK:
- Code style or formatting
- Comment density
- Test coverage (separate concern)
- Dependency version staleness (monthly hygiene handles this)

Self-check per finding: is this a long-standing stable pattern? If yes, downgrade from finding to informational note.

OUTPUT:
- Create kodama-reports/backend-weekly/YYYY-WW.md (WW = ISO week number)
- Draft PR titled "Backend weekly architecture audit — YYYY week WW"
- Comment summary on GitHub issue titled "Backend Weekly Architecture Tracker" (create if missing)

REPORT STRUCTURE:
# Backend Weekly Architecture Audit — YYYY Week WW

## Summary
- Oversized route files: [X]
- Dead/single-use lib helpers: [X]
- Router registration issues: [X]

## Findings
[Per check]

## Notes
[Canary observations, stable patterns, long-term trends]

RULES:
- Run sequentially. No parallel sub-agents.
- Keep report under 1500 words. Architecture concerns need brevity.
- Report only. No fixes.
- If a check returns nothing actionable, say so and move on.
