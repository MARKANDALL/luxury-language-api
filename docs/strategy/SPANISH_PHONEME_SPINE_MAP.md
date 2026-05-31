# Spanish Phoneme Spine Map

Read-only investigation completed 2026-05-30. Eight parallel agents traced the pronunciation scoring pipeline across both repos (luxury-language-api backend, lux-frontend at C:\dev\LUX_GEMINI). No code was edited.

---

## A. Executive Summary

Real es-MX phoneme scoring does not exist today. The backend `resolveLocale()` function correctly maps `pack=es` to the Azure locale `es-MX`, but the frontend assessment helper (`_api/assess.js`) never sends the `pack` field. Every pronunciation assessment therefore hits Azure as `en-US`, regardless of the user's language pack. Even if that one-line fix were applied, Azure returns empty Phoneme name fields for es-MX, and this remains true even with `PhonemeAlphabet: "IPA"` explicitly set. A live probe (2026-05-30) confirmed: Azure returns per-phoneme AccuracyScore, Offset, and Duration for es-MX, but every `Phoneme` name field is an empty string, and every `Syllable` label is also empty. Setting `PhonemeAlphabet: "IPA"` does not fix this. The G2P fallback layer (`g2p-spec.js`) is therefore required to derive phoneme labels from the reference text.

The coffee-word test produced garbage because the system scored Spanish audio against English expectations: English locale sent to Azure, English ARPABET codes expected in the response, English phoneme lookup tables applied for display, English coaching persona explaining the results. The score numbers came from Azure judging Spanish speech as if it were broken English.

The English assumption reaches all seven layers of the pipeline. The Azure call defaults to en-US. The phoneme alphabet is not configured, so Azure returns ARPABET (English) or empty labels (Spanish). The backend normalizer maps only three English ARPABET codes. The frontend normalization table (`core.js`) contains only English ARPABET-to-IPA entries. The chart detail tables (`details.js`) contain only English descriptions, English example words, and English frequency stats. The video assets are all English mouth positions. The coach persona says "American English tutor." The downstream aggregation, trouble-phoneme rollups, and practice generation all key on the English phoneme inventory. There is no layer where Spanish phonemes are understood, displayed, or coached correctly.

Significant prior work exists but is not wired: `packs/es/g2p-spec.js` is a complete rule-based es-MX grapheme-to-phoneme module with a `zipWithAzureScores()` integration bridge, Spanish passage content (arcoiris, abuelo, trabalenguas, minimal pairs) is authored, and coaching prose for key Spanish sounds exists in markdown. The pack system architecture is sound and flows through both repos. The path to Spanish phoneme scoring is long but the foundation is partially laid.

---

## B. The Pipeline, Layer by Layer

### Layer 1: Audio Capture to Assessment Request

**What it does.** The frontend records audio and sends it with a reference text to the backend, which assembles an Azure Speech pronunciation assessment request and returns the raw result.

**Files and functions.**
- Frontend caller: `LUX_GEMINI/_api/assess.js`, `assessPronunciation()` (line 7)
- Backend REST path: `luxury-language-api/routes/assess.js`, lines 80-103 (primary, raw HTTP)
- Backend SDK path: `luxury-language-api/routes/evaluate.js`, lines 26-61 (legacy, SDK)
- Locale resolver: `luxury-language-api/lib/pack-locale.js`, `resolveLocale()` (line 10)

