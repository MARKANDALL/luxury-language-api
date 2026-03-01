# System Health Bill of Rights (Backend)

**Repo:** `luxury-language-api` (Vercel/serverless API routes)
**Created:** 2026-03-01
**Baseline audit:** 2026-02-26 (`AUDIT-DUPLICATE-AND-FIGHTING-CODE.md`)
**Owner:** Backend engineering team

---

## Part A: The Rights (Rules)

### Right 1: Single Source of Truth for Postgres Pool

- The Postgres connection pool MUST be initialized in exactly one place: `lib/pool.js`.
- All route files MUST `import { pool } from '../lib/pool.js'`.
- No route file may contain `new Pool(...)` or `globalThis.__lux_pool` inline.
- SSL config, env var fallback order, and pool options are set once and apply everywhere.
- Verification: `rg "new Pool\(" routes/` must return zero results.

### Right 2: Single Source of Truth for Supabase Admin Client

- The Supabase admin/service-role client MUST be created via `lib/supabase.js:getSupabaseAdmin()`.
- No route may construct its own Supabase client or re-resolve env vars for URL/key.
- No route may pass hardcoded URLs or keys to `getSupabaseAdmin({ url, key })`.
- Verification: `rg "createClient" routes/` must return zero results.

### Right 3: Single Source of Truth for CORS Policy

- The router (`api/router.js`) owns CORS header emission.
- No route handler may set `Access-Control-Allow-Origin`, `Access-Control-Allow-Methods`, or `Access-Control-Allow-Headers`.
- The router uses an origin allowlist: Vercel preview URLs, localhost, and `CORS_ORIGINS` env var.
- Wildcard `*` is never used for `Access-Control-Allow-Origin`.
- Exception: `routes/attempt.js` has its own `pickOrigin()` that mirrors the router logic for its public endpoint. This should be migrated to the router pattern.
- Verification: `rg "Access-Control-Allow-Origin" routes/` must return zero results (target state).

### Right 4: Single Source of Truth for Admin Token Parsing

- Admin token normalization (quote-stripping, trimming) MUST use a single `normToken()` function.
- Canonical location: `lib/auth.js` (to be extracted from `api/router.js:38-42`).
- All routes that validate admin tokens MUST use the same normalization as the router.
- Route-level re-validation of `ADMIN_TOKEN` is acceptable as belt-and-suspenders defense-in-depth, but MUST use the shared `normToken()`.
- Verification: `rg "function normToken" .` must return exactly one result.

### Right 5: No Hardcoded Secrets in Source Code

- No source file may contain hardcoded Supabase URLs, service role keys, JWT tokens, admin tokens, API keys, or other credentials.
- All secrets MUST come from `process.env` with no fallback default values.
- If an env var is missing, the code MUST fail loudly with a clear error message (not silently use a stale fallback).
- Verification: `rg "eyJ|sIMON|supabase\.co" routes/ lib/ api/` must return zero results.

### Right 6: No Wildcard CORS Overriding Router Policy

- Route-level `cors(res)` functions that set `Access-Control-Allow-Origin: "*"` are PROHIBITED.
- The router's origin-checked CORS runs before route handlers. Route handlers must not overwrite those headers.
- Any route that needs custom CORS (e.g., `Access-Control-Expose-Headers`) must APPEND headers, not replace the origin header.
- Verification: `rg '"\\*"' routes/ | grep -i "allow-origin"` must return zero results.

### Right 7: No Dead Duplicate Files

- Every source file must be reachable (imported by a live code path or the router).
- Dead copies of active files are deleted, not left as "backup" (use git history for that).
- Before creating a new file that overlaps with an existing one, check `api/router.js` ROUTES map.
- Verification: Files in `admin/` that duplicate `routes/` must not exist.

### Right 8: Consistent Numeric Parsing

- Safe numeric conversion MUST use a single utility function (currently `safeNum` in `routes/pronunciation-gpt/scoring.js`).
- The alias `numOrNull` in `routes/attempt.js` must be replaced with an import of `safeNum`.
- Any new numeric parsing should use the same utility rather than inlining `Number.isFinite` guards.
- Verification: `rg "function numOrNull"` must return zero results (target state).

### Right 9: Router Gates Admin-Only Routes

