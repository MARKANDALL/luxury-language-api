# Duplicate & Fighting Code Audit Report

**Scope:** `lux-frontend` + `luxury-language-api`
**Date:** 2026-02-26
**Auditor:** Automated repo-wide analysis (senior engineer perspective)

---

## A) Executive Summary

### Top 5 Highest-Confidence "Fighting Code" Conflicts

| # | Conflict | Files | Impact |
|---|----------|-------|--------|
| 1 | **`window.LuxLastRecordingBlob` written by TWO independent paths** — `app-core/runtime.js:42` (canonical setter via `setLastRecording()`) AND `features/convo/convo-turn.js:37` (direct assignment bypassing runtime.js). Both fire `lux:lastRecording` events, risking double-attach in SelfPlayback. | `app-core/runtime.js`, `features/convo/convo-turn.js` | High |
| 2 | **`window.LuxKaraokeSource` / `window.LuxKaraokeTimings` written by 3 competing modules** — TTS karaoke (`tts/player-ui/karaoke.js:83-84`), SelfPB controls (`selfpb/controls.js:19-20`), and SelfPB karaoke (`selfpb/karaoke.js:220-233`). Each overwrites the other's values, causing karaoke highlight flicker when both drawers are open. | `features/features/tts/player-ui/karaoke.js`, `features/features/selfpb/controls.js`, `features/features/selfpb/karaoke.js` | High |
| 3 | **`document.body.style.overflow` toggled by 2 independent modal systems** — Metric modal (`interactions/metric-modal/events.js:72,116`) and Attempt Detail modal (`progress/attempt-detail/modal-shell.js:54,70`). If both open, closing one resets body overflow to `""` while the other expects `"hidden"`, causing scroll-under-modal. | `features/interactions/metric-modal/events.js`, `features/progress/attempt-detail/modal-shell.js` | High |
| 4 | **3 capture-phase document click handlers competing** — `my-words/panel-events.js:122` (wiggle logic), `interactions/metric-modal/events.js:191` (score tile open), `interactions/ph-hover/chip-events.js:43` (phoneme chip pin). All use `capture: true` and call `stopPropagation()`, so whichever fires first can swallow clicks intended for the others. | `features/my-words/panel-events.js`, `features/interactions/metric-modal/events.js`, `features/interactions/ph-hover/chip-events.js` | Medium |
| 5 | **`window.luxTTS` mutated by 2 modules at boot** — `convo-tts-context.js:94` sets `sourceMode`/`autoVoice`, and `tts/player-ui.js:103` does the same. On the convo page both run, and whichever completes last wins, potentially overwriting the other's intent. | `features/convo/convo-tts-context.js`, `features/features/tts/player-ui.js` | Medium |

### Top 5 Highest-Impact Duplicates Likely Causing Inconsistency

| # | Duplicate | Files | Risk |
|---|-----------|-------|------|
| 1 | **Postgres pool singleton** — identical 12-line `globalThis.__lux_pool` init block copy-pasted into 6 route files in the API. Any drift in SSL config or env var names silently creates a second pool. | `routes/attempt.js`, `routes/admin-recent.js`, `routes/convo-report.js`, `routes/update-attempt.js`, `routes/user-recent.js`, `routes/migrate.js` | High |
| 2 | **`admin/admin-label-user.js` is a byte-for-byte duplicate** of `routes/admin-label-user.js` (77 vs 78 lines, only comment differs). Only the `routes/` copy is wired into the router; the `admin/` copy is dead code that could be mistakenly edited. | `admin/admin-label-user.js`, `routes/admin-label-user.js` | Medium |
| 3 | **`numOrNull()` / `safeNum()`** — identical `Number.isFinite` guard duplicated: `routes/attempt.js:42-45` (`numOrNull`), `routes/pronunciation-gpt/scoring.js:4-7` (`safeNum`). Logic is the same; names differ, inviting drift. | `routes/attempt.js`, `routes/pronunciation-gpt/scoring.js` | Medium |
| 4 | **`normToken()` duplicated** in `api/router.js:38-42` and `routes/tts.js:33-36` (identical regex). Other routes do plain `.trim()` without quote-stripping (`pronunciation-gpt.js:46`, `update-attempt.js:30`), creating inconsistent token parsing. | `api/router.js`, `routes/tts.js`, `routes/pronunciation-gpt.js`, `routes/update-attempt.js` | Medium |
| 5 | **CORS `cors(res)` function** duplicated with `Access-Control-Allow-Origin: "*"` in 3 route files (`assess.js:13`, `convo-turn.js:8`, `convo-report.js:22`) while the router already sets origin-checked CORS headers (`api/router.js:221-233`). The route-level wildcard `*` overrides the router's safer origin check. | `routes/assess.js`, `routes/convo-turn.js`, `routes/convo-report.js`, `api/router.js` | High |

