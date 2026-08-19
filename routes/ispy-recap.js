// routes/ispy-recap.js
// One-line: Two sentences describing the photo, at the round's level, using every word the learner just found.
// Endpoint: POST /api/router?route=ispy-recap
//
// The end of a round is a list of nouns. This turns them back into language: the
// same picture, said out loud, with the learner's own haul carrying it. Naming a
// thing and hearing it in a sentence are different halves of knowing the word,
// and until now the game only ever asked for the first.
//
// ONE CALL, AND A CHEAP ONE. Text in, text out, no image. The scan already
// looked at this picture and the caller sends the scene description it was
// grounded on, so paying to re-upload and re-read the photograph would buy a
// second opinion about a scene we already have in words. That keeps this a
// one-to-two second call at the end of a round the learner has finished, rather
// than another vision bill.
//
// The route is deliberately soft about its own failures. A recap is a flourish
// on a round that has already been played and scored; nothing here may 500 into
// a summary screen, so every failure answers 200 with ok:false and a reason and
// the panel simply shows no recap.

const MAX_WORDS = 10;
const MAX_WORD_CHARS = 60;
const MAX_DESCRIPTION_CHARS = 1200;

// A sanity rail on one sentence, not a style rule. Set well above anything the
// prompt asks for (a wordy C2 sentence measured about 230 characters), because a
// cap that bites is a cap that produces a FRAGMENT, and a fragment is worse here
// than in most places: this text is read aloud, so a sentence cut mid-word is
// heard cut mid-word. Anything over the rail is DROPPED rather than trimmed.
const MAX_SENTENCE_CHARS = 400;

const CEFR = new Set(["A1", "A2", "B1", "B2", "C1", "C2"]);

const LANG_NAME = {
  en: "English",
  es: "Spanish (neutral Latin American)",
};

/**
 * How complex the SENTENCES may be.
 *
 * Deliberately not convo-image-targets' LEVEL_GUIDE, which is about which nouns
 * are worth naming. That question is already settled by the time this runs: the
 * words are the ones the learner found. What is open here is the grammar
 * carrying them, and a B1 noun in a C2 sentence is a C2 sentence.
 */
const SENTENCE_GUIDE = {
  A1: "Very short simple sentences. Present tense. No subordinate clauses.",
  A2: "Short simple sentences. Present and past. At most one linking word.",
  B1: "Ordinary sentences of comfortable length. Common connectors are fine.",
  B2: "Natural sentences with some subordination and varied verb forms.",
  C1: "Fluent, well-joined sentences. Precise verbs, natural modification.",
  C2: "Fully idiomatic sentences with the range a native writer would use.",
};