- Cost-sensitive routes (those calling paid external APIs: TTS, OpenAI, Azure) are listed in the router's `ADMIN_ONLY` set.
- The router rejects unauthorized requests BEFORE dispatching to the handler.
- Route-level admin checks are acceptable as defense-in-depth but must not differ in behavior from the router check.
- Verification: Review `ADMIN_ONLY` set in `api/router.js` matches all paid-API routes.

### Right 10: Clear Failure When Env Vars Are Missing

- Every external service dependency (Postgres, Supabase, Azure, OpenAI) must check for required env vars at call time.
- Missing vars produce a 500 response with a descriptive `error` field (e.g., `"missing_azure_speech_key"`).
- No silent fallback to default/empty values that would cause confusing downstream failures.
- Verification: Each `lib/*.js` utility throws on missing required env vars.

### Right 11: GOLD Backup Before Edits

- Before modifying any production file, create a `file.js.GOLD` backup copy.
- The GOLD file is committed alongside the change for immediate rollback.
- Rollback: `cp file.js.GOLD file.js && git add file.js && git commit`.
- GOLD files are cleaned up in a follow-up PR after verification in production.

### Right 12: Contract Tests Guard Critical Endpoints

- Every route that writes to Postgres (`attempt`, `update-attempt`) has a contract test in `test/`.
- Contract tests verify: correct status codes, response shape, error handling for missing fields.
- Tests run via `npm test` (vitest) and must pass before deploy.
- New routes must include a contract test before merging.

### Right 13: No Import-Time Crashes

- No module-level code may throw errors that crash the entire router.
- External service clients (Supabase, Postgres) must be lazily initialized inside handlers or behind `try/catch`.
- Heavy/risky imports (ffmpeg, speech SDK) use `lazyRoute()` in the router.
- Verification: `node -e "import('./api/router.js')"` succeeds even with no env vars set.

### Right 14: Hygiene Scripts Run in CI

- `npm run hygiene` (when implemented) checks for violations of these rights.
- CI blocks merge on hygiene failures.
- Hygiene checks include: no hardcoded secrets, no duplicate pool init, no wildcard CORS, no dead files.

---

## Part B: Single Source of Truth Charter

| Utility | Canonical Location | Owner Pattern | Consumers |
|---------|-------------------|---------------|-----------|
| **Postgres pool** | `lib/pool.js` (TO BE CREATED) | `globalThis.__lux_pool` singleton, one `new Pool()` | All 6 DB routes: `attempt`, `admin-recent`, `convo-report`, `update-attempt`, `user-recent`, `migrate` |
| **Supabase admin client** | `lib/supabase.js:getSupabaseAdmin()` | Lazy singleton, env-var-only resolution | `admin-label-user`, `admin-user-stats`, `pronunciation-gpt/historySummary` |
| **CORS policy** | `api/router.js:202-233` | Origin allowlist + localhost + Vercel preview auto-allow | All routes (via router dispatch) |
| **Admin token normalization** | `api/router.js:38-42` (`normToken`) — propose extract to `lib/auth.js` | Quote-strip + trim | Router admin gate, `tts.js`, and all routes with token checks |
| **Numeric parsing** | `routes/pronunciation-gpt/scoring.js:safeNum` — propose move to `lib/math.js` (future) | `Number()` + `Number.isFinite` guard | `attempt.js` (as `numOrNull`), all pronunciation-gpt modules |

---

## Part C: Security Non-Negotiables

### C.1: No Hardcoded Secrets or Fallback Credentials

- **ZERO TOLERANCE.** No Supabase URL, service role key, JWT, admin token, or API key may appear as a string literal in source.
- All secrets read from `process.env` only.
- If env var is empty/missing, the code must fail with an explicit error, never fall back to a hardcoded value.
- **Current violation:** `routes/admin-user-stats.js:5-18` contains hardcoded Supabase URL, service role JWT, and admin token `'sIMON***'`. **STATUS: CODE RED, NOT FIXED.**

### C.2: No Wildcard CORS Bypassing Router Policy

