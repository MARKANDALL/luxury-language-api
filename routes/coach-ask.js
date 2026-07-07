// routes/coach-ask.js
// One-line: Ask-the-coach v1 — a short, friendly coach answer about a tapped
// word in its sentence (Word Motor Wave 3, the first Conversation-depth
// feature). Cloned from the routes/word-info.js skeleton.
//
// Cloned from routes/word-info.js: same CORS + admin-token gate, same cheap-
// model config (LUX_AI_QUICK_MODEL -> LUX_AI_MODEL -> gpt-4.1-mini), same
// json_object + jsonrepair parsing, same word_taps analytics insert.
//
// Contract:
//   POST { word, sentence, lang, l1, level, uid }
//   ->   { ok: true, answer: string }
//
// Analytics: table word_taps, one row per ask (fire-and-forget), tagged
//   surface "coach". No cache table is added — a coach answer is conversational
//   and cheap; this route needs NO SQL and creates NO new tables. Degrades
//   gracefully if Supabase env is missing (still answers; nothing to log).

import crypto from "node:crypto";

export const config = {
  api: {
    bodyParser: true,
    externalResolver: true,
  },
};

const CEFR_VALUES = new Set(["A1", "A2", "B1", "B2", "C1", "C2"]);

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

  if (!word) {
    return res.status(400).json({ ok: false, error: "bad_request", detail: "word required" });
  }

  const sHash = sentenceHash(sentence);

  // 4) Tap analytics — fire and forget (surface "coach"), never blocks the answer.
  // Degrades gracefully when Supabase env is missing. No cache read/write here.
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

  // 6) Prompt — friendly coach, learner register, in the target language
  const system = `
You are a warm, encouraging pronunciation and language coach for a ${targetLangName}
learner at CEFR level ${level}.
You get: a word the learner tapped, and the sentence it appeared in.

Rules:
- ${registerNote}
- Answer in 2 to 3 SHORT sentences. Warm and direct, no preamble, no lists.
- Use NO words harder than the learner's ${level} level.
- Explain what the word means IN THIS SENTENCE (pick the sense from context),
  then give ONE concrete tip for using OR pronouncing it.
- Do not repeat the whole sentence back. Speak TO the learner ("you"/"tú").
Output MUST be valid JSON only, with exactly this key:
{ "answer": "<your 2-3 sentence reply>" }
`.trim();

  const user = { word, sentence };

  const MODEL =
    (process.env.LUX_AI_QUICK_MODEL || "").toString().trim() ||
    (process.env.LUX_AI_MODEL || "").toString().trim() ||
    "gpt-4.1-mini";

  // 7) Call model (cheap + friendly, mirrors word-info's json_object + jsonrepair)
  try {
    const resp = await openai.chat.completions.create({
      model: MODEL,
      temperature: 0.5,
      max_tokens: 320,
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

    const answer = (parsed.answer || "").toString().trim().slice(0, 600);
    if (!answer) {
      return res.status(502).json({ ok: false, error: "empty_answer" });
    }

    return res.status(200).json({ ok: true, answer });
  } catch (e) {
    console.error("[coach-ask] model call failed", e);
    return res.status(502).json({ ok: false, error: "model_failed" });
  }
}