**What is English-baked vs locale-ready.**
- LOCALE-READY: The backend is fully parameterized. `resolveLocale()` maps `pack=es` to `es-MX` and both assessment routes feed the resolved locale into the Azure `Language` parameter and endpoint URL. This was wired in commit `3f07b05`.
- ENGLISH-BAKED: The frontend `assessPronunciation()` never sends `pack`, `lang`, or `locale` in the FormData. It sends only `audio`, `text`, and optionally `firstLang` (the learner's L1, not the target language). The backend therefore always falls back to `en-US`. By contrast, `_api/convo.js` and `_api/ai.js` both send `pack` correctly.
- Three surfaces call assessment (Practice Skills via `features/recorder/index.js`, AI Conversations via `features/convo/convo-turn.js`, Onboarding via the onboarding JSX). None sends `pack`.

**Smoking gun.** `_api/assess.js` line 7-35: the FormData is assembled with `audio`, `text`, and optionally `firstLang`, but no `pack`. This single omission means every assessment runs as English.

### Layer 2: Azure Response and Phoneme Alphabet

**What it does.** Azure returns a pronunciation assessment result containing overall scores plus per-word, per-syllable, and per-phoneme breakdowns. The phoneme alphabet (ARPABET, IPA, or SAPI) determines what symbols appear in the `Phoneme` field of each phoneme object.

**Files and functions.**
- Azure params assembly: `routes/assess.js` lines 80-88 (no `PhonemeAlphabet` property)
- SDK config: `routes/evaluate.js` lines 34-39 (no alphabet parameter)
- Frontend normalization: `LUX_GEMINI/src/data/phonemes/core.js`, `phonemeAlias` (lines 11-97), `norm()` (line 117)
- Backend normalization: `routes/pronunciation-gpt/azureExtract.js`, `makeNorm()` (line 4)

**What is English-baked vs locale-ready.**
- ENGLISH-BAKED: No `PhonemeAlphabet` is set in either assessment route. Azure's default for en-US is SAPI (returns ARPABET-like codes: "ae", "ey", "th"). For es-MX, Azure returns empty Phoneme name fields regardless of alphabet setting. A live probe (2026-05-30) confirmed: with locale `es-MX` and `PhonemeAlphabet: "IPA"` explicitly set, Azure returned 18 phoneme objects for "el cafe esta caliente" with correct AccuracyScore, Offset, and Duration on each, but every `Phoneme` name field was `""`. Syllable labels were also empty. The phoneme counts per word were correct (el=2, cafe=4, esta=4, caliente=8), confirming Azure performs real es-MX phoneme analysis but does not label the phonemes. The G2P fallback layer is therefore required.
- ENGLISH-BAKED: The `phonemeAlias` table in `core.js` maps ~50 English ARPABET codes to canonical IPA. No Spanish entries exist. `norm("")` returns `""`, so every Spanish phoneme becomes an empty string throughout the display pipeline.
- ENGLISH-BAKED: The backend `makeNorm()` maps only `dh` to `eth`, `th` to `theta`, `r` to the English rhotic. Three entries, all English.

**Smoking gun.** Live Azure response (2026-05-30): `"Phoneme": ""` on all 18 phoneme objects for es-MX, even with `PhonemeAlphabet: "IPA"`. The `g2p-spec.js` prediction (lines 5-8) was correct.

### Layer 3: Scoring and Processing

**What it does.** Raw Azure results are turned into the scores Lux shows (Overall, Accuracy, Fluency, Completeness, Prosody) and per-phoneme/per-word breakdowns. Scores are stored in Postgres (`lux_attempts.summary` JSONB column) and fed to the AI coach.

**Files and functions.**
- Score extraction for coaching: `routes/pronunciation-gpt/scoring.js`, `extractOverallPronScore()` (line 30), `scoreTier()` (line 10), `cefrBandFromScore()` (line 19)
- Worst phoneme extraction: `routes/pronunciation-gpt/azureExtract.js`, `worstPhoneme()` (line 8)
- Persistence: `routes/attempt.js`, `toSummaryFromAzure()` (line 17) -- extracts bottom 6 phonemes as `lows` and bottom 10 words
- Convo report aggregation: `routes/convo-report.js`, `aggregateLowsPhonemes()` (line 15)
- Frontend penalty adjustment: `LUX_GEMINI/features/results/rows-logic.js` lines 27-35

**What is English-baked vs locale-ready.**
- LOCALE-READY: The numeric scoring pipeline is a direct pass-through of Azure's numbers. No phoneme-specific weights, difficulty ratings, or frequency adjustments are applied. `scoreTier()` and `cefrBandFromScore()` are purely numeric and language-neutral.
- ENGLISH-BAKED: The `universallyHard` set in `runCoach.js` line 53 contains only `theta`, `eth`, `rhotic` (English dental fricatives and approximant R). Spanish phonemes never match.
- ENGLISH-BAKED: The tutor persona in `personas.js` line 6 says "You are a warm, supportive American English tutor."
- ENGLISH-BAKED: The convo-report narrative prompt in `convo-report.js` line 72 says "You are a supportive, practical American English pronunciation coach." No pack awareness.
- HIGH RISK: If Azure returns empty Phoneme names for es-MX, the `lows` array in `attempt.js` stores entries like `["", 45]`. All downstream aggregation collapses phoneme-level data into a single empty-string bucket, losing all granularity.

**Smoking gun.** `runCoach.js` line 53: `const universallyHard = new Set(["θ", "ð", "ɹ"]);` -- all English, none Spanish.

### Layer 4: Chart Rendering (the Seed Feature)

**What it does.** The Word/Syllable/Phoneme chart is the original seed feature: a table showing words broken into syllables broken into phonemes, each color-coded by accuracy score. Phoneme "pills" (chips) display the phoneme symbol and link to detail views.

**Files and functions.**
- Table shell: `LUX_GEMINI/features/results/header-modern.js`, `renderResultsHeaderModern()` (line 35)
- Row building: `LUX_GEMINI/features/results/rows.js`, `buildRows()` (line 20) -- creates phoneme chips at lines 42-66
- Chip hydration: `LUX_GEMINI/features/interactions/ph-chips.js`, `initPhonemeChipBehavior()` (line 23) -- stamps data attributes from lookup tables
- Syllable rendering: `LUX_GEMINI/features/results/syllables.js`, `renderSyllableStrip()` (line 32)
- Orchestrator: `LUX_GEMINI/features/results/index.js`, `showPrettyResults()` (line 99)

**What is English-baked vs locale-ready.**
- LOCALE-READY: The chip color-coding is purely numeric (score to color class). This works for any language.
- LOCALE-READY: UI chrome labels (column headers, section titles) use `t()` and can be translated.
- ENGLISH-BAKED: The chip label is the raw Azure `Phoneme` field (`rows.js` line 61: `${ipaRaw}`). For es-MX, this is empty.
- ENGLISH-BAKED: `phonemeContentByIPA` in `details.js` (lines 269-643) contains ~42 entries, all English. Each has English `plain` descriptions ("A short, relaxed 'i' sound"), English `exampleWords` (["pen", "happy", "stop", "spin"]), English `frequencyStat` ("appears in ~2% of spoken English"), and English `carefulWith` notes. Zero Spanish entries.
- ENGLISH-BAKED: `articulatorPlacement` in `details.js` (lines 7-238) has ~38 entries with English labels and English example words ("pie", "buy", "tea"). Zero Spanish entries.
- ENGLISH-BAKED: `KNOWN_PHONES` in `ph-chips.js` (line 14) is a set of all English ARPABET + IPA symbols. Missing Spanish-specific phones: /x/, /ñ/, /ʝ/, /ɾ/, /r/ (trill).

**Smoking gun.** `details.js` line 497: `plain: 'A short, relaxed "i" sound. Same area as "ee" but looser.'` -- every entry reads like this, English throughout.

### Layer 5: Phoneme Detail, Tooltip, and Hover Video

**What it does.** When a user clicks or hovers on a phoneme chip, a tooltip shows: IPA symbol, accuracy score, a three-panel carousel (Plain / Technical / Careful With descriptions), example words with TTS playback, frequency stat, and side/front mouth-position videos.

**Files and functions.**
- Tooltip coordinator: `LUX_GEMINI/features/interactions/ph-hover/index.js` (line 1)
- Tooltip renderer: `LUX_GEMINI/features/interactions/ph-hover/tooltip-render.js`, `showTooltip()` (line 45)
- Tooltip carousel: `LUX_GEMINI/features/interactions/ph-hover/tooltip-carousel.js`
- Video controls: `LUX_GEMINI/features/interactions/ph-hover/tooltip-video.js`
- Expanded modal: `LUX_GEMINI/features/interactions/ph-hover/tooltip-modal.js`
- Video asset map: `LUX_GEMINI/src/data/phonemes/assets.js` (lines 16-270)
- TTS synthesis: `tooltip-render.js` line 20, hardcoded `voice: "en-US-AvaNeural"`

**What is English-baked vs locale-ready.**
- ENGLISH-BAKED: All ~48 video entries in `assets.js` show English phoneme mouth positions hosted on Wix CDN. No Spanish-specific phoneme videos exist.
- ENGLISH-BAKED: TTS voice for example word playback is hardcoded to `"en-US-AvaNeural"` at `tooltip-render.js` line 20.
- ENGLISH-BAKED: Panel titles ("Plain", "Technical", "Careful with") are hardcoded English strings in `tooltip-render.js` lines 108-123, even though Spanish translations exist in `packs/es/strings.js` (keys `session.tooltip.panelPlain`, etc.). They are not wired.
- ENGLISH-BAKED: Video button labels ("Side", "Front", "Both", "Stop") are hardcoded at `tooltip-render.js` lines 211-228, though translations also exist unwired.
- ENGLISH-BAKED: `phoneme-spelling-map.js` maps IPA to English spelling patterns only. Line 8: "Coverage: all 24 English consonants + major vowels." No Spanish spelling rules.

**Smoking gun.** `tooltip-render.js` line 20: `voice: "en-US-AvaNeural"` -- even if Spanish phoneme data existed, example words would be spoken in American English.

### Layer 6: Downstream Aggregation

**What it does.** Phoneme scores are aggregated across attempts to identify trouble phonemes, drive the word cloud, power dashboards, and generate the "next practice" activity plan.

**Files and functions.**
- Rollup accumulation: `LUX_GEMINI/features/progress/rollups/rollupsAccumulate.js`, `accumulateRollups()` (line 1)
- Rollup post-processing: `LUX_GEMINI/features/progress/rollups/rollupsPostProcess.js` (line 23)
- Next-activity planner: `LUX_GEMINI/features/next-activity/next-activity.js`, `buildNextActivityPlanFromModel()` (line 44)
- Convo target overlay: `next-activity.js`, `buildConvoTargetOverlay()` (line 98)
- Word cloud: `LUX_GEMINI/features/progress/wordcloud/compute.js`
- Backend history aggregation: `routes/pronunciation-gpt/historySummary.js`, `computeHistorySummaryIfNeeded()` (line 51)
- Backend convo-report aggregation: `routes/convo-report.js`, `aggregateLowsPhonemes()` (line 15)

**What is English-baked vs locale-ready.**
- LOCALE-READY: The rollup accumulation, trouble-phoneme identification, priority scoring (difficulty, persistence, frequency, recency composite), trend tracking, and word cloud rendering are all language-agnostic algorithms operating on phoneme-string keys and numeric scores. They will function with Spanish phoneme symbols.
- ENGLISH-BAKED: `norm()` in `core.js` is the bottleneck. Spanish Azure codes will not be normalized to canonical IPA, so the same phoneme could accumulate under inconsistent keys.
- ENGLISH-BAKED: The `phonemeHint` map in `next-activity.js` lines 106-120 covers only 8 English IPA symbols (eth, theta, rhotic, schwa, ae, etc.). Spanish phoneme targets get no hint overlay in AI conversation prompts.
- ENGLISH-BAKED: Passage phoneme metadata (`passage-phoneme-meta.js`, `harvard-phoneme-meta.js`) is keyed by English ARPABET. No Spanish passage phoneme profiles exist.
- ENGLISH-BAKED: Hardcoded English practice words for `/t/` target at `next-activity.js` lines 162-170.

**Smoking gun.** `next-activity.js` lines 106-120: a hardcoded map of 8 English phoneme hints; Spanish phonemes would return empty string.

### Layer 7: Coach Consumption (Last Mile)

**What it does.** The AI coach (GPT-powered) receives pronunciation assessment data and explains scores to the learner. Recent work (commit `ea39744`) made the coach respond in Spanish when `pack=es`.

**Files and functions.**
- Prompt builder: `routes/pronunciation-gpt/prompt.js` (line 1)
- Runner: `routes/pronunciation-gpt/runCoach.js` (line 1)
- Personas: `routes/pronunciation-gpt/personas.js` (line 1)
- History injection: `routes/pronunciation-gpt/historySummary.js`
- Frontend caller: `LUX_GEMINI/_api/ai.js`, `fetchAIFeedback()` -- sends `pack: getPack()`
- Convo report narrative: `routes/convo-report.js` line 72

**What data the coach receives (user prompt payload, assembled at `runCoach.js` lines 102-113):**
- `worstPhoneme`: single IPA string (the most frequently low-scoring phoneme)
- `worstWords`: array of up to 3 worst-scoring words
- `sampleText`: the reference sentence
- `universal`: boolean from the `universallyHard` set
- `langCode`: user's L1 code
- `overallScore`, `overallTier`, `overallCefr`
- `history` (every 3rd attempt): `topTroublePhonemes`, `topTroubleWords`, `pronDeltaLast5`

**What is English-baked vs locale-ready.**
- LOCALE-READY: The `prompt.js` language override (lines 17-19) prepends a "LANGUAGE OVERRIDE -- HIGHEST PRIORITY" block when `pack=es`, instructing the model to respond in es-MX with seseo and yeismo.
- ENGLISH-BAKED: The language switch is cosmetic. The persona still says "American English tutor" (personas.js line 6). The data pipeline still feeds English phonemes. The `universallyHard` set never fires for Spanish sounds. The coach will explain English phonemes in Spanish.
- ENGLISH-BAKED: `convo-report.js` line 72 says "American English pronunciation coach" with no pack awareness at all.
- ENGLISH-BAKED: If a user practices both English and Spanish, history data (`topTroublePhonemes`) would contain mixed phoneme symbols from both languages with no pack/locale filter.

**Smoking gun.** When `pack=es`, the system prompt reads: "LANGUAGE OVERRIDE...respond ONLY in Mexican Spanish... You are a warm, supportive American English tutor." The coach is told to speak Spanish while identifying as an English tutor.

---

## C. What Mexican Spanish Judging Requires

### Layer 1: Assessment Request

- The frontend `_api/assess.js` must send `pack: getPack()` in the FormData, matching the pattern already used by `_api/convo.js` and `_api/ai.js`. This is one line of code but is the single gate that blocks everything else.
- The backend `resolveLocale()` and both assessment routes are already wired. No backend changes needed for this layer.

### Layer 2: Phoneme Alphabet

- CONFIRMED (2026-05-30): setting `PhonemeAlphabet: "IPA"` does NOT fix the empty-label problem. Azure returns empty `Phoneme` name fields for es-MX regardless of alphabet setting. The `PhonemeAlphabet` parameter is not useful for es-MX.
- The `g2p-spec.js` module IS required. `zipWithAzureScores()` must be wired into the result-processing pipeline to derive IPA labels from the reference text and map them positionally onto Azure's score objects. The G2P module is already written; the probe confirmed the phoneme counts per word align with expectations.
- The frontend `core.js` `phonemeAlias` table does not need Spanish ARPABET entries (since Azure returns no labels at all). Instead, the G2P layer outputs canonical IPA directly, which will pass through `norm()` via the identity fallback (`phonemeAlias[s] || s`). However, Spanish IPA symbols should still be added to `KNOWN_PHONES` and the detail lookup tables.

### Layer 3: Scoring

- The numeric scoring pipeline (score extraction, tiering, CEFR mapping) is language-neutral and needs no changes for Spanish.
- `universallyHard` in `runCoach.js` must become pack-aware. For es-MX, hard phonemes might include the trilled /r/, the /x/ (jota), and the /b/-/v/ merger.
- The `makeNorm()` in `azureExtract.js` should be extended or made pack-aware to normalize Spanish phoneme codes.
- The persona definitions in `personas.js` need pack-aware variants. When `pack=es`, the tutor should not say "American English."
- The `convo-report.js` narrative prompt (line 72) needs a pack branch.
- Prosody assessment is unavailable for es-MX in Azure. The prosody score display must degrade gracefully (hide or mark as unavailable).

### Layer 4: Chart Rendering

- A Spanish `phonemeContent` dataset is needed in `details.js` (or a parallel `details.es.js`): `plain` descriptions of Spanish sounds, `technical` articulatory descriptions, `carefulWith` notes about English-habit interference, `exampleWords` using Spanish words, and `frequencyStat` for spoken Spanish. The existing `packs/es/phonemes/details.es.coaching-tier.md` provides draft coaching prose for 4 phoneme categories but needs to be expanded to the full es-MX inventory and wrapped into a JS module.
- A Spanish `articulatorPlacement` dataset with Spanish example words and Spanish-context tips.
- `KNOWN_PHONES` in `ph-chips.js` must add /x/, /ñ/, /ʝ/, /ɾ/, /r/ (trill) and any other Spanish-specific IPA symbols.
- The chip hydration logic in `ph-chips.js` must become pack-aware, selecting Spanish vs English detail data based on the active pack.

### Layer 5: Tooltip, Detail, Video

- TTS voice must switch to a Spanish voice (e.g., `es-MX-DaliaNeural`) when `pack=es`. Currently hardcoded to `en-US-AvaNeural`.
- Tooltip panel titles must use `t()` instead of hardcoded English. Translations already exist in `packs/es/strings.js` but are not wired.
- Video button labels must similarly use `t()`. Translations exist but are not wired.
- Shared phonemes (like /p/, /b/, /m/, /s/) can reuse existing English mouth-position videos since articulatory placement is language-universal for those.
- Spanish-specific phonemes (/x/, /ñ/, /r/ trill, /ʝ/) need new video assets. Phonemes with different articulation in Spanish (dental /t/ and /d/ vs English alveolar) ideally need Spanish-specific videos.
- A Spanish `phoneme-spelling-map.js` is needed mapping IPA to Spanish orthographic patterns (e.g., /x/ to j, ge, gi; /s/ to s, z, ce, ci with seseo).
- The `getVoiceCaps()` in `player-core.js` filters to `en-US-` voices only (line 35). Must include `es-MX-` voices when `pack=es`.

### Layer 6: Downstream Aggregation

- `norm()` in `core.js` needs Spanish aliases so that rollup accumulation normalizes Spanish phonemes to canonical IPA consistently.
- The `phonemeHint` map in `next-activity.js` needs Spanish entries (e.g., /r/ = "trill as in 'perro'", /x/ = "jota as in 'jugar'").
- Spanish passage phoneme metadata is needed (equivalent to `passage-phoneme-meta.js` and `harvard-phoneme-meta.js`). The elicitation corpus in `packs/es/elicitation.corpus.md` is authored but not wrapped into JS or wired.
- History queries should filter by pack/locale so that English and Spanish phoneme data do not contaminate each other in rollups and practice generation.
- The `VOWEL_SET` in `errors.js` needs Spanish vowels added (though the 5 Spanish pure vowels /a, e, i, o, u/ are largely already present).

### Layer 7: Coach

- The persona must be pack-aware. When `pack=es`, the tutor should identify as a Spanish pronunciation tutor, not "American English."
- The `universallyHard` set must have a Spanish variant.
- The system prompt should inject context about the Spanish phoneme inventory (5 pure vowels, no schwa, no aspirated stops, the r/rr distinction, seseo, yeismo, spirantized allophones) so the model coaches toward correct Spanish targets.
- The `convo-report.js` narrative prompt needs the same pack-aware treatment.
- History data should be pack-filtered so the coach does not see English phoneme trouble when coaching Spanish.

### What the Existing g2p-spec.js Already Provides

The `packs/es/g2p-spec.js` file (lines 1-390+) provides:

- A complete es-MX grapheme-to-phoneme rule set covering ~30 rules: 5 vowels, digraphs (ch, ll, rr, qu, gu), context-sensitive consonants (c, g, z, j, r, h, x, y), and simple 1:1 consonants.
- `esG2P(word)`: converts a single Spanish word to an IPA array.
- `esG2PSequence(text)`: handles multi-word input with word-boundary sentinels.
- `zipWithAzureScores(referenceText, azureWords)`: the integration bridge that maps G2P-derived IPA labels positionally onto Azure's unlabeled phoneme score objects.
- A Lane C diagnostic mapping 7 files where ARPABET labels enter the display path.
- Documentation of 8 Tier 2 gaps (glide detection, allophone tracking, nasal assimilation, proper noun /x/, unscripted speech, KNOWN_PHONES, VOWEL_SET, spelling map).

---

## D. Rated Remediation Plan

Each layer is rated REPLACE (English-only, must be rebuilt for Spanish), AUGMENT (parameterize/extend to support both), or REUSE (already locale-agnostic).

### Layer 1: Assessment Request -- AUGMENT

Difficulty: Trivial. Risk: Low.

The backend is already wired. The fix is adding `fd.append("pack", getPack())` to `_api/assess.js` in the frontend. One import and one line. This is the single gate that enables everything downstream. However, it should be deployed only after Layer 2 is ready, because sending `es-MX` to Azure without handling the resulting phoneme alphabet change would produce worse results than the current English-default (empty phoneme labels instead of at least some English ones).

### Layer 2: Phoneme Alphabet -- AUGMENT

Difficulty: Medium. Risk: Medium (touches the seed feature's data source).

CONFIRMED (2026-05-30 live probe): setting `PhonemeAlphabet: "IPA"` does NOT fix the empty-label problem. Azure returns `"Phoneme": ""` on all phoneme objects for es-MX even with IPA explicitly requested. The `PhonemeAlphabet` parameter is therefore unnecessary for es-MX.

The required fix is wiring `g2p-spec.js`'s `zipWithAzureScores()` into the result-processing pipeline, gated on `pack=es`. The G2P module is already written and the rule set covers standard es-MX orthography. The live probe confirmed phoneme counts per word are plausible (el=2, cafe=4, esta=4, caliente=8), which is what `zipWithAzureScores()` needs to perform positional label assignment. Integration testing against the confirmed Azure response shape is the remaining work.

### Layer 3: Scoring -- AUGMENT

Difficulty: Low. Risk: Low.

The numeric scoring pipeline is a pass-through and needs no changes. The remediation is cosmetic/contextual: make `universallyHard`, `makeNorm()`, the persona definitions, and the convo-report prompt pack-aware. Each is a small conditional branch. The highest-risk item is changing the persona text, because it affects GPT behavior, but the existing language override pattern in `prompt.js` provides a proven template.

### Layer 4: Chart Detail Data -- REPLACE (data), AUGMENT (logic)

Difficulty: High. Risk: High (this is the seed chart).

The data in `details.js` is 100% English and must be rebuilt for Spanish: new `phonemeContent` entries for the full es-MX inventory (~25 phonemes including allophones), new `articulatorPlacement` entries with Spanish examples, new frequency stats for spoken Spanish. The coaching-tier markdown (`details.es.coaching-tier.md`) provides a starting point for 4 categories but must be expanded to the full inventory.

The rendering logic (`rows.js`, `ph-chips.js`, `header-modern.js`) needs AUGMENT-level changes: pack-aware data source selection and `KNOWN_PHONES` extension. The chip rendering and color-coding are already language-neutral.

This layer touches the seed feature directly. Changes must be serialized, backed up (.GOLD), and tested against both English and Spanish data to prevent regression.

### Layer 5: Tooltip/Video -- REPLACE (content), AUGMENT (logic)

Difficulty: High. Risk: Medium.

Content that must be created: Spanish phoneme videos for Spanish-specific sounds (/x/, /ñ/, /r/ trill, /ʝ/), a Spanish spelling-map, and Spanish example words for shared phonemes. Shared-articulation phonemes (/p/, /b/, /m/, /s/, etc.) can reuse English videos.

Logic changes: TTS voice switch (one conditional), tooltip panel titles to `t()` (already translated, just not wired), video button labels to `t()` (same), `getVoiceCaps()` filter expansion, pack-aware asset resolution in `assets.js`.

### Layer 6: Downstream Aggregation -- AUGMENT

Difficulty: Medium. Risk: Medium.

The aggregation algorithms are language-agnostic (REUSE). The changes needed are: extend `norm()` with Spanish aliases, extend the `phonemeHint` map with Spanish entries, create Spanish passage phoneme metadata, and add pack-filtering to history queries so English and Spanish data stay separate. The practice-generation logic (`buildNextActivityPlanFromModel`) is generic and will work once rollup data is clean.

### Layer 7: Coach -- AUGMENT

Difficulty: Low-Medium. Risk: Low.

The language override pattern already exists and works. The remediation is: make the persona pack-aware (replace "American English tutor" with a Spanish tutor variant when pack=es), extend `universallyHard` with Spanish entries, inject Spanish phoneme inventory context into the system prompt, and add pack-filtering to history queries. The `convo-report.js` narrative prompt needs the same treatment.

### Summary Table

| Layer | Rating | Difficulty | Risk | Touches Seed Chart? |
|-------|--------|------------|------|---------------------|
| 1. Assessment Request | AUGMENT | Trivial | Low | No |
| 2. Phoneme Alphabet | AUGMENT | Medium | Medium | Indirectly (data source) |
| 3. Scoring | AUGMENT | Low | Low | No |
| 4. Chart Detail Data | REPLACE/AUGMENT | High | HIGH | YES |
| 5. Tooltip/Video | REPLACE/AUGMENT | High | Medium | YES (detail view) |
| 6. Downstream Aggregation | AUGMENT | Medium | Medium | No |
| 7. Coach | AUGMENT | Low-Medium | Low | No |

---

## E. Recommended Sequence and Method

### Prerequisites -- COMPLETED

0. **Capture live Azure JSON for es-MX.** DONE (2026-05-30). A throwaway probe (`scripts/probe-es-mx-phonemes.mjs`) called Azure with locale `es-MX` and `PhonemeAlphabet: "IPA"`. Result: Azure returned 18 phoneme objects for "el cafe esta caliente" with correct AccuracyScore, Offset, and Duration on each, but every `Phoneme` name field was `""`. Syllable labels were also empty. Setting `PhonemeAlphabet: "IPA"` does not help. The G2P fallback layer IS required. Phoneme counts per word: el=2, cafe=4, esta=4, caliente=8.

### Foundation (must land first, in order)

1. **Layer 2: Wire `g2p-spec.js` to derive phoneme labels for es-MX.**
   Method: Single-session edit. Call `zipWithAzureScores()` in the frontend result-processing path, gated on `pack=es`. The G2P module is already written and the Azure response shape is confirmed. Integration testing against the known phoneme counts (el=2, cafe=4, esta=4, caliente=8) provides a validation baseline. .GOLD backup of any files touched.
   Why first: Without phoneme labels, every downstream layer (chart, tooltip, rollups, coach) receives empty strings. This is the critical bridge.

3. **Layer 1: Send `pack` from `_api/assess.js`.**
   Method: Trivial single-line edit. Can be a parallel swarm task.
   Why third: This activates es-MX assessment. Must not ship before Layer 2 is ready, or the empty-label problem will produce worse results than the current English default.

### Core Chart (highest risk, sequential)

4. **Layer 4: Spanish phoneme detail data.**
   Method: SERIAL, single-session, .GOLD backup of `details.js`. This is the seed chart. Create a parallel data structure (e.g., `details.es.js` or a pack-keyed export) rather than modifying the English data. Extend `KNOWN_PHONES`. Make `ph-chips.js` hydration pack-aware. Test both English and Spanish rendering before and after.
   Why sequential: A wrong edit to the phoneme detail data or chip hydration logic could break the entire chart for both languages. This must be done carefully with regression testing.

5. **Layer 5a: Wire tooltip i18n and TTS voice switch.**
   Method: Can parallel-swarm with Layer 4 if the data structure is agreed first. Switch panel titles to `t()`, switch TTS voice to pack-aware, expand `getVoiceCaps()` filter, wire Spanish spelling-map.
   Why here: These are logic changes that do not touch the seed data. Lower risk.

### Backend Context (can parallel with Core Chart)

6. **Layer 3: Pack-aware coach context.**
   Method: Parallel swarm. Make `universallyHard`, `makeNorm()`, persona definitions, and convo-report prompt pack-aware. Small conditional branches in 4 files.

7. **Layer 7: Genuine Spanish coaching.**
   Method: Parallel swarm. Can land alongside Layer 3 since they touch the same files. Inject Spanish phoneme inventory context into the system prompt. Add pack-filtering to history queries.

### Downstream (after chart and scoring are stable)

8. **Layer 6: Downstream aggregation.**
   Method: Parallel swarm. Extend `norm()` with Spanish aliases, extend `phonemeHint` map, create Spanish passage phoneme metadata from the existing elicitation corpus, add pack-filtering to history/rollup queries.

### Content (can proceed in parallel with all code work)

9. **Spanish phoneme detail content authoring.**
   Method: Content work, not code. Expand the coaching-tier markdown to cover the full es-MX inventory. Write `plain`, `technical`, `carefulWith`, `exampleWords`, `frequencyStat` for each Spanish phoneme. This is the most labor-intensive single task.

10. **Spanish phoneme video production.**
    Method: Content work. Record or source mouth-position videos for Spanish-specific sounds. Shared phonemes can reuse English videos.

### Where a Wrong Edit Is Catastrophic

- `src/data/phonemes/details.js` -- the English phoneme detail table. A bad merge, a key collision, or a broken export would blank every phoneme tooltip for English users. .GOLD backup mandatory. Sequential edit only.
- `src/data/phonemes/core.js` -- the `phonemeAlias` and `norm()` function. A typo in the alias table or a broken fallback would corrupt phoneme display across the entire app. .GOLD backup mandatory.
- `features/results/rows.js` -- the chart row builder. Changes to how `ipaRaw` is read or how chips are created would break the seed chart. .GOLD backup mandatory.
- `features/interactions/ph-chips.js` -- the hydration logic. Breaking the data-attribute stamping would blank all tooltips. .GOLD backup mandatory.
- `routes/assess.js` -- the Azure call. A broken header or malformed params would cause all assessments to fail. .GOLD backup mandatory, test with both en-US and es-MX after any change.

### Dependency Graph

```
[0] Azure JSON capture -- DONE (2026-05-30). PhonemeAlphabet: IPA does not help. G2P required.
 |
[1] Wire g2p-spec.js (REQUIRED -- confirmed by probe)
 |
[2] Send pack from _api/assess.js
 |
 +---> [3] Spanish phoneme detail data (SERIAL, .GOLD)
 |      |
 |      +---> [4] Tooltip i18n + TTS voice (can parallel with 3 if data agreed)
 |
 +---> [5] Pack-aware coach context (PARALLEL with 3)
 |      |
 |      +---> [6] Genuine Spanish coaching (with 5)
 |
 +---> [7] Downstream aggregation (AFTER 3 is stable)
 |
 +---> [8] Content: phoneme detail authoring (PARALLEL with all code)
 |
 +---> [9] Content: video production (PARALLEL with all code)
```

Steps 1-2 are the foundation and must be sequential. Steps 3-4 touch the seed chart and must be serial with .GOLD backups. Steps 5-6 can run in parallel with 3-4. Step 7 waits for the chart data to stabilize. Steps 8-9 are content work that can proceed independently.