- The router implements origin-checked CORS. Route-level `Access-Control-Allow-Origin: "*"` overwrites this safety.
- **Current violations:** 9 route files set wildcard CORS. **STATUS: NOT FIXED.**
  - `routes/assess.js:14`
  - `routes/convo-turn.js:9`
  - `routes/convo-report.js:23`
  - `routes/migrate.js:20`
  - `routes/update-attempt.js:22`
  - `routes/user-recent.js:31`
  - `routes/alt-meaning.js:13`
  - `routes/pronunciation-gpt.js:37`
  - `routes/realtime-webrtc-session.js:37`

### C.3: Auth / Token Parsing Consistency

- All admin token checks must normalize the same way (trim + quote-strip).
- Routes that do plain `.trim()` without quote-stripping (`pronunciation-gpt`, `update-attempt`, `convo-turn`, etc.) will reject quoted tokens that the router accepts. This is an inconsistency, not a security hole (the router gate runs first for `ADMIN_ONLY` routes), but it causes confusing debugging.
- **Target:** All route-level checks import shared `normToken()`.

### C.4: Clear Failure When Env Vars Missing

- `admin-user-stats.js` currently falls back to hardcoded credentials when env vars are missing. This masks misconfiguration.
- `lib/supabase.js` correctly throws on missing URL/key.
- `realtime-webrtc-session.js:62-63` has a "TEMP" comment that skips auth when `ADMIN_TOKEN` is unset. This should be removed once env vars are configured in all environments.

---

## Part D: Verification & Rollback

### Contract Tests

```bash
npm test                    # vitest run — contract tests for assess, attempt, router
```

### Hygiene Grep Checks (CI-friendly)

```bash
# 1. No hardcoded secrets
rg "eyJ|sIMON|supabase\.co" routes/ lib/ api/ && echo "FAIL: hardcoded secrets found" && exit 1

# 2. No duplicate pool init
rg "new Pool\(" routes/ && echo "FAIL: pool init outside lib/pool.js" && exit 1

# 3. No wildcard CORS in routes
rg 'Allow-Origin.*"\*"' routes/ && echo "FAIL: wildcard CORS in route" && exit 1

# 4. No dead admin/ duplicate
test -f admin/admin-label-user.js && echo "FAIL: dead duplicate exists" && exit 1

# 5. Single normToken definition
count=$(rg -c "function normToken" . --glob '*.js' | wc -l)
[ "$count" -gt 1 ] && echo "FAIL: normToken defined in $count files" && exit 1

echo "ALL HYGIENE CHECKS PASSED"
```

### Minimal Endpoint Checks (post-deploy)

```bash
# Health check
curl -s "https://$DEPLOY_URL/api/router?route=ping" | jq .ok
# Expect: true

# Auth rejection (no token)
curl -s "https://$DEPLOY_URL/api/router?route=tts" | jq .error
# Expect: "unauthorized"

# CORS check (unknown origin)
curl -sI -H "Origin: https://evil.com" "https://$DEPLOY_URL/api/router?route=ping" | grep -i "access-control-allow-origin"
# Expect: header NOT present (or empty)

# CORS check (valid origin)
curl -sI -H "Origin: https://lux-frontend.vercel.app" "https://$DEPLOY_URL/api/router?route=ping" | grep -i "access-control-allow-origin"
# Expect: https://lux-frontend.vercel.app
```

### Rollback Steps

1. **Per-file rollback:** `cp file.js.GOLD file.js` (if GOLD backups were created).
2. **Git rollback:** `git revert <commit-sha>` (preferred — preserves history).
3. **Emergency rollback:** `git revert --no-edit HEAD~N` where N = number of patch commits.
4. **Vercel rollback:** Use Vercel dashboard to redeploy previous successful deployment.

---

## Part E: Updated Audit Status Table (Feb 26 -> Mar 1)