### First Fixes (max 3, surgical, high ROI)

1. **`convo-turn.js` → use `setLastRecording()` from `app-core/runtime.js`** instead of direct `window.LuxLastRecordingBlob = ...` assignment. ~5-line change. Eliminates the #1 fighting code conflict and the duplicate `lux:lastRecording` event dispatch.

2. **Extract `lib/pool.js` in the API** that exports the singleton pool. Replace the 12-line copy-paste block in all 6 route files with `import { pool } from '../lib/pool.js'`. ~20 lines new, ~72 lines deleted. Eliminates drift risk entirely.

3. **Delete `admin/admin-label-user.js`** (the dead duplicate). The router imports from `routes/admin-label-user.js`; the `admin/` copy is unreachable dead code. 1 file deletion, zero behavior change.

---

## B) Findings Table (Prioritized)

### B.1 — Fighting Code: `window.LuxLastRecordingBlob` dual-write

| Field | Detail |
|-------|--------|
| **Category** | Fighting code |
| **Impact** | High |
| **Confidence** | High |
| **Evidence** | `app-core/runtime.js:37-54` — `setLastRecording(blob, meta)` sets `window.LuxLastRecordingBlob`, `window.LuxLastRecordingMeta`, dispatches `lux:lastRecording`. `features/convo/convo-turn.js:37-51` — directly sets `window.LuxLastRecordingBlob = audioBlob`, `window.LuxLastRecordingMeta = {...}`, dispatches its own `lux:lastRecording`. |
| **Why it's a problem** | SelfPlayback (`features/features/selfpb/ui.js:63-69`) listens to `lux:lastRecording` to auto-attach the learner blob. If `convo-turn.js` fires the event without going through `runtime.js`, the internal `_lastRecordingBlob` variable and the window global diverge. Any code calling `getLastRecording()` may get stale data. The double event can also cause the waveform to re-render twice. |
| **Recommended canonical source** | `app-core/runtime.js` — it was designed as "single source of truth for cross-feature current run state" (line 2 comment). |
| **Minimal fix plan** | In `convo-turn.js`: `import { setLastRecording } from "../../app-core/runtime.js"` → replace lines 37-51 with `setLastRecording(audioBlob, { mode, type: audioBlob?.type, size: audioBlob?.size, ts: Date.now(), scope: "convo" })`. Remove the manual `dispatchEvent` call. |
| **Risk & rollback** | Low risk: `setLastRecording` already does everything the manual code does. Rollback: revert the single file. |

### B.2 — Fighting Code: Karaoke globals written by 3 modules

