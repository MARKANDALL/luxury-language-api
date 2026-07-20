// routes/coach-ask.js
// One-line: Ask-the-coach — a short, friendly coach answer about a tapped word
// in its sentence (Word Motor Wave 3, the first Conversation-depth feature).
// Cloned from the routes/word-info.js skeleton.
//
// Cloned from routes/word-info.js: same CORS + admin-token gate, same cheap-
// model config (LUX_AI_QUICK_MODEL -> LUX_AI_MODEL -> gpt-4.1-mini), same
// json_object + jsonrepair parsing, same word_taps analytics insert.
//
// Contract:
//   POST { word, sentence, lang, l1, level, uid, style, lens, depth }
//   ->   { ok: true, answer: string }
//
// LENS SYSTEM: each `lens` is a different coaching angle on the tapped word, with
//   its own prompt task + token/temperature budget. The frontend renders one tab
//   per lens; this route answers differently per lens. `lens` is absent/unknown ->
//   "meaning" (backward-compatible: coach-ask v1 callers that send no lens keep
//   working, now served by the meaning lens). `depth` 2 = "go deeper" (a richer
//   answer, more tokens). The CONTRAST lens is the first to USE `l1` (the learner's
//   first language) — the route received it since v1 but never fed it to the model.
//
// Analytics: table word_taps, one row per ask (fire-and-forget), tagged surface
//   "coach" (coach lenses) or "reference" (ref_* lenses). No new tables and no
//   schema change: word_taps has no `lens` column
//   (its columns are uid/word/lang/l1/level/sentence_hash/surface), so the lens is
//   NOT added to the insert — doing so would make PostgREST reject the whole row
//   and silently drop the tap. Degrades gracefully if Supabase env is missing.

import crypto from "node:crypto";

export const config = {
  api: {
    bodyParser: true,
    externalResolver: true,
  },
};

const CEFR_VALUES = new Set(["A1", "A2", "B1", "B2", "C1", "C2"]);

// Word Motor Craft-B2 (item 5): coach persona voices. The rules that keep the
// answer short/warm/level-appropriate still apply to all three — only the TONE
// changes. Kept register-neutral so the tú/English register note stays in charge.
const PERSONA_NOTES = {
  tutor:
    "Voice: a warm, patient tutor. Encouraging and gentle; celebrate small wins.",
  drill:
    "Voice: a no-nonsense drill sergeant — punchy, direct, high-energy, tough love. " +
    "Short imperative commands. Motivating, NEVER insulting or demeaning.",
  linguist:
    "Voice: a precise language expert. Calm and exact; name the sound or grammar " +
    "point plainly, but still in plain words at the learner's level.",
};

// CONTRAST lens: map the incoming l1 code to a readable language name (L1NAME).
// Fallback is the raw l1 string; "universal"/empty falls through to the contrast
// task's own general-note branch (the task text handles the unknown case).
const L1_NAMES = {
  es: "Spanish",
  en: "English",
  pt: "Portuguese",
  fr: "French",
  de: "German",
  it: "Italian",
  zh: "Chinese",
};

// GO-DEEPER clause: appended to the chosen lens task when depth === 2. This is the
// frontend's "go deeper" affordance — a richer take, and ~120 more tokens (below).
const GO_DEEPER =
  "GO DEEPER: The learner wants more. Give a richer, more sophisticated take than the basic version — one extra layer of nuance, a subtler point, or one more example — but stay tight and at the learner's level. Add depth; do not just repeat.";

