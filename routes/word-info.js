// routes/word-info.js
// One-line: Word Tap brain — context-aware learner definition for a tapped
// word (MWE-aware), with Supabase caching and tap-analytics logging.
//
// Cloned from the routes/alt-meaning.js skeleton: same CORS + admin-token
// gate, same cheap-model config (LUX_AI_QUICK_MODEL -> LUX_AI_MODEL ->
// gpt-4.1-mini), same json_object + jsonrepair parsing.
//
// Contract:
//   POST { word, sentence, lang, l1, level, uid, surface }
//   ->   { ok: true, cached: boolean, card: {
//           word, unit, pos, ipa, def, l1Translation,
//           tag: { cefr, freq }, collocations, trap,
//           l1: { translation, definitionL1, sentenceL1 } | null,
//           pronunciation: { syllables, l1Tip|null, trapPhoneme|null },
//           cognate: boolean } }
//   The l1 side is produced for EVERY L1 the picker offers, in that language's
//   own script; the only null cases are "universal" and l1 === lang.
//   `sentenceL1` translates the sentence the CLIENT sent (the one the word was
//   tapped in). Depth 1 no longer invents an example of its own — the card shows
//   the real sentence, which the client already has, and depth 2 owns examples.
//
//   POST { word, sentence, lang, l1, level, depth: 2 }
//   ->   { ok: true, depth: 2, definitionFull, definitionFullL1,
//          synonyms[], synonymsL1[], example: { en, l1 },
//          pronunciationMore: { minimalPair:{a,b,contrast}|null, inSentence|null },
//          reason? }
//   The depth-2 fields are PAIRS because the card renders them as two columns,
//   target language beside the learner's. synonymsL1 are synonyms of the L1
//   EQUIVALENT, not translations of the synonyms list.
//
// Cache: table word_cards, keyed (lang, l1, level, word, sentence_hash).
// Analytics: table word_taps, one row per tap (fire-and-forget). Each tap is
//   tagged with the Word Motor SURFACE it came from (whitelisted, default
//   "convo-ai") so tap analytics can be sliced per surface.
// Both degrade gracefully if Supabase env is missing.

import crypto from "node:crypto";

export const config = {
  api: {
    bodyParser: true,
    externalResolver: true,
  },
};

const FREQ_VALUES = new Set(["very common", "common", "less common", "rare"]);
const CEFR_VALUES = new Set(["A1", "A2", "B1", "B2", "C1", "C2"]);

// Word Motor tap surfaces. Only these are logged; anything else falls back to
// "convo-ai". Kept in sync with features/word-motor/motor-adapters.js on the
// frontend (Wave 1 sends only "convo-ai"; later waves light up the rest).
const SURFACE_VALUES = new Set([
  "convo-ai",
  "convo-user",
  "ph-hover",
  "coach",
  "scenario",
  "passage",
  "results",
  "selfpb",
  "stream",
  "life",
  // Craft-B1 shipped a frontend "practice" surface (read-mode taps) but never
  // added it here, so those taps silently downgraded to "convo-ai" analytics.
  // Corrected in Craft-B2 so practice taps are attributed to their own surface.
  "practice",
  // Craft-B2 new gloss hosts: convo narration lines (item 2) and the per-metric
  // explainer's own prose (item 4). Characters (item 3) reuse "scenario".
  "narration",
  "score-metrics",
]);

function sentenceHash(s) {
  return crypto
    .createHash("sha1")
    .update(String(s || "").trim().toLowerCase())
    .digest("hex")
    .slice(0, 16);
}

// W4-C enrichment validators. Kept small + defensive: the model output is
// untrusted, so both fields are trimmed, whitespace-collapsed and length-capped.
// collocations: up to 2 strings, each non-empty, at most 4 words and 40 chars.
function sanitizeCollocations(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    const s = String(item == null ? "" : item).trim().replace(/\s+/g, " ").slice(0, 40);
    if (!s) continue;
    if (s.split(" ").length > 4) continue; // enforce the "<= 4 words" cap
    out.push(s);
    if (out.length === 2) break; // "up to 2"
  }
  return out;
}