| # | Issue | Status | Evidence | Risk | Next Action |
|---|-------|--------|----------|------|-------------|
| 1 | **Hardcoded credentials** in `admin-user-stats.js` (Supabase URL, service role JWT, admin token) | **NOT STARTED** | `routes/admin-user-stats.js:5-18` — hardcoded URL fallback `https://pvgg...supabase.co`, JWT fallback `eyJhbG...`, admin token fallback `sIMON***` | **CRITICAL** | Remove all fallbacks; use `getSupabaseAdmin()` from `lib/supabase.js` directly; use `normToken` for admin check |
| 2 | **Wildcard CORS** overriding router in 9 route files | **NOT STARTED** | `routes/assess.js:14`, `convo-turn.js:9`, `convo-report.js:23`, `migrate.js:20`, `update-attempt.js:22`, `user-recent.js:31`, `alt-meaning.js:13`, `pronunciation-gpt.js:37`, `realtime-webrtc-session.js:37` | **HIGH** | Remove all route-level CORS headers; router handles it |
| 3 | **Postgres pool duplicated** in 6 route files | **NOT STARTED** | `routes/attempt.js:7-19`, `admin-recent.js:5-18`, `convo-report.js:8-20`, `update-attempt.js:6-18`, `user-recent.js:8-20`, `migrate.js:4-16` — all contain identical `globalThis.__lux_pool` block | **HIGH** | Create `lib/pool.js`; replace inline blocks with import |
| 4 | **`normToken()` duplicated** in router + tts.js; inconsistent `.trim()`-only in 8+ routes | **NOT STARTED** | `api/router.js:38-42` and `routes/tts.js:33-36` have quote-stripping; all other routes do `.trim()` only | **MED** | Export from router or `lib/auth.js`; update all routes |
| 5 | **`admin/admin-label-user.js` dead duplicate** | **NOT STARTED** | Byte-for-byte match of `routes/admin-label-user.js` minus 2 comment lines. Never imported. | **MED** | Delete `admin/admin-label-user.js` |
| 6 | **`numOrNull` / `safeNum` duplicate** | **NOT STARTED** | `routes/attempt.js:42-45` (`numOrNull`), `routes/pronunciation-gpt/scoring.js:4-7` (`safeNum`) — identical logic | **LOW** | Replace `numOrNull` with import of `safeNum` |
| 7 | **`admin-user-stats.js` has its own Supabase client factory** (`getSupabaseClient`) with hardcoded fallbacks, despite importing `getSupabaseAdmin` | **NOT STARTED** | `routes/admin-user-stats.js:3,20-28` — imports `getSupabaseAdmin` but wraps it with local hardcoded URL/key | **HIGH** | Remove local factory; call `getSupabaseAdmin()` directly |
| 8 | **`admin-user-stats.js` admin token check differs** from all other routes | **NOT STARTED** | `routes/admin-user-stats.js:18,40` — uses `ADMIN_TOKEN` const with fallback, no `.trim()`, no normalization | **HIGH** | Use same pattern as other routes (or router gate) |
| 9 | **`realtime-webrtc-session.js` TEMP auth bypass** when ADMIN_TOKEN unset | **NOT STARTED** | `routes/realtime-webrtc-session.js:62-64` — comment says "TEMP", skips auth if env var missing | **MED** | Remove TEMP bypass once env vars confirmed in all envs |
| 10 | **`attempt.js` has its own CORS logic** (`pickOrigin`) that duplicates router | **NOT STARTED** | `routes/attempt.js:22-31` — reimplements origin allowlist check | **LOW** | Remove; rely on router CORS (attempt is not `ADMIN_ONLY` but still routed) |
| 11 | **`lib/supabase.js` already centralized** | **FIXED** | `lib/supabase.js:1-54` — singleton with env-var-only resolution, no hardcoded fallbacks | N/A | Already correct |
| 12 | **Router CORS already well-implemented** | **FIXED** | `api/router.js:202-233` — origin allowlist, Vercel preview regex, localhost auto-allow | N/A | Already correct; enforce routes don't override |

---

## Part F: Security Sweep Findings

### Finding 1: CRITICAL — Hardcoded Supabase Service Role JWT

- **File:** `routes/admin-user-stats.js:10-16`
- **What:** Hardcoded JWT token as fallback for `SERVICE_ROLE` variable. This is a full-privilege service role key that grants unrestricted access to the Supabase database.
- **Value:** `eyJhbG...` (REDACTED — full JWT visible in source)
- **Severity:** **CRITICAL**
- **Remediation:**
  1. Remove the hardcoded fallback entirely
  2. Rotate the exposed service role key in Supabase dashboard
  3. Use `getSupabaseAdmin()` from `lib/supabase.js` (no args)