// The 8 lenses. Each entry is { task, maxTokens, temp, markdown }:
//   - task:     the coaching angle (fed into the shared prompt scaffold below).
//   - maxTokens/temp: per-lens tuning (depth 2 adds ~120 tokens on top).
//   - markdown: whether this lens may emit light markdown (a short list). Metadata
//               only — the frontend renders markdown; the task text already tells
//               the model when a list is appropriate.
// Built per-request because the CONTRAST task interpolates L1NAME (and the
// reference lenses also interpolate the target language name). `meaning` is the
// backward-compatible default: a request with no lens lands here and behaves like
// coach-ask v1.
//
// REFERENCE lenses (`ref_*`, marked `reference: true`): the "look it up" surface —
// the useful WordReference categories, our design + intelligence. They ride this
// SAME map/route/contract as the coach lenses; the only difference is prompt
// content (a neutral, dictionary-like scaffold instead of the coach persona voice,
// chosen in the handler) and a `surface: "reference"` analytics tag. `ref_headline`
// powers the modal's always-on header (an instant sense + translation); the other
// seven are the modal's section tabs.
function buildLenses(L1NAME, targetLangName) {
  return {
    meaning: {
      maxTokens: 240,
      temp: 0.5,
      markdown: false,
      task:
        "TASK — MEANING: The learner tapped this word. If a sentence is given, explain what the word means IN THAT sentence (choose the sense from context); if no sentence, give its most common everyday meaning. Then give ONE concrete tip for using or pronouncing it. 2-3 short sentences, no lists.",
    },
    sayit: {
      maxTokens: 240,
      temp: 0.5,
      markdown: false,
      task:
        "TASK — SAY IT: Focus only on pronunciation. Name the trickiest sound in the word and give ONE simple mouth cue for it (where the tongue or lips go, or a familiar word with the same sound). Say which syllable is stressed. 2-3 short sentences, concrete and physical. Do not use phonetic symbols the learner won't know.",
    },
    contrast: {
      maxTokens: 300,
      temp: 0.4,
      markdown: true,
      task: `TASK — COMPARE TO YOUR LANGUAGE: The learner's first language is ${L1NAME}. Give the ONE or TWO most useful ways ${L1NAME} will help OR trip them up on THIS word — pick only what genuinely applies: a false friend (a similar-looking ${L1NAME} word with a different meaning), a pronunciation habit from ${L1NAME} that distorts this word, or a grammar/usage transfer trap. Be specific and concrete; skip anything that doesn't actually apply to this word. If nothing about ${L1NAME} is relevant here, say so in one friendly line and give a general learner tip instead. At most 2 short points; a 2-item markdown list is fine. (If the first language is unknown/'universal', give one general common-learner note and gently suggest setting a first language for a personalized comparison.)`,
    },
    nuance: {
      maxTokens: 260,
      temp: 0.5,
      markdown: false,
      task:
        "TASK — NUANCE: Explain the word's FEEL, not just its meaning: how formal or casual it is, what it signals about the speaker, and when to choose it over a close synonym (name one or two near-synonyms and how they differ in connotation). 2-3 short sentences. This tab replaces a plain synonyms list, so weave the synonym contrast in naturally.",
    },
    collocations: {
      maxTokens: 280,
      temp: 0.4,
      markdown: true,
      task:
        "TASK — WORD PAIRINGS: Give 2-3 words or short phrases that naturally go WITH this word (its common collocations), and ONE pairing learners commonly get wrong (show wrong -> right, e.g. 'do a decision' -> 'make a decision'). A short markdown list is fine. Tight and practical.",
    },
    examples: {
      maxTokens: 280,
      temp: 0.6,
      markdown: true,
      task:
        "TASK — IN A SENTENCE: Give 2-3 natural example sentences using this word, ranging from more formal to casual. Just the sentences (a short markdown list, each on its own line), almost no explanation. Realistic and level-appropriate.",
    },
    etymology: {
      maxTokens: 240,
      temp: 0.7,
      markdown: false,
      task:
        "TASK — WORD ORIGIN / MEMORY HOOK: In 2-3 short, vivid sentences, give the word's origin story OR a memory hook (a mnemonic, a vivid image, or a related root) that genuinely helps the learner remember it. Delightful but useful — the goal is retention, not trivia. If the true etymology is dull or uncertain, give a memory hook instead.",
    },
    culture: {
      maxTokens: 260,
      temp: 0.6,
      markdown: false,
      task:
        "TASK — CULTURE: In 2-3 short sentences, share something cultural about this word: a connotation, a common idiom it appears in, or how it lands socially — how a native actually uses or reacts to it. For Spanish, prefer Mexican usage and flavor where relevant. Interesting and practical, not a lecture.",
    },

    // ── REFERENCE lenses (the "look it up" modal) ────────────────────────────
    // Same contract as the coach lenses; `reference: true` swaps in the neutral
    // reference scaffold in the handler and tags the tap surface "reference".
    ref_headline: {
      maxTokens: 150,
      temp: 0.3,
      markdown: true,
      reference: true,
      task: `TASK — HEADLINE: Give an instant, two-line answer. Line 1: the part of speech and a one-line gloss of the sense this word or expression has IN THE GIVEN SENTENCE (or its most common sense if no sentence is given). Line 2: its single best translation into ${L1NAME} (or into clear English if the first language is unknown or "universal"). Two short lines, no lists, no preamble. This is a headline, not a full entry.`,
    },
    ref_senses: {
      maxTokens: 300,
      temp: 0.4,
      markdown: true,
      reference: true,
      task:
        "TASK — SENSES (IN CONTEXT): The learner looked this up. If a sentence is given, LEAD with the sense the word has IN THAT sentence: name the part of speech and give a one-line gloss, then one natural example. After that, list up to 2 other common senses as a short markdown list (part of speech + gloss each). If no sentence is given, lead with the most common sense. Tight; no dictionary padding.",
    },
    ref_translation: {
      maxTokens: 300,
      temp: 0.3,
      markdown: true,
      reference: true,
      task: `TASK — TRANSLATION: Give the best translation(s) of this word or expression between ${targetLangName} and ${L1NAME}. Lead with the PRINCIPAL translation for the in-context sense (mark noun gender, and register if it matters), then up to 2 additional translations for other senses as a short markdown list. If ${L1NAME} is unknown or "universal", translate into clear English and add one friendly line suggesting the learner set a first language for a sharper match. Do not invent; if unsure, say so briefly.`,
    },
    ref_examples: {
      maxTokens: 320,
      temp: 0.5,
      markdown: true,
      reference: true,
      task: `TASK — EXAMPLES: Give 3 natural example sentences using this word or expression in its in-context sense, ranging from formal to neutral to casual. Render each as a markdown list item: the ${targetLangName} sentence, then its ${L1NAME} translation in parentheses (or an English translation if the first language is unknown or "universal"). Realistic and level-appropriate; almost no commentary.`,
    },
    ref_expressions: {
      maxTokens: 340,
      temp: 0.4,
      markdown: true,
      reference: true,
      task: `TASK — EXPRESSIONS AND COMPOUND FORMS: List up to 4 common multi-word items built on this word — idioms, phrasal or compound forms, or fixed collocations — as a markdown list. For each: the expression, a short gloss, and its ${L1NAME} equivalent (or an English gloss if the first language is unknown or "universal"). Prefer the most frequent and useful; skip rare or archaic ones. If the looked-up item is ITSELF an expression, unpack it instead: its meaning, when to use it, and one natural example.`,
    },
    ref_synonyms: {
      maxTokens: 280,
      temp: 0.4,
      markdown: true,
      reference: true,
      task:
        "TASK — SYNONYMS AND ANTONYMS: For the in-context sense, give 2-3 near-synonyms and, if any exist, 1-2 antonyms, as a short markdown list. For each, add a few words on the connotation or register difference so the learner can pick the right one — not just a bare list. Flag any near-synonym that is a false friend or shifts the meaning.",
    },
    ref_conjugation: {
      maxTokens: 380,
      temp: 0.2,
      markdown: true,
      reference: true,
      task:
        "TASK — CONJUGATION: If this word is a verb, give a COMPACT conjugation of its most useful forms as a short markdown list (not every tense). For Spanish: the yo / tú / él / nosotros / ellos forms of the present and the preterite, plus the gerundio and participio, and note if it is irregular. For English: base / past / past participle / -ing, and note if it is irregular. Keep it to the high-value forms. If this word is NOT a verb, reply with a single short line saying so.",
    },
    ref_usage: {
      maxTokens: 260,
      temp: 0.4,
      markdown: false,
      reference: true,
      task:
        "TASK — USAGE AND REGISTER: In 2-3 short sentences, tell the learner how to use this word well: how formal or casual it is, any regional notes (for Spanish, prefer Mexican usage), a common mistake or overuse to avoid, and when a native would choose it over a close neighbor. Practical guidance, not a lecture.",
    },
  };
}

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

  // 2) ADMIN_TOKEN gate (cost-control), same as word-info
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
  // Word Motor Craft-B2 (item 5): the learner's selected coach persona
  // (Tutor / Sgt. / Experto), so the answer adopts that voice. Values mirror the
  // frontend voice buttons (ui-ai-ai-dom.getCurrentPersona): tutor | drill |
  // linguist. Unknown/absent -> "tutor" (the warm default this route already used).
  const styleRaw = (body.style || body.persona || "tutor").toString().trim().toLowerCase();
  const style = PERSONA_NOTES[styleRaw] ? styleRaw : "tutor";

  // Lens + depth (the multi-lens word-feedback system). `lens` selects the coaching
  // angle; unknown/absent -> "meaning" (backward-compatible with coach-ask v1).
  // `depth` 2 = "go deeper"; anything else -> 1.
  const L1NAME = L1_NAMES[l1.toLowerCase()] || l1;
  const targetLangName = lang === "es" ? "Spanish" : "English";
  const LENSES = buildLenses(L1NAME, targetLangName);
  const lensRaw = (body.lens || "meaning").toString().trim().toLowerCase();
  const lens = LENSES[lensRaw] ? lensRaw : "meaning";
  const chosen = LENSES[lens];
  const depth = Number(body.depth) === 2 ? 2 : 1;
  // Reference lenses (ref_*) log under a distinct analytics surface.
  const surface = chosen.reference ? "reference" : "coach";

  if (!word) {
    return res.status(400).json({ ok: false, error: "bad_request", detail: "word required" });
  }

  const sHash = sentenceHash(sentence);

  // 4) Tap analytics — fire and forget (surface "coach" | "reference"), never
  // blocks the answer. Degrades gracefully when Supabase env is missing. No cache
  // read/write here. NB: word_taps has no `lens` column, so the lens is
  // intentionally NOT inserted (an unknown column would fail the whole insert and
  // drop the tap); `surface` is an existing column, so the value is safe to vary.
  try {
    const { getSupabaseAdmin } = await import("../lib/supabase.js");
    const sb = getSupabaseAdmin();
    if (sb) {
      sb.from("word_taps")
        .insert({ uid, word, lang, l1, level, sentence_hash: sHash, surface })
        .then(() => {})
        .catch((e) => console.warn("[coach-ask] tap log failed", e?.message || e));
    }
  } catch {
    // env not configured; run without logging
  }

  // 5) Imports & init (mirrors word-info)
  let OpenAI, jsonrepair;
  try {
    const modAI = await import("openai");
    const modRepair = await import("jsonrepair");
    OpenAI = modAI.OpenAI;
    jsonrepair = modRepair.jsonrepair;
  } catch (e) {
    console.error("[coach-ask] import error", e);
    return res.status(500).json({ ok: false, error: "Server Init Error" });
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const registerNote =
    lang === "es"
      ? `Write in Spanish using the informal "tú" register (never "usted").`
      : `Write in English.`;

  // 6) Prompt — the selected lens task inside a shared scaffold. depth 2 appends
  // the GO-DEEPER clause. Coach lenses use the persona voice and speak TO the
  // learner; REFERENCE lenses (ref_*) swap in a neutral, dictionary-like scaffold —
  // same target language, level, register, and JSON-out contract, no persona —
  // because a reference entry should read as a clean reference, not a pep talk.
  const taskBlock = depth === 2 ? `${chosen.task}\n\n${GO_DEEPER}` : chosen.task;
  const system = chosen.reference
    ? `
You are a clean, modern bilingual reference for a ${targetLangName}
learner at CEFR level ${level}.
You get: a word or expression the learner looked up, and (when available) the
sentence it came from. Use the sentence to choose the RIGHT sense.

Rules:
- ${registerNote}
- Lead with what the learner needs: no preamble, no restating the request, no filler.
- Keep it tight and scannable, at or just above the learner's ${level} level; define a hard word only if you must use it.
- Be accurate. Do not invent senses, translations, or forms. If you are unsure, say so briefly instead of guessing.

${taskBlock}

Output MUST be valid JSON only, with exactly this key:
{ "answer": "<your reply>" }
`.trim()
    : `
You are a pronunciation and language coach for a ${targetLangName}
learner at CEFR level ${level}.
You get: a word the learner tapped, and (when available) the sentence it appeared in.

${PERSONA_NOTES[style]}

Rules:
- ${registerNote}
- Use NO words harder than the learner's ${level} level.
- Do not repeat the whole sentence back. Speak TO the learner ("you"/"tú").
- Stay in the Voice above, but keep the register (${registerNote}) exactly.

${taskBlock}

Output MUST be valid JSON only, with exactly this key:
{ "answer": "<your reply>" }
`.trim();

  const user = { word, sentence };

  const MODEL =
    (process.env.LUX_AI_QUICK_MODEL || "").toString().trim() ||
    (process.env.LUX_AI_MODEL || "").toString().trim() ||
    "gpt-4.1-mini";

  // Per-lens tuning; depth 2 bumps the token budget by ~120 for the richer answer.
  const temperature = chosen.temp;
  const maxTokens = chosen.maxTokens + (depth === 2 ? 120 : 0);

  // 7) Call model (cheap + friendly, mirrors word-info's json_object + jsonrepair)
  try {
    const resp = await openai.chat.completions.create({
      model: MODEL,
      temperature,
      max_tokens: maxTokens,
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

    // Cap defensively. Richer lenses (markdown lists) and depth 2 legitimately run
    // longer than coach-ask v1's prose, so the cap is raised from 600 to 1200 to
    // avoid truncating a valid answer mid-list; max_tokens is the real bound.
    const answer = (parsed.answer || "").toString().trim().slice(0, 1200);
    if (!answer) {
      return res.status(502).json({ ok: false, error: "empty_answer" });
    }

    return res.status(200).json({ ok: true, answer });
  } catch (e) {
    console.error("[coach-ask] model call failed", e);
    return res.status(502).json({ ok: false, error: "model_failed" });
  }
}