// trap: a single short L1-specific caution. Empty when no L1 is known (there is
// nothing L1-specific to warn about) or when the model returns nothing.
function sanitizeTrap(raw, l1) {
  if (l1 === "universal") return "";
  return String(raw == null ? "" : raw).trim().replace(/\s+/g, " ").slice(0, 160);
}

// ── The first-paint L1 block (card v3) ───────────────────────────────────────
// This route composes in "en" or "es" and no other language, so the whole "In
// this sentence" zone can be handed over in the learner's language exactly when
// their L1 is one of those two AND differs from the language being taught. Every
// other L1 keeps the single-word l1Translation it has always had, rather than an
// English "definition" mislabelled as theirs.
// Round 4 item 5: the gate is LIFTED. This used to be en|es only, inherited from
// the route's origin as an English/Spanish card, and the effect was that a Hindi
// learner got a visibly thinner card than a Spanish one for no reason the model
// could not handle. Every language the picker offers now gets the full L1 side.
// The only cases with no L1 content left are "universal" (there is no language
// to write in) and l1 === lang (it would be the same language twice).
const L1_NAMES = {
  ar: "Arabic",
  de: "German",
  en: "English",
  es: "Spanish",
  fr: "French",
  hi: "Hindi",
  it: "Italian",
  ja: "Japanese",
  ko: "Korean",
  mr: "Marathi",
  pt: "Portuguese",
  ru: "Russian",
  zh: "Chinese (Mandarin)",
};

// The script each L1 must be WRITTEN IN. Naming it explicitly stops the model
// answering Hindi in transliterated Latin ("khush") instead of Devanagari
// ("खुश"), which is the failure this list exists to prevent. Languages that use
// the Latin alphabet need no instruction and are absent on purpose.
const L1_SCRIPTS = {
  ar: "the Arabic script",
  hi: "the Devanagari script",
  ja: "Japanese script (kanji and kana as normal written Japanese)",
  ko: "Hangul",
  mr: "the Devanagari script",
  ru: "the Cyrillic script",
  zh: "Simplified Chinese characters",
};

// Card schema version. A cached card at any other version is treated as a miss
// (see the cache read), so bumping this is what retires stale rows in place.
// v2 = collocations + trap. v3 = the first-paint L1 block.
// v4 = pronunciation { syllables, l1Tip } + the cognate flag, and a `def` the
//      prompt now holds to ~12 words by instruction rather than by luck.
// v5 = the l1 block's `exampleL1` becomes `sentenceL1`, a translation of the
//      REAL sentence the client sent, and depth 1 stops generating an `example`
//      at all (depth 2 still has one).
// v6 = the en|es gate on L1 content is lifted (every language the picker offers
//      gets the full L1 side, in its own script), and depth 1 gains
//      pronunciation.trapPhoneme so the card can point the tip at one chip.
const CARD_VERSION = 6;

function wantsL1Block(l1, lang) {
  return !!l1 && l1 !== "universal" && l1 !== lang;
}

/** The model-facing name of an L1, falling back to the raw code. */
function l1NameOf(l1) {
  return L1_NAMES[l1] || String(l1 || "");
}

/** "…, written in X." plus a script instruction where one is needed. */
function l1ScriptClause(l1) {
  const script = L1_SCRIPTS[l1];
  return script
    ? ` Write it in ${script}, not transliterated into the Latin alphabet.`
    : "";
}

function oneLine(raw, cap) {
  return String(raw == null ? "" : raw).trim().replace(/\s+/g, " ").slice(0, cap);
}

// ── Depth 2: "Show me more examples" ─────────────────────────────────────────
// A second, optional read of the same word, asked only when the learner taps the
// card's own button. Deliberately NOT cached and NOT logged: the tap that opened
// the card already wrote its word_taps row, and temperature 0 makes a re-ask
// deterministic, which is the same trade routes/practice-pod.js makes for its
// ladder. House contract, also practice-pod's: ALWAYS 200, never throw — a
// failure returns the empty shape with a `reason` code so the card can collapse
// its button instead of showing an error.