function foldWord(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Did the recap actually use this word?
 *
 * Compared on the folded HEAD of the label rather than the label itself, because
 * the labels carry their article ("a mug", "la taza") and a sentence that says
 * "the mug" has plainly used the word. Accents are folded for the same reason:
 * this is a check on whether the model did as it was told, not a spelling test.
 */
function usedIn(haystack, label) {
  const folded = foldWord(label);
  if (!folded) return true;
  const parts = folded.split(" ");
  // Drop a leading article, in either language, and match on what is left.
  const ARTICLES = new Set(["a", "an", "the", "el", "la", "los", "las", "un", "una", "unos", "unas"]);
  while (parts.length > 1 && ARTICLES.has(parts[0])) parts.shift();
  return haystack.includes(parts.join(" "));
}

function buildPrompt(lang, level, words) {
  const langName = LANG_NAME[lang];
  const guide = SENTENCE_GUIDE[level] || SENTENCE_GUIDE.B1;
  return [
    `You write a two-sentence recap of a photograph for a language learner, in ${langName}.`,
    "",
    "The learner has just played a vocabulary game on this photograph and found",
    "the words listed below. Write TWO sentences that describe the photograph and",
    "that together use EVERY ONE of those words.",
    "",
    `SENTENCE LEVEL: ${guide}`,
    "",
    "Rules:",
    "- Exactly two sentences. Not one, not three.",
    "- Every listed word must appear. This is the whole point of the recap: the",
    "  learner is hearing their own words come back as language. A recap that",
    "  drops one has failed even if it reads well.",
    "- Use the words naturally, in the grammar the sentence needs. The article or",
    "  number may change; the word itself must be recognisably there.",
    "- Describe THIS photograph, from the description given. Do not invent things",
    "  that are not in it, and do not describe the learner or the game.",
    "- Warm and plain. No lists, no markdown, no quotation marks around the words,",
    "  and no praise for the learner.",
    "",
    'Return JSON only: { "sentences": ["...", "..."] }',
  ].join("\n");
}

function buildUser(words, description) {
  const lines = ["Words the learner found, all of which must appear:", ...words.map((w) => `- ${w}`)];
  if (description) {
    lines.push("", "What the photograph shows:", description);
  }
  return lines.join("\n");
}

function soft(reason) {
  return { ok: false, error: reason };
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  // ADMIN_TOKEN gate (cost-control). The router gates this route too; this is
  // defense-in-depth for direct invocation, matching convo-image-targets.
  const token =
    (req.headers["x-admin-token"] || "").toString().trim() ||
    (req.query?.token || "").toString().trim();
  const expected = (process.env.ADMIN_TOKEN || "").toString().trim();
  if (!expected || token !== expected) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  const body = req.body || {};

  // Region-tolerant, the same closed two-value space every other route uses.
  const langRaw = (body.lang || body.pack || "en").toString().trim().toLowerCase();
  const lang = langRaw === "es" || langRaw.startsWith("es-") ? "es" : "en";

  const levelRaw = (body.level || "").toString().trim().toUpperCase();
  const level = CEFR.has(levelRaw) ? levelRaw : "B1";

  const words = (Array.isArray(body.words) ? body.words : [])
    .map((w) => String(w || "").trim().slice(0, MAX_WORD_CHARS))
    .filter(Boolean)
    .slice(0, MAX_WORDS);

  const description = (body.description || "").toString().trim().slice(0, MAX_DESCRIPTION_CHARS);

  // One word is not a recap, it is a sentence with a noun in it. Two is the
  // floor at which "using every found word" means anything.
  if (words.length < 2) return res.status(200).json(soft("too_few_words"));

  let OpenAI;
  let jsonrepair;
  try {
    ({ OpenAI } = await import("openai"));
    ({ jsonrepair } = await import("jsonrepair"));
  } catch (e) {
    console.error("[ispy-recap] init error", e?.message || e);
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
      // Not 0. Two sentences at temperature 0 come back with the same shape
      // every time, and a learner who plays three photographs in a row would
      // hear the same sentence skeleton three times.
      temperature: 0.6,
      // Room for two long sentences plus the JSON around them. At 300 a wordy C2
      // pair came back with the closing brace cut off, which jsonrepair salvages
      // into a truncated second sentence rather than failing loudly.
      max_tokens: 400,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: buildPrompt(lang, level, words) },
        { role: "user", content: buildUser(words, description) },
      ],
    });
    const raw = resp?.choices?.[0]?.message?.content || "{}";
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = JSON.parse(jsonrepair(raw));
    }
  } catch (e) {
    console.warn("[ispy-recap] model call failed:", e?.message || e);
    return res.status(200).json(soft("model_failed"));
  }

  const sentences = (Array.isArray(parsed?.sentences) ? parsed.sentences : [])
    .map((s) => String(s || "").trim())
    .filter((s) => s && s.length <= MAX_SENTENCE_CHARS)
    .slice(0, 2);

  if (!sentences.length) return res.status(200).json(soft("no_recap"));

  const text = sentences.join(" ");
  // Which words did not make it. Reported rather than repaired: a second call to
  // patch a missing noun would double the cost of a flourish, and the honest
  // answer to "the model dropped one" is a log line that says so and a recap
  // that is still worth hearing.
  const missing = words.filter((w) => !usedIn(foldWord(text), w));
  if (missing.length) {
    console.log(
      `[ispy-recap] ${missing.length}/${words.length} word(s) missing from recap ` +
        `(lang=${lang} level=${level}): ${missing.join(", ")}`,
    );
  }

  return res.status(200).json({
    ok: true,
    lang,
    level,
    sentences,
    text,
    missing,
    tookMs: Date.now() - started,
  });
}
