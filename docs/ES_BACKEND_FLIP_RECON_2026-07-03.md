# ES Backend Flip — Recon / Spec (READ-ONLY)

**Repo:** `luxury-language-api` (this backend)
**Date:** 2026-07-03
**Author of recon:** backend AI-flip recon session
**Status:** SPEC ONLY. No product code changed. This document is the only file committed by this session.
**Sibling recon (frontend):** `lux-frontend` → `docs/audits/ES_AI_SURFACE_FLIP_RECON_2026-07-03.md`

> Every claim below is cited `file:line`. Citations were independently re-read and
> adversarially verified by a parallel verification pass (14/15 claims CONFIRMED,
> 1 PARTIAL — corrected inline where noted).

---

## 0. Headline (read this first)

**The frontend already sends `pack:"es"` (and the Spanish scenario) to this backend. This backend reads `pack` in ZERO places.** A whole-word search for `pack` across all `.js/.cjs/.mjs` source returns **no matches**. The Spanish scenario object rides in on the request body and is rendered faithfully, but every *instruction* the models receive is hardcoded English, so the NPC, narration, coaching, and grading all come back in English.

**For `/api/convo-turn` (the visible fix):**

- English is pinned inside the **assembled system prompt string**, in three spots:
  - **`routes/convo-turn.js:430`** — prompt opens: *"You are a character in a realistic **American English** conversation."*
  - **`routes/convo-turn.js:464-468`** — a `LANGUAGE:` block that **actively forbids** any other language: *"You ONLY speak English. You do not understand, read, or interpret any other language — not even a little."* (If the learner writes Spanish, the NPC is told to pretend it can't understand.) **This block is the single hardest English pin — it would make an es-MX NPC refuse its own scenario.**
  - **`routes/convo-turn.js:275`** — the length-repair prompt: *"You are revising ONE assistant line from a realistic **American English** conversation."*
- `pack` is never read: the handler destructures only `hearing / scenario / knobs / messages` at **`routes/convo-turn.js:583-587`**.

**Is the convo-turn flip a prompt swap or a `pack` conditional?** → **A `pack` conditional, NOT a blind prompt swap.**
A pure text swap (hardcode Spanish) would break English mode *and* the existing contract tests, which assert byte-identical / English-default behavior when new fields are absent (`test/convo-turn.hearing.test.js:94-109,134-152`). The same endpoint must keep serving English. So the fix is: resolve a target locale from `pack` (default English when absent), thread it into `buildSystemPrompt()` and `buildLengthRepairPrompt()`, and branch the three pinned spots. There is a working precedent in-repo for exactly this shape — see §7.

Everything else (assess locale, coach) is a follow-on. Order and details below.

---

## 1. Routing map — how a request reaches each handler

Single Vercel Function pattern (README `README.md:28,57`). `vercel.json` rewrites every `/api/:route` to `/api/router?route=:route`:

```
vercel.json:2-4   { "source": "/api/:route",        "destination": "/api/router?route=:route" }
                  { "source": "/api/:route/:rest*",  "destination": "/api/router?route=:route/:rest*" }
```

Dispatch lives in `api/router.js`:

| Endpoint | ROUTES entry | Handler import | Load |
|---|---|---|---|
| `POST /api/convo-turn` | `api/router.js:158` `"convo-turn": convoTurn` | `api/router.js:24` `import convoTurn from "../routes/convo-turn.js"` | **eager** |
| `POST /api/assess` | `api/router.js:154` `assess` | `api/router.js:111` `lazyRoute(() => import("../routes/assess.js"))` | **lazy** |
| `POST /api/pronunciation-gpt` | `api/router.js:161` `"pronunciation-gpt": pronunciationGpt` | `api/router.js:113-116` `lazyRoute(() => import("../routes/pronunciation-gpt.js"))` | **lazy** |

Cross-cutting router behavior that matters for the flip:

- **Admin gate (all three are gated):** `api/router.js:253-266` `ADMIN_ONLY` set contains `pronunciation-gpt` (:255), `assess` (:257), `convo-turn` (:259); enforced at `api/router.js:268-273` (401 if no matching `x-admin-token`). **Any preview test of the flip must send `x-admin-token` = the preview's `ADMIN_TOKEN`.**
- **Body handling:** `api/router.js:171-193` `hydrateJsonBodyIfNeeded` parses **JSON** bodies into `req.body` (`:185`), but **leaves multipart streams untouched** (`:178-179` early return when content-type isn't JSON) so `assess`'s formidable can read them. `config.bodyParser=false` at `api/router.js:13`. → convo-turn and pronunciation-gpt get `req.body` as a parsed object; **assess must read `pack`/locale as a multipart field, not from `req.body`.**
- **CORS allow-list:** `api/router.js:211-227` allows `CORS_ORIGINS` env entries + localhost + a regex for `https://lux-frontend(-…)?.vercel.app` (`api/router.js:222-224`). Relevant to preview testing (§9).

---

## 2. `/api/convo-turn` — the conversation (the visible fix)

**File:** `routes/convo-turn.js` (771 lines). System prompt is assembled by `buildSystemPrompt(scenario, knobs, messages, turnCount)` at `routes/convo-turn.js:346-564`; a second prompt is assembled by `buildLengthRepairPrompt(...)` at `routes/convo-turn.js:262-302`.

### 2a. Does it read `payload.pack`? — **No.**
Handler `routes/convo-turn.js:568-772`. Body read at `:583-587`:
```js
const body = req.body || {};
const hearing = body.hearing || null;   // :584
scenario = body.scenario;               // :585
const knobs = body.knobs;               // :586
const messages = body.messages;         // :587
```
No `pack`, `locale`, or `lang` is read anywhere in the file (verified: the only textual "pack" is the word "package" inside a prompt string; all "language" hits are prompt prose, never a body field).

### 2b. Where English is pinned (what must change)
Scenario content itself is **not** the problem — `scenario.title/desc/more/scenarioHidden/otherRole.npc/...` are interpolated verbatim (`routes/convo-turn.js:432-441`), so the Spanish scenario text already flows through. The **instructions** are English:

| Spot | `file:line` | What it does |
|---|---|---|
| Opening framing | `routes/convo-turn.js:430` | "realistic **American English** conversation" |
| **LANGUAGE block** | `routes/convo-turn.js:464-468` | **Forbids non-English; NPC must feign incomprehension of Spanish** ← the critical pin |
| Length-repair framing | `routes/convo-turn.js:275` | "revising ONE assistant line from a realistic **American English** conversation" |
| Narration language rule | `routes/convo-turn.js:400` | "NARRATION LANGUAGE LEVEL … never simpler than B1" — English-implicit; narration inherits prompt language |
| Output contract | `routes/convo-turn.js:562` | JSON keys are structural (`assistant/narration/imageDirection/phase/suggested_replies`) — keep as-is; only the *values'* language changes |

Narration and suggested replies are produced by the **same** model call under the same system prompt (`routes/convo-turn.js:658-663`), so once the system prompt instructs es-MX, narration and `suggested_replies` follow automatically — no separate wiring.

### 2c. Exactly what must change — and what shape
**Shape: `pack` conditional (default English), threaded into both prompt builders.** Minimal change:

1. In the handler, resolve a locale near `:583-587`:
   `const pack = body.pack; const targetLang = pack === "es" ? "es-MX" : "en-US";`
   (Prefer reading the actual contract field `pack`. Optionally also honor a per-scenario `scenario.lang` as an override — see the recommendation in §7 and the naming caveat.)
2. Pass `targetLang` into `buildSystemPrompt(scenario, knobs, trimmed, turnCount, targetLang)` (`routes/convo-turn.js:632`) and into `maybeRepairAssistantLength(...)` → `buildLengthRepairPrompt(...)` (`routes/convo-turn.js:698-705`, builder at `:262`).
3. Inside the builders, branch the three pinned spots:
   - `:430` / `:275` → language-neutral or es-MX framing ("realistic conversation in Mexican Spanish (es-MX)").
   - **`:464-468` → replace the "you only speak English" block** with an es-MX equivalent: the NPC speaks Mexican Spanish; add a "respond in Spanish; narration and suggested replies in Spanish" directive. (Optionally keep a symmetric "if the learner writes English, gently steer back to Spanish" if that's the pedagogy — confirm with product.)
4. Default path (`pack` absent / `!== "es"`) must reproduce today's English prompt **byte-for-byte** so the contract tests (`test/convo-turn.hearing.test.js`, `test/convo-turn.omission.test.js`) stay green.

**Verdict on the framing question:** it is **not** a per-scenario language field that's strictly required, and it is **not** a safe blind prompt swap — it is a **`pack`-driven conditional** that selects the language directive. (A `scenario.lang` field is a nice optional belt-and-suspenders, but the frontend already commits to `pack`, so `pack` is the contract to honor.)

### 2d. Secondary English-leak surface in convo-turn — `lib/hearing.js` (the "Ear")
convo-turn injects a private "hearing" stage direction into the model's `postHistory` **only when `body.hearing` is present** (`routes/convo-turn.js:654-656`; gated, absent-by-default — the "Swing 1" pattern). That directive is assembled in `lib/hearing.js` and is **saturated with hardcoded English** — dozens of English seed phrases and stage directions, e.g.:
- Injected header label `lib/hearing.js:218` `"HEARING (private stage direction — never mention this):"`.
- English few-shot seed utterances surfaced as "Style hint" lines, e.g. `lib/hearing.js:19,34,49,64,79` and the CHECK/ECHO/MISHEAR/AMEND seeds `:107,119,131,144,155,168,175,186`.
- English scaffolding directives `:225-227,233-236,247-259,266-268,272-273,281-283,288-291,297`.
- English-phonology-specific exemplars that don't transfer to Spanish: V/B and spelling read-backs `:131` (`"Is that T-A-O, or with an H?"`, `"Vero — V or B on the cup?"`), nonfat/two-percent `:234`.
- Hardcodes the literal word **"English"** at `lib/hearing.js:327` (M3 intent: *"never reference their English unprompted"*) — must become Spanish.

**Implication:** the *visible* convo-turn fix (§2a-c) is the system-prompt language. The hearing block is a **deeper, separate English leak** that only activates for the Ear-wired frontend. Scope it as a follow-on within the convo-turn flip (or explicitly defer), and note it needs full es-MX re-authoring, not a one-line branch.

---

## 3. `/api/pronunciation-gpt` — the coach

**Entry:** `routes/pronunciation-gpt.js:35-109` → hands `req.body` to `runPronunciationCoach(...)` (`:73-101`). Core flow in `routes/pronunciation-gpt/runCoach.js`.

### 3a. Does it read `pack`? — **No.** Does it read `firstLang`? — **Yes.**
`routes/pronunciation-gpt/runCoach.js:35-48` destructures the body into `referenceText / azureResult / firstLang / mode / chunk / persona / uid / attemptId / tipIndex / tipCount / includeHistory`. **No `pack`** (whole-file grep confirms). `firstLang` is read at `:38` and used at `:57`.

### 3b. What `firstLang` actually controls (subtle — it's NOT the coached language)
`firstLang → langCode` at `runCoach.js:57-58`; `langs` map at `runCoach.js:51-55` (`es:"Spanish", fr:"French", …`). `langCode` is the **learner's L1 (native) language**, used to pick the **translation target** for the coaching feedback — it does **not** set the language being coached. It is consumed in two places (correction to an earlier claim — it is *not* used "only" for translation):
- injected into the coach model's user prompt (`runCoach.js:103` `langCode,`), and
- passed to `translateMissing(..., langCode)` (`runCoach.js:139`) which translates the English feedback into the L1.

### 3c. What pins English (the coached language)
The coach is built end-to-end to coach **English pronunciation**:
- **Persona:** `routes/pronunciation-gpt/personas.js:6` — "warm, supportive **American English** tutor" (drill `:10` and linguist `:14` are the same English-pronunciation frame).
- **English phoneme model:** `routes/pronunciation-gpt/runCoach.js:50` `universallyHard = new Set(["θ","ð","ɹ"])` — English "th" + English rhotic; used at `:102`.
- **English section titles + EN word budgets:** `routes/pronunciation-gpt/prompt.js:16-22` (Quick Coaching, Phoneme Profile, …) and `prompt.js:72` `"${s.min}-${s.max} EN words"`; simple-mode cap `prompt.js:49` "Stay under ~75 words". Spanish runs ~15-20% longer → recalibrate.
- **English exemplars in-prompt:** `prompt.js:53,88` `"Nice work (82% · B2) …"`.
- **Output schema couples content to an `en` field:** `prompt.js:90` `{ "sections":[{"title","titleL1","en","l1"}] }`; `translate.js:10` literally says *"Translate these **English** strings"* and `translate.js:18` reads `.en` as the English **source**. After a flip the model would write Spanish into a field named `en`, breaking the source-language assumption in `translate.js`.

### 3d. What must change
- Add `pack`/locale to the destructure (`runCoach.js:35-48`) and thread it through.
- Re-author personas (`personas.js`) and both prompt modes (`prompt.js`) for es-MX; add an explicit "write coaching in Spanish" directive (today there is none — output language is implied by the English prompt).
- Replace/extend `universallyHard` (`runCoach.js:50`) with Spanish-relevant difficulty (or drive it from the assessed phonemes).
- Reconcile the `.en`-as-English-source coupling (`prompt.js:90`, `translate.js:10,18`) and the `firstLang`/L1 semantics (a Spanish learner of Spanish makes L1 translation less meaningful).
- **Dependency:** the coach's phoneme input comes from `/api/assess` (or `/api/evaluate`). Until those grade es-MX (§4), the coach receives English-phoneme scores, so §4 should land with or before the coach flip.

---

## 4. `/api/assess` — grading (Azure)

**File:** `routes/assess.js` (137 lines). Multipart in (formidable), Azure Pronunciation Assessment out.

### 4a. Where the Azure call is made and what locale it passes
- **Params** built at `routes/assess.js:77-86`; locale hardcoded at **`routes/assess.js:84`** `Language: "en-US"`.
- **REST call** at `routes/assess.js:92-101` to the endpoint built at **`routes/assess.js:90`**, which **also** hardcodes `?language=en-US&format=detailed`. Only `${region}` is dynamic. **Both `:84` and `:90` must change together.**
- Grading knobs (keep): `GradingSystem:"HundredMark"`, `Granularity:"Phoneme"`, `NBestPhonemeCount:3`, `Dimension:"Comprehensive"`, `EnableMiscue:true` (`:79-84`).

### 4b. Where reference text + phoneme alphabet come from
- **Reference text:** multipart field `text` → `referenceText` at `routes/assess.js:49-50`. (Frontend supplies the Spanish sentence as `text`; no change needed to *source* it.)
- **Phoneme alphabet:** Azure derives it from the assessment `Language`. Switch `Language` to `es-MX` and Azure returns Spanish phonemes automatically — **proven in-repo** by `routes/test-es-mx-phonemes.cjs:13` (`speechRecognitionLanguage = "es-MX"`, reference *"El perro del niño corre hacia la caja roja"*). That standalone mic test exists precisely to confirm es-MX phoneme assessment works.

### 4c. Does assess read `pack`/locale today? — **No. Frontend must start sending it.**
The handler reads **only** multipart field `text` (`:49`) and file `audio` (`:52`). It reads **no** `firstLang`, `pack`, or `locale` — the task's stated `{ audio, text, firstLang }` contract is aspirational; even `firstLang` isn't read here today. So:
- **Frontend change required (cross-ref the frontend recon):** the `es-content-resume` frontend must add a `pack` (or `locale`) **multipart field** to its `/api/assess` POST.
- **Backend change:** read it (`fields?.pack` / `fields?.locale`, mirroring `text` at `:49`), map `es → es-MX`, and substitute at `:84` and `:90`. Default `en-US` when absent (keeps `test/assess.contract.test.js` green — that test sends no locale field).

### 4d. Parallel pathway — `/api/evaluate` has the SAME pin
`routes/evaluate.js:31` `speechConfig.speechRecognitionLanguage = "en-US"` is the equivalent hardcode in the alternate assessment route. If the frontend uses `evaluate` for any Spanish flow, apply the identical locale change there. (Confirm frontend usage before touching.)

---

## 5. Shared prompt / LLM / Azure helpers

There is **no single shared prompt-builder** to fix in one place — each endpoint assembles its own prompt inline. Shared modules:

| Module | Role | Language relevance |
|---|---|---|
| `lib/hearing.js` | Renders the convo-turn hearing directive | **Heavily English-pinned** (see §2d). Shared only by convo-turn. |
| `lib/voice.js` | ElevenLabs clone + TTS (Voice Mirror) | Uses `eleven_multilingual_v2` (`lib/voice.js:73`) — already multilingual; no locale pin. |
| `lib/pool.js`, `lib/supabase.js` | Postgres / Supabase | Language-agnostic. |
| `routes/tts/ssml.js` | SSML string helpers for Azure TTS | `baseSpeakTag` hardcodes `xml:lang="en-US"` on both `<speak>` and `<voice>` (`routes/tts/ssml.js:42-44`). |

**Consequence:** the flip lands **per endpoint**, not in one shared helper. The nearest thing to a reusable primitive is a small `pack → locale` mapper you could add once and import into convo-turn / assess / evaluate / coach.

---

## 6. Existing Spanish / `es` / `pack` / `locale` handling already present

Deliberately searched for prior partial work so the flip builds on it:

- **`pack`:** **appears in zero source files.** Fully ignored by the backend today.
- **`routes/word-info.js` — the one working precedent.** `word-info.js:59` `const lang = (body.lang || "en").toString().trim() === "es" ? "es" : "en";` and `word-info.js:122` `const targetLangName = lang === "es" ? "Spanish" : "English";` — the **only** Spanish/English conditional in the codebase, and the exact pattern to mirror. **Caveat:** it reads **`lang`**, not `pack`. There is a naming mismatch between endpoints — the convo/coach/assess contract sends `pack`, word-info uses `lang`. Recommend the flip read the real contract field (`pack`) and internally normalize `pack==="es" → "es-MX"`; optionally accept `lang`/`locale` as aliases for consistency.
- **`routes/test-es-mx-phonemes.cjs`** — standalone, non-served `.cjs` mic test proving Azure es-MX phoneme assessment (`:13`). This was the entire backend contribution of the "Spanish pack foundation" commit (`122e758`); the 23 scenarios / i18n inventory / style guide from that commit live in **lux-frontend**, not here — confirming the backend is scenario-agnostic and receives scenarios in the request body.
- **`routes/pronunciation-gpt/runCoach.js:51-55`** — `langs` map includes `es:"Spanish"`, but as an **L1 translation-target** lookup, not a coached-language switch (see §3b).
- **`.GOLD` files** (`routes/*.js.GOLD`, `admin/*.GOLD`) are **pre-refactor backups**, unrelated to Spanish (e.g. `convo-turn.js.GOLD` predates ~650 lines of later work). Ignore for the flip.

---

## 7. Recommended mechanism (answering "swap vs conditional vs field")

**Use a `pack` conditional, mirroring `word-info.js:59`, defaulting to English (the "absent-by-default" pattern the hearing feature already established).**

- **Not a prompt swap:** the backend must keep serving English; a blind swap breaks English mode + contract tests.
- **`pack` conditional (recommended):** matches the actual frontend contract; smallest change; one `pack → locale` map reused across endpoints. Default `en-US`.
- **Per-scenario `lang` field (optional upgrade):** the scenario object could carry its own `lang`/`locale`; cleaner for a future multi-language world. Nice-to-have, but the frontend already commits to `pack`, so lead with `pack` and treat `scenario.lang` as an optional override.

Concretely: add `resolveLocale(pack)` → `"es-MX" | "en-US"`, thread the locale into each endpoint's prompt/Azure-param assembly, and branch only the pinned lines cited in §2-§4.

---

## 8. Deploy model (safe-testing context)

- **Platform:** Vercel serverless, single-function router (`README.md:28,57`). `vercel.json` contains **only rewrites** — no `buildCommand`, no cron, no per-route function config. No `.vercel/project.json` is committed (project linkage lives in the Vercel dashboard, not the repo). There is **no committed CI workflow** (`.github/` absent).
- **Auto-deploy:** With standard Vercel Git integration (strongly implied by the single-function router + dashboard-managed env at `README.md:99`), **pushing `main` deploys production**, and **every branch/PR gets its own preview URL**. This is the Vercel default; it is **not pinned in any committed file**, so confirm in the Vercel dashboard before relying on it. → The recon branch `claude/backend-ai-flip-recon-lytf8a` will produce a **backend preview deployment** distinct from prod.
- **Env:** all secrets are Vercel Project → Settings → Environment Variables (`README.md:99-113`); `.env.example` enumerates them. A preview needs `ADMIN_TOKEN`, `OPENAI_API_KEY`, `AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION` set for the flip to run.

---

## 9. How the frontend reaches this backend (plan the branch test WITHOUT touching prod)

- **Wiring:** the frontend proxies `/api/*` to this backend (`README.md:121`). The frontend's actual API-origin env var lives in the **lux-frontend** repo (not here) — cross-ref the frontend recon for its name/value.
- **CORS already supports previews:** `api/router.js:222-224` allows any `https://lux-frontend(-<preview>)?.vercel.app` origin, plus `CORS_ORIGINS` env + localhost (`api/router.js:211-227`). So a **frontend preview can legally call a backend preview.**
- **Safe test recipe (no prod impact):**
  1. Push the flip to `claude/backend-ai-flip-recon-lytf8a` → get the **backend preview URL**.
  2. Point the **`es-content-resume` frontend preview**'s API origin at that backend preview URL.
  3. Ensure the backend preview has `ADMIN_TOKEN` (+ OpenAI/Azure keys); the frontend must send `x-admin-token` (all three endpoints are `ADMIN_ONLY`, `api/router.js:253-266`).
  4. Exercise `?pack=es`; confirm convo-turn returns Spanish NPC/narration/replies, then assess grades es-MX, then coach.
- **Local option:** run backend via Vercel CLI and hit `/api/router?route=…` directly (the contract tests in `test/` show the exact request shapes).

---

## 10. Full file-touch list for the flip (one line each)

**Core three endpoints (the contract the frontend sends):**
- `routes/convo-turn.js` — read `body.pack` near `:583-587`; thread locale into `buildSystemPrompt` (`:346/632`) + `buildLengthRepairPrompt` (`:262/698`); branch `:430`, `:275`, and **rewrite the LANGUAGE block `:464-468`** for es-MX; default English when `pack` absent.
- `routes/assess.js` — read `fields.pack`/`fields.locale` (mirror `text` at `:49`); map `es→es-MX`; substitute at `:84` (`Language`) and `:90` (endpoint `language=`); default `en-US`.
- `routes/pronunciation-gpt/runCoach.js` — add `pack`/locale to destructure `:35-48`; thread through; revisit `universallyHard` `:50` and `firstLang`/`langCode` semantics `:57-58`.
- `routes/pronunciation-gpt/personas.js` — re-author personas (`:6/:10/:14`) for es-MX coaching.
- `routes/pronunciation-gpt/prompt.js` — es-MX section titles `:16-22`, recalibrate/relabel "EN words" `:72` and caps `:49`, add explicit "write in Spanish" directive, reconcile `.en` schema key `:90`.
- `routes/pronunciation-gpt/translate.js` — fix "Translate these English strings" `:10` and `.en`-as-source `:18` once coach content is Spanish.

**Convo-turn deep surface (only when frontend sends `hearing`):**
- `lib/hearing.js` — es-MX re-authoring of all seed phrases + stage directions (§2d); at minimum the injected label `:218` and the hardcoded word "English" `:327`.

**Parallel assessment pathway (only if frontend uses it):**
- `routes/evaluate.js` — `es-MX` at `:31` (same shape as assess).

**Adjacent surfaces for a fully-Spanish experience (scope explicitly):**
- `routes/convo-report.js` — post-session report persona `:72` ("American English pronunciation coach") + Spanish output.
- `routes/alt-meaning.js` — "English words"/ARPAbet/English fallbacks `:61,65,78,129,130`.
- `routes/tts/ssml.js` — `xml:lang="en-US"` `:42-44` should track the chosen voice's locale.
- `routes/tts.js` — **no code change needed**: `voice` is client-supplied (`:78`) and passed through, so es-MX voices (e.g. `es-MX-DaliaNeural`) are reachable by sending a Spanish voice ID; the voices list `:61` is unfiltered.

**Needs a frontend change too (cross-ref lux-frontend recon):**
- `/api/assess` (and `/api/evaluate` if used) — frontend must add a `pack`/`locale` **multipart field**; it sends none today.

**No change (language-neutral):**
- `routes/convo-image.js` — English image-gen prompts, but IMAGE RULES forbid readable text/UI (`:193,198`), so output is language-neutral; Spanish `transcript` flows as data (`:171`).
- `routes/realtime-webrtc-session.js` — no language/locale/pack pin found.
- `lib/voice.js` — already `eleven_multilingual_v2`.

**Optional shared primitive:**
- new `lib/locale.js` (or inline) — one `pack → locale` mapper imported by convo-turn / assess / evaluate / coach, so the `es→es-MX` mapping lives in one place.

---

## 11. Proposed implementation order (smallest testable increments)

1. **convo-turn (the visible fix, ship first).** Add `pack`→locale; branch `:430/:275/:464-468`; default English. **Test:** `npm test` stays green (English-default preserved); a manual `pack:"es"` request returns Spanish NPC turn + Spanish narration + Spanish suggested replies. Highest visible payoff, lowest blast radius.
2. **assess locale (grading).** Frontend adds `pack` multipart field; backend reads it and swaps `:84/:90` to `es-MX` (+ `evaluate.js:31` if used). **Test:** post the es-MX reference sentence from `test-es-mx-phonemes.cjs`; confirm Spanish phonemes come back. Do assess before the coach — the coach consumes assess's phonemes.
3. **coach (deepest).** Add `pack`/locale; re-author personas + `prompt.js`; fix `universallyHard`; reconcile `.en`/`translate.js` source-language assumption. **Test:** feed es-MX assess output; confirm Spanish coaching sections + correct L1 handling.
4. **Adjacent / polish (optional, scope explicitly):** `lib/hearing.js` es-MX (if the Ear is active for Spanish), `convo-report.js`, `alt-meaning.js`, `tts/ssml.js` `xml:lang`.

---

## Appendix — verification note

Citations were re-read by an independent parallel pass. Result: **14/15 CONFIRMED exactly; 1 PARTIAL** — the coach `universallyHard`/`langCode` claim: corrected here to (a) `langs` map spans `runCoach.js:51-55` (not 51-58), and (b) `langCode` is used in **two** places (`runCoach.js:103` prompt injection and `:139` translation), not "only" translation — the "not the coached language" substance holds. A completeness sweep of the remaining routes produced the broader-surface findings folded into §2d, §3c, §4d, and §10.