// Round 2: the depth-2 answer is a TWO-COLUMN block on the card — target
// language left, learner's language right, row for row. So every field comes in
// a pair, and the pairing is what the shape encodes: definitionFull is beside
// definitionFullL1, synonyms beside synonymsL1, and there is now ONE example
// rather than two, because two pairs of two columns is four cells of prose.
function emptyMore(reason) {
  return {
    ok: true,
    depth: 2,
    definitionFull: "",
    definitionFullL1: "",
    synonyms: [],
    synonymsL1: [],
    example: { en: "", l1: "" },
    pronunciationMore: { minimalPair: null, inSentence: null },
    reason,
  };
}

// v6 / round 4 item 7: the two model-written halves of the pronunciation coach.
// Both are nullable on purpose — an invented minimal pair or a made-up remark
// about a sentence is worse than an absent one, so the prompt is told to return
// null and this keeps that null rather than coercing it to a string.
function sanitizeMinimalPair(raw, wantL1) {
  if (!wantL1 || !raw || typeof raw !== "object") return null;
  const a = oneLine(raw.a, 40);
  const b = oneLine(raw.b, 40);
  if (!a || !b || a.toLowerCase() === b.toLowerCase()) return null;
  return { a, b, contrast: oneLine(raw.contrast, 80) };
}

function sanitizeInSentence(raw, wantL1) {
  if (!wantL1) return null;
  const s = oneLine(raw, 220);
  return s || null;
}

// synonyms: up to 4 short alternatives, each at most 3 words. Used for BOTH
// columns — the L1 column's list is synonyms of the L1 equivalent, not
// translations of this list (see the prompt), but the shape is identical.
function sanitizeSynonyms(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    const s = oneLine(item, 40);
    if (!s) continue;
    if (s.split(" ").length > 3) continue;
    out.push(s);
    if (out.length === 4) break;
  }
  return out;
}

// The single example pair. `en` is the sentence in the TARGET language — named
// for the common case, it holds Spanish under the es pack — and `l1` is that
// same sentence in the learner's language, or "" when there is no L1 this route
// can write in.
function sanitizeExample(raw, wantL1) {
  const en = oneLine(raw?.en, 140);
  if (!en) return { en: "", l1: "" };
  return { en, l1: wantL1 ? oneLine(raw?.l1, 140) : "" };
}

