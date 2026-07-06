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
//           word, unit, pos, ipa, def, example, l1Translation,
//           tag: { cefr, freq } } }
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
]);

function sentenceHash(s) {
  return crypto
    .createHash("sha1")
    .update(String(s || "").trim().toLowerCase())
    .digest("hex")
    .slice(0, 16);
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

  if (!word) {
    return res.status(400).json({ ok: false, error: "bad_request", detail: "word required" });
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

  // 4a) Tap analytics — fire and forget, before anything can fail
  if (sb) {
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
      if (data?.card) {
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

  // 6) Prompt — context definition, learner register, MWE-aware
  const system = `
You write tiny word cards for ${targetLangName} learners at CEFR level ${level}.
You get: a tapped word, and the sentence it appeared in.

Rules:
- Define the word AS USED IN THIS SENTENCE (pick the right sense from context).
- MULTI-WORD CHECK: if the tapped word is part of a phrasal verb, idiom, or
  fixed expression in this sentence (e.g. tapping "up" in "give up"), define
  the WHOLE unit and put it in "unit". Otherwise "unit" = the word's base form.
- "def": one short definition in simple ${targetLangName} a ${level} learner
  understands. Max 18 words. No harder words than the word itself.
- "example": ONE new, natural example sentence using the unit. Max 12 words.
  Do not reuse the given sentence.
- "pos": one of ["noun","verb","adjective","adverb","preposition",
  "conjunction","pronoun","interjection","phrase","other"].
- "ipa": IPA for the unit (General American for English, neutral Latin
  American for Spanish), no surrounding slashes.
- "l1Translation": ${l1 === "universal"
    ? 'empty string ""'
    : `a short translation of the unit into the language with code "${l1}" (the translation itself, no commentary)`}.
- "cefr": your estimate of the unit's difficulty level ("A1".."C2").
- "freq": one of ["very common","common","less common","rare"].
Output MUST be valid JSON only, with exactly these keys:
{ "unit", "pos", "ipa", "def", "example", "l1Translation", "cefr", "freq" }
`.trim();

  const user = { word, sentence };

  const MODEL =
    (process.env.LUX_AI_QUICK_MODEL || "").toString().trim() ||
    (process.env.LUX_AI_MODEL || "").toString().trim() ||
    "gpt-4.1-mini";

  // 7) Call model (cheap + deterministic, mirrors alt-meaning)
  try {
    const resp = await openai.chat.completions.create({
      model: MODEL,
      temperature: 0.1,
      max_tokens: 420,
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

    const card = {
      word,
      unit: (parsed.unit || word).toString().trim().slice(0, 80),
      pos: (parsed.pos || "other").toString().trim().slice(0, 20),
      ipa: (parsed.ipa || "").toString().trim().slice(0, 60),
      def: (parsed.def || "").toString().trim().slice(0, 160),
      example: (parsed.example || "").toString().trim().slice(0, 120),
      l1Translation:
        l1 === "universal" ? "" : (parsed.l1Translation || "").toString().trim().slice(0, 120),
      tag: {
        cefr: CEFR_VALUES.has((parsed.cefr || "").toString().toUpperCase())
          ? parsed.cefr.toString().toUpperCase()
          : "",
        freq: FREQ_VALUES.has((parsed.freq || "").toString().toLowerCase())
          ? parsed.freq.toString().toLowerCase()
          : "",
      },
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