| Field | Detail |
|-------|--------|
| **Category** | Fighting code |
| **Impact** | High |
| **Confidence** | High |
| **Evidence** | `window.LuxKaraokeSource` written at: `tts/player-ui/karaoke.js:83` (publishKaraoke), `selfpb/controls.js:19` (setKaraokeLearner), `selfpb/karaoke.js:220,232` (event handlers). `window.LuxKaraokeTimings` written at the same locations +  `selfpb/controls.js:20`. |
| **Why it's a problem** | When TTS plays a reference audio and the user also has a learner recording, both systems race to set `LuxKaraokeSource`. The SelfPB expanded view reads it to decide which audio element to sync. If TTS sets it to `"tts"` right after SelfPB set it to `"learner"`, the karaoke cursor tracks the wrong audio, causing visual desync (words highlight at wrong times). |
| **Recommended canonical source** | `tts/player-ui/karaoke.js:publishKaraoke()` should be the ONLY writer. SelfPB should call `publishKaraoke("learner", timings)` instead of direct assignment. |
| **Minimal fix plan** | 1. Export `publishKaraoke` from `tts/player-ui/karaoke.js`. 2. In `selfpb/controls.js`, replace lines 18-28 with a call to `publishKaraoke("learner", timings)`. 3. In `selfpb/karaoke.js` event handlers (lines 220-221, 232-233), call `publishKaraoke` instead of direct assignment. |
| **Risk & rollback** | Low: `publishKaraoke` already dispatches the `lux:karaokeRefresh` event that SelfPB listens to. Rollback: revert 2 files. |

### B.3 — Fighting Code: `document.body.style.overflow` toggled by 2 modals

| Field | Detail |
|-------|--------|
| **Category** | Fighting code / CSS conflict |
| **Impact** | High |
| **Confidence** | High |
| **Evidence** | `features/interactions/metric-modal/events.js:116` sets `document.body.style.overflow = "hidden"` on open, `:72` sets `""` on close. `features/progress/attempt-detail/modal-shell.js:70` sets `"hidden"` on mount, `:54` sets `""` on close. |
| **Why it's a problem** | If a user opens a metric modal (clicks a score tile), then opens an attempt detail modal, both set `overflow: hidden`. When the metric modal closes, it resets to `""`, re-enabling scroll while the detail modal is still open. The user can then scroll behind the detail modal overlay. |
| **Recommended canonical source** | Create a tiny `body-scroll-lock.js` utility with `lock()` / `unlock()` using a reference counter. |
| **Minimal fix plan** | 1. Create `helpers/body-scroll-lock.js`: `let count = 0; export function lock() { count++; document.body.style.overflow = "hidden"; } export function unlock() { count = Math.max(0, count - 1); if (!count) document.body.style.overflow = ""; }` 2. Replace direct `document.body.style.overflow` writes in both modal files with `lock()`/`unlock()`. |
| **Risk & rollback** | Very low. The utility is 6 lines. Rollback: delete file, revert 2 call sites. |

### B.4 — Fighting Code: 3 capture-phase document click handlers

| Field | Detail |
|-------|--------|
| **Category** | Fighting code / Double-init |
| **Impact** | Medium |
| **Confidence** | Medium |
| **Evidence** | `my-words/panel-events.js:122` — `document.addEventListener("click", ..., true)` for wiggle close. `interactions/metric-modal/events.js:191` — `document.addEventListener("click", onDocClick, true)` for score tiles. `interactions/ph-hover/chip-events.js:43-67` — `root.addEventListener("click", ..., { capture: true })` with `stopPropagation()`. |
| **Why it's a problem** | The chip-events handler calls `e.stopPropagation()` (line 54), which prevents the metric-modal handler from seeing clicks on score tiles that are inside or near phoneme chips. This can cause "dead zones" where clicking a score tile does nothing because the phoneme chip handler swallowed the event. |
| **Recommended canonical source** | The chip-events handler should NOT call `stopPropagation()` unless the click actually matched a phoneme chip. Currently it does guard (`if (!chip) return`) before `stopPropagation`, but the guard and stop are in the same block — worth verifying the guard fires first. |
| **Minimal fix plan** | Audit the guard logic in `chip-events.js:47-54`. If the chip guard (`if (!chip) return`) runs before `stopPropagation`, no code change needed — just add a comment documenting the interaction. If not, move `stopPropagation` after the guard. |
| **Risk & rollback** | Very low. |

### B.5 — Fighting Code: `window.luxTTS` dual-init on convo page