// ── v4: pronunciation ────────────────────────────────────────────────────────
// `syllables` is the unit broken on middle dots with the stressed syllable in
// caps ("ar·RANGE"). A single-syllable word is just the word, so there is no dot
// to insist on — the only thing enforced here is the character set, because this
// string is rendered as-is.
function sanitizeSyllables(raw, unit) {
  // Strip first, THEN collapse and trim — otherwise removing a parenthetical
  // ("ar·RANGE (stress 2)") leaves the whitespace that surrounded it behind.
  const s = String(raw == null ? "" : raw)
    .replace(/[^\p{L}\p{M}·'’\- ]/gu, "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 60);
  return s || String(unit || "");
}

// `l1Tip` is one sentence about the single most likely pronunciation trap for
// THIS L1 on THIS word. Null (not "") when there is no L1 to be specific about —
// the card hides the line entirely rather than showing an empty one.
function sanitizeL1Tip(raw, wantL1) {
  if (!wantL1) return null;
  const s = oneLine(raw, 160);
  return s || null;
}

// v6: ONE IPA symbol, the one the tip is about. Capped at 3 code points so an
// affricate or a diphthong ("tʃ", "aɪ") survives while a whole transcription
// does not — the card colours exactly one chip with this.
function sanitizeTrapPhoneme(raw, wantL1) {
  if (!wantL1) return null;
  const s = oneLine(raw, 12).replace(/[/[\]]/g, "");
  if (!s) return null;
  return [...s].length <= 3 ? s : null;
}

function quickModel() {
  return (
    (process.env.LUX_AI_QUICK_MODEL || "").toString().trim() ||
    (process.env.LUX_AI_MODEL || "").toString().trim() ||
    "gpt-4.1-mini"
  );
}

async function handleMoreExamples(res, { word, sentence, lang, l1, level, trapPhoneme }) {
  let OpenAI, jsonrepair;
  try {
    const modAI = await import("openai");
    const modRepair = await import("jsonrepair");
    OpenAI = modAI.OpenAI;
    jsonrepair = modRepair.jsonrepair;
  } catch (e) {
    console.error("[word-info] depth2 import error", e);
    return res.status(200).json(emptyMore("init_error"));
  }

  // The openai v4 constructor throws synchronously without OPENAI_API_KEY, and
  // that throw must degrade to the empty shape rather than surface as a 500.
  let openai;
  try {
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  } catch (e) {
    console.error("[word-info] depth2 init error", e);
    return res.status(200).json(emptyMore("init_error"));
  }

  const targetLangName = lang === "es" ? "Spanish" : "English";
  const wantL1 = wantsL1Block(l1, lang);
  const l1Name = l1NameOf(l1);

  const system = `
You expand a tiny word card for ${targetLangName} learners at CEFR level ${level}.
You get: a word, and the sentence it appeared in. The learner has already read a
one-line definition and one example, and has asked for more.

The card renders your answer as TWO COLUMNS side by side — ${targetLangName} on
the left, ${wantL1 ? l1Name : "nothing"} on the right — so the fields come in pairs
and each pair must line up as the same fact said twice.

Rules:
- Stay on the SENSE the word carries in the given sentence.
- "definitionFull": a fuller definition in simple ${targetLangName} a ${level}
  learner understands. Two short sentences at most, max 40 words total.
- "synonyms": up to 4 ${targetLangName} words or short phrases that could stand in
  for this word in this sense, each at most 3 words. Use [] if none fit.
- "example": ONE new, natural ${targetLangName} sentence using the word, max 14
  words, different from the given sentence.
${wantL1
    ? `EVERY ${l1Name} field below must be written in ${l1Name}.${l1ScriptClause(l1)}
- "definitionFullL1": the SAME definition as "definitionFull", written in
  ${l1Name}. Same meaning, same length limit.
- "synonymsL1": up to 4 ${l1Name} synonyms OF THE ${l1Name.toUpperCase()} EQUIVALENT of the word.
  These are NOT translations of the "synonyms" list. Translate the word into
  ${l1Name} first, then list what could stand in for THAT word in ${l1Name}. For
  English "plan" into Spanish that is "plan" -> ["proyecto", "programa"], NOT the
  Spanish for "scheme" or "intend".
- "example": the object { "en": "<the ${targetLangName} sentence>", "l1": "<that SAME sentence in ${l1Name}>" }.
  The "l1" side is a translation of the "en" side, never a different sentence.
- "pronunciationMore": an object with these two keys, for the pronunciation
  coach the card shows under "How to say it":
    · "minimalPair": { "a", "b", "contrast" } — two real ${targetLangName} words
      that differ in exactly ONE sound${trapPhoneme
        ? `, and that one sound MUST be "${trapPhoneme}" — the sound this learner
      gets wrong. "a" contains "${trapPhoneme}"; "b" is identical except that one
      sound is a different one. A pair that differs somewhere else (a different
      consonant cluster, an extra syllable) is WRONG here, however neat it looks`
        : `, the sound a ${l1Name} speaker is most likely to get wrong in this word`}.
      Worked example: for "stall" with the trap sound "ɔ", {"a":"stall","b":"stole"}
      is RIGHT (only the vowel moves). {"a":"stall","b":"small"} is WRONG — it
      changes the consonants and leaves the trap sound untouched.
      "a" is the word with the target sound, "b" its near-miss, and "contrast" is
      a short phrase in ${l1Name} naming the difference, max 8 words. Use null if
      no honest minimal pair exists — do NOT invent one.
    · "inSentence": ONE sentence in ${l1Name}, max 25 words, about how this word
      BEHAVES INSIDE the given sentence — linking into the next word, a reduced
      or dropped sound, or where the sentence stress falls. It must be about this
      word in THIS sentence, not general advice. Use null if there is nothing
      worth saying or no sentence was given.`
    : `- "definitionFullL1": empty string "".
- "synonymsL1": [].
- "example": the object { "en": "<the ${targetLangName} sentence>", "l1": "" }.
- "pronunciationMore": { "minimalPair": null, "inSentence": null }.`}
Output MUST be valid JSON only, with exactly these keys:
{ "definitionFull", "definitionFullL1", "synonyms", "synonymsL1", "example",
  "pronunciationMore" }
`.trim();

  let raw;
  try {
    const resp = await openai.chat.completions.create({
      model: quickModel(),
      temperature: 0, // determinism replaces caching (practice-pod's trade)
      // Two columns means roughly twice the prose of the round-1 single column.
      max_tokens: 700,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify({ word, sentence }) },
      ],
    });
    raw = resp?.choices?.[0]?.message?.content || "{}";
  } catch (e) {
    console.error("[word-info] depth2 model call failed", e);
    return res.status(200).json(emptyMore("model_failed"));
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    try {
      parsed = JSON.parse(jsonrepair(raw));
    } catch {
      return res.status(200).json(emptyMore("bad_model_json"));
    }
  }

  const definitionFull = oneLine(parsed?.definitionFull, 320);
  const definitionFullL1 = wantL1 ? oneLine(parsed?.definitionFullL1, 320) : "";
  const synonyms = sanitizeSynonyms(parsed?.synonyms);
  const synonymsL1 = wantL1 ? sanitizeSynonyms(parsed?.synonymsL1) : [];
  const example = sanitizeExample(parsed?.example, wantL1);
  const pronunciationMore = {
    minimalPair: sanitizeMinimalPair(parsed?.pronunciationMore?.minimalPair, wantL1),
    inSentence: sanitizeInSentence(parsed?.pronunciationMore?.inSentence, wantL1),
  };

  if (!definitionFull && !synonyms.length && !example.en) {
    return res.status(200).json(emptyMore("empty_more"));
  }

  return res.status(200).json({
    ok: true,
    depth: 2,
    definitionFull,
    definitionFullL1,
    synonyms,
    synonymsL1,
    example,
    pronunciationMore,
  });
}

