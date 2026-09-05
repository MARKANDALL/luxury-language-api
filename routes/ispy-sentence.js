// routes/ispy-sentence.js
// One-line: Judges one learner sentence built around one word, and says something specific about it.
// Endpoint: POST /api/router?route=ispy-sentence
//
// The speaking bridge is the game's only PRODUCTION moment. Everything else asks
// the learner to recognise or recall a noun; this asks them to use it. Its whole
// response used to be "you used it, that is what the word is for", which is the
// same sentence whatever they said, and a response that cannot vary is not
// feedback, it is a chime with words on it. That is why it read as gimmicky.
//
// So it now judges two separate things and says one short line about the second:
// was the word used CORRECTLY, and what is specifically true of THIS sentence.
//
// ONE CHEAP CALL, text in and text out, exactly like ispy-recap: no image, no
// scene, nothing to upload. Measured on that route's identical shape at one to
// two seconds.
//
// Soft about every failure, also like ispy-recap. This sits at the end of a
// round that has already been played and scored, so nothing here may 500 into a
// summary screen: the caller falls back to the old local check, which is the
// behaviour that was there before this route existed.

const MAX_WORD_CHARS = 60;
const MAX_SENTENCE_CHARS = 300;
const MAX_NOTE_CHARS = 160;

const CEFR = new Set(["A1", "A2", "B1", "B2", "C1", "C2"]);

// Lux teaches American English, and leaving that to the model's default is how
// "a passenger queue" reached a learner on an airport scene where the word is
// "a line". Said out loud here as well as in the targets route, because a recap
// and a bridge sentence are read as the game's own voice.
const AMERICAN = "Use AMERICAN English throughout: a line not a queue, a faucet, a trash can, an elevator, a sweater, pants, sneakers, a parking lot, a sidewalk. American spelling: color, gray, traveler, center.";

const LANG_NAME = {
  en: "English",
  es: "Spanish (neutral Latin American)",
};

/**
 * How the note itself should read, per band.
 *
 * The learner reads this, so it obeys the same rule the clue sentences and the
 * scene recap obey: a note about an A1 sentence written at C2 is a C2 sentence,
 * and the band of the feedback is the band of the lesson.
 */
const NOTE_BAND = {
  A1: "Very short and very plain. Present tense. Max 10 words.",
  A2: "Short and plain. Max 12 words.",
  B1: "One ordinary sentence. Max 16 words.",
  B2: "One natural sentence. Max 18 words.",
  C1: "One fluent, precise sentence. Max 20 words.",
  C2: "One idiomatic sentence with real range. Max 20 words.",
};

function buildPrompt(lang, level) {
  const langName = LANG_NAME[lang];
  const band = NOTE_BAND[level] || NOTE_BAND.B1;
  return [
    `A language learner has been asked to say one sentence using a given word.`,
    `You judge it and reply in ${langName}.` + (lang === "en" ? ` ${AMERICAN}` : ""),
    "",
    "Return JSON: { \"correct\": true|false, \"note\": \"...\" }",
    "",
    '"correct" is ONLY about the target word: did they use THAT WORD, and use it',
    "in a way that is genuinely right for what the word means and how it behaves",
    "in a sentence. A sentence with a wrong tense elsewhere, a missing article",
    "elsewhere, or an odd but understandable phrasing is still correct if the",
    "TARGET WORD is used properly. Mark it false when the word is absent, when it",
    "is used to mean something it does not mean, or when it is forced into a",
    "grammatical slot it cannot take.",
    "",
    '"note" is ONE short line, and it must be SPECIFIC TO THIS SENTENCE. Quote or',
    "name something they actually did. Generic praise is the failure this",
    "replaces: never write anything that would be equally true of a different",
    "sentence.",
    `NOTE LEVEL: ${band}`,
    "",
    "When it is correct, say what worked, in their own words where you can.",
    "When it is not, say plainly what went wrong with the word and give the",
    "shortest fix. Never scold, never lecture, never list more than one problem:",
    "this is the last thing in a round they finished, and it is optional.",
  ].join("\n");
}

function soft(reason) {
  return { ok: false, error: reason };
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  const token =
    (req.headers["x-admin-token"] || "").toString().trim() ||
    (req.query?.token || "").toString().trim();
  const expected = (process.env.ADMIN_TOKEN || "").toString().trim();
  if (!expected || token !== expected) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  const body = req.body || {};
  const langRaw = (body.lang || body.pack || "en").toString().trim().toLowerCase();
  const lang = langRaw === "es" || langRaw.startsWith("es-") ? "es" : "en";
  const levelRaw = (body.level || "").toString().trim().toUpperCase();
  const level = CEFR.has(levelRaw) ? levelRaw : "B1";

  const word = (body.word || "").toString().trim().slice(0, MAX_WORD_CHARS);
  const sentence = (body.sentence || "").toString().trim().slice(0, MAX_SENTENCE_CHARS);
  if (!word || !sentence) return res.status(200).json(soft("nothing_to_judge"));

  let OpenAI;
  let jsonrepair;
  try {
    ({ OpenAI } = await import("openai"));
    ({ jsonrepair } = await import("jsonrepair"));
  } catch (e) {
    console.error("[ispy-sentence] init error", e?.message || e);
    return res.status(200).json(soft("init_error"));
  }
  if (!process.env.OPENAI_API_KEY) return res.status(200).json(soft("init_error"));

  const MODEL =
    (process.env.LUX_AI_QUICK_MODEL || "").toString().trim() ||
    (process.env.LUX_AI_MODEL || "").toString().trim() ||
    "gpt-4.1-mini";

  const started = Date.now();
  let parsed;
  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const resp = await openai.chat.completions.create({
      model: MODEL,
      // Low but not zero. The judgement should be stable; the note should not be
      // the same sentence every time, which is the whole complaint being fixed.
      temperature: 0.4,
      max_tokens: 200,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: buildPrompt(lang, level) },
        { role: "user", content: `Target word: ${word}\nTheir sentence: ${sentence}` },
      ],
    });
    const raw = resp?.choices?.[0]?.message?.content || "{}";
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = JSON.parse(jsonrepair(raw));
    }
  } catch (e) {
    console.warn("[ispy-sentence] model call failed:", e?.message || e);
    return res.status(200).json(soft("model_failed"));
  }

  const note = String(parsed?.note || "").trim().replace(/\s+/g, " ").slice(0, MAX_NOTE_CHARS);
  if (!note) return res.status(200).json(soft("no_note"));

  return res.status(200).json({
    ok: true,
    lang,
    level,
    correct: parsed?.correct === true,
    note,
    tookMs: Date.now() - started,
  });
}