- **Deployment prereq:** Ensure `SUPABASE_SERVICE_ROLE` or equivalent is set in all Vercel environments

### Finding 2: CRITICAL — Hardcoded Admin Token

- **File:** `routes/admin-user-stats.js:18`
- **What:** Admin token `sIMON***` hardcoded as fallback. Anyone with source access (repo collaborators, leaked code) can authenticate as admin.
- **Severity:** **CRITICAL**
- **Remediation:**
  1. Remove the hardcoded fallback
  2. Change the live `ADMIN_TOKEN` env var to a new value
  3. Use same `normToken` + `process.env.ADMIN_TOKEN` pattern as other routes
- **Deployment prereq:** Ensure `ADMIN_TOKEN` is set in all Vercel environments

### Finding 3: CRITICAL — Hardcoded Supabase Project URL

- **File:** `routes/admin-user-stats.js:5-8`
- **What:** Hardcoded Supabase project URL `https://pvgg...supabase.co` as fallback. While not a secret per se, it's part of the credentials puzzle and should not be in source.
- **Severity:** **HIGH**
- **Remediation:** Remove fallback; rely on `SUPABASE_URL` env var

### Finding 4: HIGH — Wildcard CORS in 9 Route Files

- **Files:** See audit table item #2
- **What:** Route-level `Access-Control-Allow-Origin: "*"` overwrites the router's origin-checked CORS headers, allowing any website to make authenticated cross-origin requests.
- **Severity:** **HIGH**
- **Remediation:** Delete all route-level CORS header setters; rely on router

### Finding 5: MED — TEMP Auth Bypass in WebRTC Session

- **File:** `routes/realtime-webrtc-session.js:62-64`
- **What:** When `ADMIN_TOKEN` env var is unset, the endpoint is open to anyone (expensive OpenAI Realtime API calls).
- **Severity:** **MED** (only applies when env var is missing)
- **Remediation:** Remove TEMP bypass; fail closed when env var is missing

### Finding 6: LOW — Token in Query String

- **Files:** Multiple routes accept `req.query.token`
- **What:** Admin tokens in URLs get logged in server access logs, browser history, Vercel function logs. Not ideal.
- **Severity:** **LOW** (convenience feature for dev/testing)
- **Remediation:** Document as accepted risk for admin endpoints; ensure production logs are access-controlled

---

## Part G: Tactical Fix Plan (Top 10)

### Fix 1: Remove Hardcoded Credentials from `admin-user-stats.js`

**Why:** CRITICAL security — hardcoded service role JWT and admin token in source code. Anyone with repo access has full DB access.

**Files:**
- `routes/admin-user-stats.js` — remove lines 5-18 (hardcoded const declarations), replace `getSupabaseClient()` with `getSupabaseAdmin()`, replace admin token check with standard pattern

**Verification:**
- `rg "eyJ|sIMON|supabase\.co" routes/` returns zero results
- Deploy to preview; call `/api/router?route=admin-user-stats&token=$ADMIN_TOKEN` — should work
- Call without token — should return 401

**Rollback:** `cp routes/admin-user-stats.js.GOLD routes/admin-user-stats.js`

---

### Fix 2: Remove Wildcard CORS from All Route Files

**Why:** HIGH security — route-level wildcard `*` overrides router's origin-checked CORS, allowing any website to call these endpoints.

**Files (9 files):**
- `routes/assess.js` — remove `cors(res)` function and call
- `routes/convo-turn.js` — remove `cors(res)` function and call
- `routes/convo-report.js` — remove `cors(res)` function and call
- `routes/migrate.js` — remove CORS header lines
- `routes/update-attempt.js` — remove CORS header lines
- `routes/user-recent.js` — remove CORS header lines
- `routes/alt-meaning.js` — remove CORS header lines
- `routes/pronunciation-gpt.js` — remove CORS header lines
- `routes/realtime-webrtc-session.js` — remove CORS header lines (keep `Expose-Headers` as append)

**Verification:**
- `rg 'Allow-Origin' routes/` returns zero results (except `attempt.js:pickOrigin` which should be addressed separately)
- CORS header on response matches the requesting origin, never `*`

**Rollback:** Restore CORS lines from GOLD backups or `git revert`

---

### Fix 3: Centralize Postgres Pool to `lib/pool.js`