| Field | Detail |
|-------|--------|
| **Category** | Fighting code / Double-init |
| **Impact** | Medium |
| **Confidence** | Medium |
| **Evidence** | `convo-tts-context.js:94`: `window.luxTTS = Object.assign(window.luxTTS \|\| {}, { sourceMode: "ai", autoVoice: true })`. `tts/player-ui.js:103`: `window.luxTTS = Object.assign(window.luxTTS \|\| {}, { audioEl, voiceSel, ... })`. |
| **Why it's a problem** | Both use `Object.assign` with `window.luxTTS \|\| {}`, which merges rather than overwrites. This is currently SAFE because they write different keys. However, both write `sourceMode` and `autoVoice` — `convo-tts-context.js` guards with `window.luxTTS?.sourceMode \|\| "ai"` (preserves existing), while `player-ui.js` writes `sourceMode` via a `change` listener. The boot-time race is benign NOW but fragile. |
| **Recommended canonical source** | `tts/player-ui.js` should own the runtime properties; `convo-tts-context.js` should only set defaults if not already present (which it mostly does). |
| **Minimal fix plan** | No code change needed yet — add a comment block in both files documenting the merge contract. If symptoms appear, centralize `window.luxTTS` initialization into a single `tts-state.js` module. |
| **Risk & rollback** | N/A (documentation only). |

### B.6 — Duplicate: Postgres pool singleton (API, 6 copies)

| Field | Detail |
|-------|--------|
| **Category** | Duplicate |
| **Impact** | High |
| **Confidence** | High |
| **Evidence** | Identical 12-line block in: `routes/attempt.js:7-19`, `routes/admin-recent.js:5-18`, `routes/convo-report.js:8-20`, `routes/update-attempt.js:6-18`, `routes/user-recent.js:8-20`, `routes/migrate.js:4-16`. All write to `globalThis.__lux_pool`. |
| **Why it's a problem** | If any copy drifts (e.g., one adds a new env var fallback, another doesn't), the pool created first "wins" via the `globalThis` cache, and the different config in the other file silently never applies. Maintenance burden: changing SSL config requires editing 6 files. |
| **Recommended canonical source** | New file: `lib/pool.js`. |
| **Minimal fix plan** | 1. Create `lib/pool.js` with the pool init block + export. 2. In each of the 6 route files, replace the block with `import { pool } from '../lib/pool.js'`. |
| **Risk & rollback** | Very low: behavior is identical. The `globalThis` cache already means only one Pool is created. Rollback: restore the inline blocks. |

### B.7 — Duplicate: `admin/admin-label-user.js` (dead copy)

