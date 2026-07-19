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
//   "coach". No new tables and no schema change: word_taps has no `lens` column
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
// Built per-request because the CONTRAST task interpolates L1NAME. `meaning` is the
// backward-compatible default: a request with no lens lands here and behaves like
// coach-ask v1.
function buildLenses(L1NAME) {
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
  const LENSES = buildLenses(L1NAME);
  const lensRaw = (body.lens || "meaning").toString().trim().toLowerCase();
  const lens = LENSES[lensRaw] ? lensRaw : "meaning";
  const chosen = LENSES[lens];
  const depth = Number(body.depth) === 2 ? 2 : 1;

  if (!word) {
    return res.status(400).json({ ok: false, error: "bad_request", detail: "word required" });
  }

  const sHash = sentenceHash(sentence);

  // 4) Tap analytics — fire and forget (surface "coach"), never blocks the answer.
  // Degrades gracefully when Supabase env is missing. No cache read/write here.
  // NB: word_taps has no `lens` column, so the lens is intentionally NOT inserted
  // (adding an unknown column would make the whole insert fail and drop the tap).
  try {
    const { getSupabaseAdmin } = await import("../lib/supabase.js");
    const sb = getSupabaseAdmin();
    if (sb) {
      sb.from("word_taps")
        .insert({ uid, word, lang, l1, level, sentence_hash: sHash, surface: "coach" })
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

  const targetLangName = lang === "es" ? "Spanish" : "English";
  const registerNote =
    lang === "es"
      ? `Write in Spanish using the informal "tú" register (never "usted").`
      : `Write in English.`;

  // 6) Prompt — shared coach scaffold (target language, level, register, persona
  // voice, speak-TO-the-learner, JSON out) + the selected lens task. The per-lens
  // TASK replaces coach-ask v1's single hard-coded meaning task. depth 2 appends
  // the GO-DEEPER clause.
  const taskBlock = depth === 2 ? `${chosen.task}\n\n${GO_DEEPER}` : chosen.task;
  const system = `
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