**Why:** HIGH drift risk — 6 identical 12-line blocks. Any config change requires editing 6 files. If one drifts, the `globalThis` cache means behavior depends on which route is called first.

**Files:**
- NEW: `lib/pool.js` — extract the pool singleton
- `routes/attempt.js` — replace inline block with `import { pool } from '../lib/pool.js'`
- `routes/admin-recent.js` — same
- `routes/convo-report.js` — same
- `routes/update-attempt.js` — same
- `routes/user-recent.js` — same
- `routes/migrate.js` — same

**Verification:**
- `rg "new Pool\(" routes/` returns zero results
- `npm test` passes
- Test each DB-using endpoint returns expected data

**Rollback:** Restore inline blocks from GOLD backups

---

### Fix 4: Delete Dead Duplicate `admin/admin-label-user.js`

**Why:** MED risk — dead file can mislead developers into editing the wrong copy.

**Files:**
- DELETE: `admin/admin-label-user.js`

**Verification:**
- `rg "admin/admin-label-user" .` returns zero import references
- `/api/router?route=admin-label-user` still works (uses `routes/` copy)

**Rollback:** `git checkout -- admin/admin-label-user.js`

---

### Fix 5: Centralize Admin Token Normalization

**Why:** MED — inconsistent parsing: router and tts.js strip quotes; all other routes don't. Leads to confusing auth failures.

**Files:**
- NEW or modify: extract `normToken` to `lib/auth.js` (or export from router)
- `routes/tts.js` — remove local `normToken`, import shared
- Routes with `.trim()`-only token parsing — update to use `normToken`

**Verification:**
- `rg "function normToken"` returns exactly 1 result
- Token with surrounding quotes accepted consistently

**Rollback:** Restore local functions

---

### Fix 6: Clean Up `admin-user-stats.js` Supabase Client

**Why:** After Fix 1, this file should use `getSupabaseAdmin()` directly (no local `getSupabaseClient` wrapper).

**Files:**
- `routes/admin-user-stats.js` — remove `getSupabaseClient()`, call `getSupabaseAdmin()` in handler

**Verification:**
- Endpoint returns data when env vars are set
- Returns clear error when env vars are missing

**Rollback:** Part of Fix 1 rollback

---

### Fix 7: Remove `attempt.js` Duplicate CORS Logic

**Why:** LOW — `pickOrigin()` in `attempt.js` reimplements the router's CORS logic. The router already sets CORS headers before dispatching.

**Files:**
- `routes/attempt.js` — remove `pickOrigin` function, remove CORS header setting in handler

**Verification:**
- CORS headers on `/api/attempt` responses come from router, not route
- Frontend can still POST attempts

**Rollback:** Restore `pickOrigin` function

---

### Fix 8: Replace `numOrNull` with `safeNum` Import

**Why:** LOW drift risk — identical logic under different names.

**Files:**
- `routes/attempt.js` — remove `numOrNull` function, import `safeNum` from `./pronunciation-gpt/scoring.js`, alias or replace all call sites

**Verification:**
- `rg "function numOrNull"` returns zero results
- Attempt contract test passes

**Rollback:** Restore local function

---

### Fix 9: Remove TEMP Auth Bypass in WebRTC Session

**Why:** MED — open-by-default when env var is missing allows unauthorized OpenAI Realtime API calls (expensive).

**Files:**
- `routes/realtime-webrtc-session.js` — change to fail closed: if `!expected`, return 401

**Verification:**
- Without `ADMIN_TOKEN` set: endpoint returns 401
- With `ADMIN_TOKEN` set + correct token: endpoint works

**Rollback:** Restore TEMP behavior

---

### Fix 10: Add `ADMIN_ONLY` Coverage for All Admin Routes

**Why:** LOW — `admin-user-stats`, `admin-recent`, `admin-label-user`, `migrate` have their own token checks but are not in the router's `ADMIN_ONLY` set. Adding them provides defense-in-depth.

**Files:**
- `api/router.js` — uncomment/add these routes to `ADMIN_ONLY` set

**Verification:**
- Calling these routes without token returns 401 from router (not route handler)
- Calling with valid token works normally

**Rollback:** Remove routes from `ADMIN_ONLY` set