| Field | Detail |
|-------|--------|
| **Category** | Duplicate |
| **Impact** | Medium |
| **Confidence** | High |
| **Evidence** | `admin/admin-label-user.js` (77 lines) is byte-for-byte identical to `routes/admin-label-user.js` (78 lines, has one extra comment line). The router (`api/router.js:17`) imports from `routes/admin-label-user.js`. The `admin/` copy is never imported. |
| **Why it's a problem** | A developer might edit the `admin/` copy thinking it's the live one. Changes there would have no effect, wasting time and causing confusion. |
| **Recommended canonical source** | `routes/admin-label-user.js` (it's the one the router uses). |
| **Minimal fix plan** | Delete `admin/admin-label-user.js`. |
| **Risk & rollback** | Zero risk: file is unreachable. Rollback: `git checkout -- admin/admin-label-user.js`. |

### B.8 — Duplicate: `numOrNull` / `safeNum` (API)

| Field | Detail |
|-------|--------|
| **Category** | Duplicate |
| **Impact** | Medium |
| **Confidence** | High |
| **Evidence** | `routes/attempt.js:42-45`: `function numOrNull(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }`. `routes/pronunciation-gpt/scoring.js:4-7`: `export function safeNum(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }`. Identical logic, different names. |
| **Why it's a problem** | Two names for the same thing. If one gets a bug fix (e.g., handling `NaN` strings differently), the other won't. |
| **Recommended canonical source** | `routes/pronunciation-gpt/scoring.js:safeNum` (already exported, used by more modules). |
| **Minimal fix plan** | In `routes/attempt.js`: `import { safeNum } from './pronunciation-gpt/scoring.js'` and alias or replace `numOrNull` calls with `safeNum`. |
| **Risk & rollback** | Very low. Same logic. Rollback: restore local function. |

### B.9 — Duplicate: `normToken()` (API, 2 copies + 2 inconsistent variants)

| Field | Detail |
|-------|--------|
| **Category** | Duplicate |
| **Impact** | Medium |
| **Confidence** | High |
| **Evidence** | `api/router.js:38-42` and `routes/tts.js:33-36` have identical `normToken()` with quote-stripping regex. `routes/pronunciation-gpt.js:46-47` and `routes/update-attempt.js:30-31` just do `.trim()` without quote-stripping. |
| **Why it's a problem** | If a token is sent with surrounding quotes (which happens when copied from a JSON config), `pronunciation-gpt` and `update-attempt` will reject it while `router` and `tts` will accept it. Inconsistent auth behavior. |
| **Recommended canonical source** | `api/router.js:normToken` — it's already used by the router's `isAdminRequest()`. |
| **Minimal fix plan** | Export `normToken` from `api/router.js`. Import in `routes/tts.js` (delete local copy). For `pronunciation-gpt.js` and `update-attempt.js`, note that the router already gates these routes (`ADMIN_ONLY` set), so the route-level checks are redundant. Add `// Router already validates admin token` comments. |
| **Risk & rollback** | Low. Router-level check means route-level re-check is belt-and-suspenders anyway. |

### B.10 — Duplicate: CORS `cors(res)` function (API, 3 copies) overriding router CORS

| Field | Detail |
|-------|--------|
| **Category** | Fighting code / Duplicate |
| **Impact** | High |
| **Confidence** | High |
| **Evidence** | `routes/assess.js:13-18`, `routes/convo-turn.js:8-12`, `routes/convo-report.js:22-26` each define `cors(res)` setting `Access-Control-Allow-Origin: "*"`. The router (`api/router.js:221-233`) already sets CORS with origin checking (localhost + Vercel preview + allowlist). |
| **Why it's a problem** | The route-level `cors()` runs AFTER the router's CORS headers, **overwriting** the origin-checked value with `"*"`. This means `assess`, `convo-turn`, and `convo-report` are effectively open to any origin, bypassing the router's security. This is a security issue, not just a duplicate. |
| **Recommended canonical source** | `api/router.js` CORS handling. |
| **Minimal fix plan** | Delete the `cors(res)` function and its call in all 3 route files. The router already sets CORS headers before dispatching to routes. |
| **Risk & rollback** | Medium-low: verify that all callers come through the router (they do, per `vercel.json` rewrite). Rollback: restore `cors()` functions. |

### B.11 — Duplicate: `clampInt` / `clamp` / `clampNumber` (API, 3+ variants)

| Field | Detail |
|-------|--------|
| **Category** | Duplicate |
| **Impact** | Low |
| **Confidence** | High |
| **Evidence** | `routes/admin-recent.js:33-37`: `clampInt(v, min, max, fallback)`. `routes/admin-user-stats.js:35`: `clamp(n, lo, hi)` (1-liner). `routes/realtime-webrtc-session.js:13-23`: `clampNumber()` + `clampInt()`. `features/features/selfpb/core.js:11` (frontend): `clamp = (n, a, b) => ...`. |
| **Why it's a problem** | Not actively harmful (all are local), but 4 implementations of the same 1-liner across the API creates maintenance noise. |
| **Recommended canonical source** | Pick one (e.g., in a future `lib/math.js`) or leave as-is given each is <4 lines. |
| **Minimal fix plan** | Low priority. If extracting pool to `lib/pool.js`, consider adding `clampInt` there too. |
| **Risk & rollback** | N/A. |

### B.12 — Double-init guard: `convo-bootstrap.js` uses BOTH MutationObserver AND setInterval

| Field | Detail |
|-------|--------|
| **Category** | Double-init |
| **Impact** | Low |
| **Confidence** | High |
| **Evidence** | `features/convo/convo-bootstrap.js:167-175` creates a MutationObserver on `root` for `data-scenario-idx`. Lines 177-185 also create a `setInterval(..., 300)` that does the exact same check. Comment on line 176: "Lightweight poll (MutationObserver won't catch state.scenarioIdx changes)". |
| **Why it's a problem** | The MutationObserver watches for attribute changes but `state.scenarioIdx` is a plain JS property, not a DOM attribute. So the MutationObserver never fires, and only the setInterval works. The MutationObserver is dead code that creates a false sense of coverage. The setInterval runs forever (never cleared), consuming CPU. |
| **Recommended canonical source** | Keep the setInterval (it works), remove the MutationObserver (it doesn't). |
| **Minimal fix plan** | Delete lines 167-175 (the MutationObserver block). |
| **Risk & rollback** | Zero risk: the observer never fires. Rollback: restore lines. |

### B.13 — Hardcoded credentials in `admin-user-stats.js`

| Field | Detail |
|-------|--------|
| **Category** | Duplicate / Encoding (config drift) |
| **Impact** | High (security) |
| **Confidence** | High |
| **Evidence** | `routes/admin-user-stats.js:5-18` has hardcoded Supabase URL, JWT service role key, and admin token `'sIMONCAT4!'` as fallback defaults. Every other route reads from `process.env` only. |
| **Why it's a problem** | Credentials in source code. Also: this file creates its own Supabase client via `getSupabaseClient()` with its own URL/key resolution, while all other files use `getSupabaseAdmin()` from `lib/supabase.js` directly. Config drift: if env vars are updated, the hardcoded fallbacks mask the change. |
| **Recommended canonical source** | `lib/supabase.js:getSupabaseAdmin()` (no hardcoded fallbacks). |
| **Minimal fix plan** | 1. Remove hardcoded credential fallbacks (lines 5-18). 2. Replace `getSupabaseClient()` with direct `getSupabaseAdmin()` call. 3. Let the route fail clearly if env vars are missing (better than silently using stale credentials). |
| **Risk & rollback** | Medium: if deployed without env vars set, the route will error instead of falling back. This is the correct behavior. Rollback: restore fallbacks. |

---

## C) Pairs to Reconcile

### C.1 — `convo-turn.js` vs `app-core/runtime.js` (Recording state)

| | Candidate #1 | Candidate #2 |
|---|---|---|
| **File** | `app-core/runtime.js` | `features/convo/convo-turn.js:37-51` |
| **What it does** | `setLastRecording(blob, meta)` — sets private var + window global + dispatches event | Direct `window.LuxLastRecordingBlob = ...` + manual event dispatch |
| **Canonical?** | **YES** — designed as single source of truth (file header comment) | No — bypasses the canonical API |
| **Action** | Keep | Refactor to call `setLastRecording()` from runtime.js |

### C.2 — `publishKaraoke()` vs direct `window.LuxKaraokeSource` writes

| | Candidate #1 | Candidate #2 |
|---|---|---|
| **File** | `tts/player-ui/karaoke.js:publishKaraoke()` | `selfpb/controls.js:17-28`, `selfpb/karaoke.js:220-233` |
| **What it does** | Sets globals + dispatches `lux:karaokeRefresh` event | Direct global writes + separate event dispatch |
| **Canonical?** | **YES** — already exported, dispatches the standardized event | No — reimplements the same logic |
| **Action** | Keep | Import and call `publishKaraoke()` |

### C.3 — Router CORS vs route-level `cors()` (API)

| | Candidate #1 | Candidate #2 |
|---|---|---|
| **File** | `api/router.js:202-233` | `routes/assess.js:13-18`, `routes/convo-turn.js:8-12`, `routes/convo-report.js:22-26` |
| **What it does** | Origin-checked CORS with allowlist | Wildcard `Access-Control-Allow-Origin: *` |
| **Canonical?** | **YES** — the router runs before routes, sets safe headers | No — overwrites with less secure wildcard |
| **Action** | Keep | Delete route-level `cors()` functions |

### C.4 — Pool singleton (API, 6 copies)

| | Candidate #1 | Candidate #2 |
|---|---|---|
| **File** | New `lib/pool.js` (to be created) | 6x inline blocks in route files |
| **What it does** | Single pool initialization | Same init copy-pasted |
| **Canonical?** | **YES** (after extraction) | No |
| **Action** | Create `lib/pool.js` | Replace with import |

### C.5 — `admin/admin-label-user.js` vs `routes/admin-label-user.js`

| | Candidate #1 | Candidate #2 |
|---|---|---|
| **File** | `routes/admin-label-user.js` | `admin/admin-label-user.js` |
| **What it does** | Admin endpoint for user labeling | Identical copy |
| **Canonical?** | **YES** — imported by `api/router.js:17` | No — dead code, never imported |
| **Action** | Keep | Delete |

### C.6 — `numOrNull()` vs `safeNum()`

| | Candidate #1 | Candidate #2 |
|---|---|---|
| **File** | `routes/pronunciation-gpt/scoring.js:4-7` | `routes/attempt.js:42-45` |
| **What it does** | `safeNum(v)` — Number.isFinite guard | `numOrNull(v)` — identical logic |
| **Canonical?** | **YES** — already exported, used by multiple modules | No — local private function |
| **Action** | Keep | Import `safeNum` from scoring.js |

### C.7 — Metric modal vs Attempt detail modal (body overflow lock)

| | Candidate #1 | Candidate #2 |
|---|---|---|
| **File** | `features/interactions/metric-modal/events.js` | `features/progress/attempt-detail/modal-shell.js` |
| **What it does** | `document.body.style.overflow = "hidden"/""`  | Same |
| **Canonical?** | Neither — both are ad-hoc | Neither |
| **Action** | Extract shared `helpers/body-scroll-lock.js` with refcount | Both import from shared utility |

---

## D) Quick Verification Checklist

### Fix #1: `convo-turn.js` → use `setLastRecording()`

- [ ] Open AI Conversations page (`convo.html`)
- [ ] Record a turn (speak into mic, wait for AI response)
- [ ] Open Self Playback drawer (bottom panel)
- [ ] Verify waveform shows and audio plays (not blank/silent)
- [ ] Console: should see ONE `lux:lastRecording` event, not two
- [ ] DOM: `#playbackAudio` should have a `blob:` src

### Fix #2: Extract `lib/pool.js` in API

- [ ] Run `npm test` — all contract tests should pass
- [ ] Deploy to Vercel preview
- [ ] Test `/api/attempt` (POST) — should return `{ ok: true, id: ... }`
- [ ] Test `/api/user-recent?uid=...` — should return `{ rows: [...] }`
- [ ] Check Vercel function logs for any "pool" errors

### Fix #3: Delete `admin/admin-label-user.js`

- [ ] Run `grep -r "admin/admin-label-user" .` — should find zero imports
- [ ] Deploy to Vercel preview
- [ ] Test `/api/admin-label-user` route — should still work (uses `routes/` copy)

### Fix #4: Body scroll lock utility

- [ ] Open Practice Skills page (`index.html`)
- [ ] Click a score tile → metric modal opens → verify no scroll behind modal
- [ ] While metric modal is open, if possible trigger attempt detail modal
- [ ] Close metric modal → verify attempt detail modal still locks scroll
- [ ] Close attempt detail modal → verify body scroll restored
- [ ] Console: no errors

### Fix #5: Remove route-level `cors()` overrides

- [ ] Deploy to Vercel preview
- [ ] From localhost dev server, call `/api/assess` — should work (localhost is in router allowlist)
- [ ] From an unknown origin, call `/api/assess` — should get CORS blocked (no more wildcard `*`)
- [ ] Network tab: verify `Access-Control-Allow-Origin` is the specific origin, not `*`

### Fix #6: Karaoke globals centralization

- [ ] Open Practice Skills page
- [ ] Record a passage → open Self Playback expanded view
- [ ] Verify karaoke words highlight in sync with audio
- [ ] Click TTS "Listen" → verify karaoke switches to TTS timings
- [ ] Click back to learner playback → verify karaoke switches back to learner timings
- [ ] Console: no `LuxKaraokeSource` flicker between "learner" and "tts"

---

## Appendix: Control Map (Window Globals Inventory)

| Global | Owner (canonical) | Writers | Readers |
|--------|------------------|---------|---------|
| `window.LuxLastRecordingBlob` | `app-core/runtime.js` | runtime.js, ~~convo-turn.js~~ | selfpb/ui.js, selfpb/core.js |
| `window.LuxLastRecordingMeta` | `app-core/runtime.js` | runtime.js, ~~convo-turn.js~~ | selfpb/ui.js |
| `window.LuxKaraokeSource` | `tts/player-ui/karaoke.js` | ~~selfpb/controls.js~~, ~~selfpb/karaoke.js~~ | selfpb/karaoke.js |
| `window.LuxKaraokeTimings` | `tts/player-ui/karaoke.js` | ~~selfpb/controls.js~~, ~~selfpb/karaoke.js~~ | selfpb/karaoke.js |
| `window.LuxTTSWordTimings` | `tts/player-ui/karaoke.js` | tts/player-ui/karaoke.js | selfpb/karaoke.js |
| `window.luxTTS` | `tts/player-ui.js` | convo-tts-context.js (defaults only) | convo-tts-context.js, selfpb/karaoke.js |
| `window.LuxSelfPB` | `selfpb/core.js` | selfpb/ui.js (extends) | selfpb/* |
| `window.LuxMyWords` | `features/my-words/index.js` | my-words/index.js | my-words/* |
| `window.LUX_USER_ID` | `api/identity.js` | identity.js | many |
| `window.LUX_DEBUG` | `app-core/state.js` | state.js | state.js |
| `window.lastAttemptId` | `app-core/runtime.js` | runtime.js | progress, results |
| `window.LuxLastAzureResult` | `features/recorder/index.js` | recorder/index.js | interactions, results |
| `window.LuxLastWordTimings` | `features/recorder/index.js` | recorder/index.js | selfpb, karaoke |
| `window.refreshDashboard` | `features/dashboard/index.js` | dashboard/index.js | main.js (boot) |
| `window.refreshConvoProgress` | `features/convo/progress.js` | progress.js | convo-turn.js |
| `window.__attachLearnerBlob` | `features/features/selfpb/ui.js` | selfpb/ui.js | convo-turn.js, recorder |

*Strikethrough (~~...~~) = should be refactored to use canonical writer*

---

## Appendix: Z-Index Stacking Order

| z-index | Element | File |
|---------|---------|------|
| 999999 | Audio inspector modal | `features/recorder/audio-inspector.js:99` |
| 200000 | Self-playback expanded float | `features/features/selfpb/styles/float.js:8` |
| 99999 | Convo report overlay | `features/convo/convo-shared.js:237` |
| 9999 | Attempt detail modal, Harvard modal | `features/progress/attempt-detail/modal-shell.js:9` |
| 1000 | Auth modal | `ui/auth-dom.js:42` |
| 950 | Toast notifications | (CSS tokens) |
| 900 | TTS drawer, SelfPB mini drawer | `features/features/selfpb/styles/mini.js:12`, `tts/boot-tts.js` |
| 20 | Sticky table headers | (CSS) |

**Potential issue:** Self-playback expanded float (200000) is higher than every modal (9999), which means it will overlay on top of open modals. This is likely intentional but worth noting.