export default async function handler(req, res) {
  // 1) CORS
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  // 2) ADMIN_TOKEN gate (cost-control), same as alt-meaning
  const token =
    (req.headers["x-admin-token"] || "").toString().trim() ||
    (req.query?.token || "").toString().trim();
  const expected = (process.env.ADMIN_TOKEN || "").toString().trim();
  if (!expected || token !== expected) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  // 3) Validate input
  const body = req.body || {};
  const word = (body.word || "").toString().trim().slice(0, 60);
  const sentence = (body.sentence || "").toString().trim().slice(0, 600);
  const lang = (body.lang || "en").toString().trim() === "es" ? "es" : "en";
  const l1 = (body.l1 || "universal").toString().trim().slice(0, 24) || "universal";
  const levelRaw = (body.level || "B1").toString().trim().toUpperCase();
  const level = CEFR_VALUES.has(levelRaw) ? levelRaw : "B1";
  const uid = (body.uid || "").toString().trim().slice(0, 80);
  const surfaceRaw = (body.surface || "convo-ai").toString().trim();
  const surface = SURFACE_VALUES.has(surfaceRaw) ? surfaceRaw : "convo-ai";
  // Wave 4 (W4-D): a prefetch is a speculative card warm-up for the rarest
  // words in a new AI turn. It must NEVER write a word_taps row (the tap log is
  // an implicit-assessment signal; prefetches would poison it). Everything else
  // — cache read, model call, cache write — behaves exactly as a normal call.
  const prefetch = body.prefetch === true;

  if (!word) {
    return res.status(400).json({ ok: false, error: "bad_request", detail: "word required" });
  }

  // 3b) Depth 2 — "Show me more examples". Its own branch, taken BEFORE the tap
  // log and the cache: this is a second read of a word whose tap was already
  // counted, and it is answered by the model every time (see handleMoreExamples).
  if (Number(body.depth) === 2) {
    return handleMoreExamples(res, {
      word, sentence, lang, l1, level,
      // The card hands back the trap phoneme depth 1 identified, so the minimal
      // pair is chosen for the sound this learner actually struggles with.
      trapPhoneme: oneLine(body.trapPhoneme, 12),
    });
  }

  const sHash = sentenceHash(sentence);

  // 4) Supabase (lazy, optional — never let cache/logging break the card)
  let sb = null;
  try {
    const { getSupabaseAdmin } = await import("../lib/supabase.js");
    sb = getSupabaseAdmin();
  } catch {
    sb = null; // env not configured; run cacheless
  }

  // 4a-log) logOnly fast-path — for gloss taps answered locally by the frontend
  // BUILTIN_GLOSS map. The tap still feeds analytics, but we skip the cache read
  // and skip the model entirely (no cost). Admin gate + validation above still
  // apply. The insert is awaited (not fire-and-forget) so the row lands before
  // the serverless function can freeze after the response. Degrades gracefully
  // when Supabase env is missing (returns ok anyway; nothing to log).
  if (body.logOnly === true) {
    // W4-D law: a prefetch must NEVER write a word_taps row (taps are implicit
    // assessment data; a prefetched row would poison that signal). When a call is
    // BOTH logOnly and prefetch, the prefetch guard wins and no tap is inserted —
    // otherwise this fast-path would insert before the prefetch guard below is
    // ever reached. Single-flag behavior is unchanged: logOnly alone still logs
    // (logged:true); prefetch alone never enters this block.
    if (sb && !prefetch) {
      try {
        await sb
          .from("word_taps")
          .insert({ uid, word, lang, l1, level, sentence_hash: sHash, surface });
      } catch (e) {
        console.warn("[word-info] logOnly tap log failed", e?.message || e);
      }
    }
    return res.status(200).json({ ok: true, logged: !prefetch });
  }

  // 4a) Tap analytics — fire and forget, before anything can fail.
  // W4-D: a prefetch skips this insert (and ONLY this insert); the cache read,
  // model call, and cache write below all run normally so the tap that follows
  // a prefetch opens instantly from the warmed cache.
  if (sb && !prefetch) {
    sb.from("word_taps")
      .insert({ uid, word, lang, l1, level, sentence_hash: sHash, surface })
      .then(() => {})
      .catch((e) => console.warn("[word-info] tap log failed", e?.message || e));
  }

  // 4b) Cache read
  if (sb) {
    try {
      const { data } = await sb
        .from("word_cards")
        .select("card")
        .eq("lang", lang)
        .eq("l1", l1)
        .eq("level", level)
        .eq("word", word.toLowerCase())
        .eq("sentence_hash", sHash)
        .maybeSingle();
      // W4-C decision 5: the enriched card carries a version stamp. A cached card
      // at any older version is a stale entry — treat it as a miss so we
      // regenerate and the upsert below overwrites it. No SQL/migration needed.
      // v3 adds the first-paint L1 block, so every v2 row is stale now.
      if (data?.card && data.card.v === CARD_VERSION) {
        return res.status(200).json({ ok: true, cached: true, card: data.card });
      }
    } catch (e) {
      console.warn("[word-info] cache read failed", e?.message || e);
    }
  }

  // 5) Imports & init (mirrors alt-meaning)
  let OpenAI, jsonrepair;
  try {
    const modAI = await import("openai");
    const modRepair = await import("jsonrepair");
    OpenAI = modAI.OpenAI;
    jsonrepair = modRepair.jsonrepair;
  } catch (e) {
    console.error("[word-info] import error", e);
    return res.status(500).json({ ok: false, error: "Server Init Error" });
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const targetLangName = lang === "es" ? "Spanish" : "English";
  // Whether this card also composes its whole "In this sentence" zone in the
  // learner's language on FIRST paint (card v3) — see wantsL1Block.
  const wantL1 = wantsL1Block(l1, lang);
  const l1Name = l1NameOf(l1);

  // 6) Prompt — context definition, learner register, MWE-aware
  const system = `
You write tiny word cards for ${targetLangName} learners at CEFR level ${level}.
You get: a tapped word, and the sentence it appeared in.

Rules:
- Define the word AS USED IN THIS SENTENCE (pick the right sense from context).
- MULTI-WORD CHECK: if the tapped word is part of a phrasal verb, idiom, or
  fixed expression in this sentence (e.g. tapping "up" in "give up"), define
  the WHOLE unit and put it in "unit". Otherwise "unit" = the word's base form.
- "def": ONE SHORT definition in simple ${targetLangName} a ${level} learner
  understands. HARD LIMIT 12 WORDS. One clause only — no "and", no semicolon, no
  second sentence. Do NOT put an example, a quotation, or "e.g." inside it. It is
  the first line the learner reads and it must be readable at a glance. No harder
  words than the word itself.
- "pos": one of ["noun","verb","adjective","adverb","preposition",
  "conjunction","pronoun","interjection","phrase","other"].
- "ipa": IPA for the unit (General American for English, neutral Latin
  American for Spanish), no surrounding slashes.
- "l1Translation": ${l1 === "universal"
    ? 'empty string ""'
    : `the unit TRANSLATED into the language with code "${l1}" — the equivalent
  WORD OR PHRASE, at most 4 words. This is NOT a definition and NOT an
  explanation: English "plan" gives "plan", not "una idea detallada de qué
  hacer". If the unit is a phrasal verb, give the equivalent phrase. No
  commentary, no parentheses`}.
- "cefr": your estimate of the unit's difficulty level ("A1".."C2").
- "freq": one of ["very common","common","less common","rare"].
- "collocations": up to 2 short, natural collocations of the unit (the words it
  most often travels with), as an array of strings, each at most 4 words. Use
  [] if none are worth showing. No definitions, just the collocations.
- "trap": ${l1 === "universal"
    ? 'empty string "" (no L1 is known, so no L1-specific trap).'
    : `ONE short caution (max 16 words) specific to a learner whose first language has code "${l1}" — e.g. a false friend, or a make/do-style interference — but ONLY when a genuine trap exists for THIS unit. If there is no real trap, use empty string "".`}
- "syllables": the unit split into syllables on the MIDDLE DOT character "·",
  with the STRESSED syllable in capitals — "ar·RANGE", "HOS·pi·tal". A
  one-syllable unit is just the word as written, with no dot. Letters, dots,
  hyphens, apostrophes and spaces only.
${wantL1
    ? `EVERY ${l1Name} field below must be written in ${l1Name}.${l1ScriptClause(l1)}
- "definitionL1": the SAME meaning as "def", written in ${l1Name}. Max 18 words.
- "sentenceL1": the GIVEN sentence — the one the learner tapped the word in,
  exactly as supplied — translated faithfully into ${l1Name}. Translate WHAT IS
  THERE: same meaning, same tense, same register. Do NOT write a new or better
  sentence, do NOT shorten it to a phrase, and do NOT gloss only the word. If the
  given sentence is empty, use empty string "".
- "trapPhoneme": the SINGLE IPA symbol your "l1Tip" is about — the one sound in
  this unit a ${l1Name} speaker is most likely to get wrong. One symbol only
  (e.g. "æ", "θ", "ɪ"), taken from the "ipa" you gave above, with no slashes. Use
  empty string "" when the tip is not about one specific sound, or when there is
  no tip.
- "l1Tip": ONE sentence, max 20 words, naming the SINGLE most likely
  pronunciation trap for a ${l1Name} speaker saying THIS unit. Be specific to the
  sounds in this word, not generic advice. Good ${l1Name} examples: the vowel in
  "plan" sits between Spanish a and e; do not add an e sound before sp/st; keep
  the final consonant voiced. If this unit genuinely has no ${l1Name}-specific
  trap, use empty string "".
- "cognate": true ONLY when the ${l1Name} equivalent shares BOTH form and meaning
  with the unit (plan/plan, hospital/hospital, natural/natural). false for false
  friends and for anything that merely looks similar — those belong in "trap".`
    : `- "definitionL1": empty string "".
- "sentenceL1": empty string "".
- "trapPhoneme": empty string "".
- "l1Tip": empty string "".
- "cognate": false.`}
Output MUST be valid JSON only, with exactly these keys:
{ "unit", "pos", "ipa", "def", "l1Translation", "cefr", "freq",
  "collocations", "trap", "definitionL1", "sentenceL1", "syllables", "l1Tip",
  "trapPhoneme", "cognate" }
`.trim();

  const user = { word, sentence };

  const MODEL = quickModel();

  // 7) Call model (cheap + deterministic, mirrors alt-meaning)
  try {
    const resp = await openai.chat.completions.create({
      model: MODEL,
      temperature: 0.1,
      // v3 added definitionL1 + exampleL1; v4 adds syllables, l1Tip and cognate.
      // The ceiling rises with them — a truncated answer is a card with no
      // definition, which is a 502 the learner sees.
      max_tokens: 720,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(user) },
      ],
    });

    const raw = resp?.choices?.[0]?.message?.content || "{}";
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = JSON.parse(jsonrepair(raw));
    }

    const l1Translation =
      l1 === "universal" ? "" : (parsed.l1Translation || "").toString().trim().slice(0, 120);

    const card = {
      word,
      unit: (parsed.unit || word).toString().trim().slice(0, 80),
      pos: (parsed.pos || "other").toString().trim().slice(0, 20),
      ipa: (parsed.ipa || "").toString().trim().slice(0, 60),
      def: (parsed.def || "").toString().trim().slice(0, 160),
      l1Translation,
      tag: {
        cefr: CEFR_VALUES.has((parsed.cefr || "").toString().toUpperCase())
          ? parsed.cefr.toString().toUpperCase()
          : "",
        freq: FREQ_VALUES.has((parsed.freq || "").toString().toLowerCase())
          ? parsed.freq.toString().toLowerCase()
          : "",
      },
      // W4-C: card data v2 — collocations + an optional L1 trap note.
      collocations: sanitizeCollocations(parsed.collocations),
      trap: sanitizeTrap(parsed.trap, l1),
      // v3: the first-paint L1 block. Present only for the L1s this route can
      // write in; null everywhere else, where l1Translation above is still the
      // whole of what the learner gets in their own language.
      //
      // v5: `sentenceL1` replaces `exampleL1`, and the depth-1 `example` is gone
      // with it. The card used to print a model-invented sentence next to a
      // translation of that invented sentence, while the bubble the learner was
      // actually reading said something else entirely. Now the card shows the
      // REAL sentence (the client already has it) and this is its translation.
      // The generated example pair still exists — at depth 2, where the learner
      // asked for it.
      l1: wantL1
        ? {
            translation: l1Translation,
            definitionL1: oneLine(parsed.definitionL1, 160),
            sentenceL1: oneLine(parsed.sentenceL1, 400),
          }
        : null,
      // v4: how to SAY it. `syllables` is always present (a one-syllable word is
      // just itself); `l1Tip` is null when there is no L1 to be specific about,
      // so the card hides that line rather than printing an empty one.
      pronunciation: {
        syllables: sanitizeSyllables(parsed.syllables, parsed.unit || word),
        l1Tip: sanitizeL1Tip(parsed.l1Tip, wantL1),
        // v6: the one IPA symbol the tip is about, so the card can colour that
        // phoneme chip and the advice visibly points at a sound rather than
        // floating beside the whole word.
        trapPhoneme: sanitizeTrapPhoneme(parsed.trapPhoneme, wantL1),
      },
      // v4: shares BOTH form and meaning with the L1 equivalent. A false friend
      // is deliberately NOT a cognate — that case is what `trap` above is for.
      cognate: wantL1 ? parsed.cognate === true : false,
      // Schema version. Cache reads treat any other version as a miss
      // (decision 5), so this stamp is what upgrades stale entries in place.
      v: CARD_VERSION,
    };

    if (!card.def) {
      return res.status(502).json({ ok: false, error: "empty_card" });
    }

    // 8) Cache write — fire and forget
    if (sb) {
      sb.from("word_cards")
        .upsert(
          {
            lang,
            l1,
            level,
            word: word.toLowerCase(),
            sentence_hash: sHash,
            card,
          },
          { onConflict: "lang,l1,level,word,sentence_hash" }
        )
        .then(() => {})
        .catch((e) => console.warn("[word-info] cache write failed", e?.message || e));
    }

    return res.status(200).json({ ok: true, cached: false, card });
  } catch (e) {
    console.error("[word-info] model call failed", e);
    return res.status(502).json({ ok: false, error: "model_failed" });
  }
}
