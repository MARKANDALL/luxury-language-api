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

// The sentinel row convo-image-targets caches its band-free inventory under.
// Duplicated deliberately rather than imported: that route is a 3000-line module
// with an OpenAI client at the top, and a recap should not pull it in to read
// three columns. Any change to these three must change both.
const INVENTORY_LANG_KEY = "xx";
const INVENTORY_LEVEL_KEY = "__inv1";
const INV_V = 101;

/**
 * What this photograph actually contains, from the cached inventory.
 *
 * THE FIX FOR THE PARKING LOT. The recap was given only the learner's found
 * words and whatever description the caller happened to have, and a still has
 * none, so the model was asked to describe a photograph it had been told
 * nothing about. It did what anyone would do and invented a plausible one:
 * reproduced here as a passenger waiting on a sidewalk for a bus that "arrives
 * and stops to pick up the passenger", for a photograph taken inside the bus.
 *
 * The inventory is the fullest account of a picture this system holds: sixty to
 * ninety nameable things, looked at once by a vision pass and stored per image.
 * One indexed read, and it is the difference between describing THIS photograph
 * and describing a photograph.
 */
async function sceneInventory(imageKey) {
  if (!imageKey) return null;
  try {
    // Imported here, not at the top: this route has no top-level imports by
    // design, and a caller with no imageKey should not pay for a db client.
    const { getSupabaseAdmin } = await import("../lib/supabase.js");
    const sb = getSupabaseAdmin();
    const { data, error } = await sb
      .from("image_targets")
      .select("targets, v")
      .eq("image_key", imageKey)
      .eq("lang", INVENTORY_LANG_KEY)
      .eq("level", INVENTORY_LEVEL_KEY)
      .maybeSingle();
    if (error || data?.v !== INV_V || !Array.isArray(data?.targets)) return null;
    return data.targets;
  } catch (e) {
    // No inventory is not a failure: the recap keeps the caution it now carries
    // in its prompt and stays inside the found words.
    console.warn("[ispy-recap] inventory read failed:", e?.message || e);
    return null;
  }
}

/**
 * Words the recap may use that name nothing in the picture.
 *
 * Function words, pronouns, the copula, the handful of verbs a two-sentence
 * description needs, and the qualities anything can have. Deliberately generous:
 * this list exists to keep the check off GRAMMAR, and the check is only ever
 * asked about the nouns that are left.
 */
const RECAP_FREE = new Set(
  ("a an the this that these those and or but so as at by for from in into of off on onto out over to " +
   "under up with without near beside behind between while during after before " +
   "is are was were be been being has have had do does did will would can could " +
   "he she it they them his her its their him you your we our i me my one two three " +
   "there here now then very quite just also both each other another same " +
   "look looks looking see sees seen watch watches watching hold holds holding " +
   "wear wears wearing sit sits sitting stand stands standing walk walks walking " +
   "smile smiles smiling talk talks talking read reads reading carry carries carrying " +
   "seem seems appear appears wait waits waiting ride rides riding travel travels " +
   "next close closely together while front back left right side middle " +
   "small large big little long short tall wide narrow bright dark light heavy " +
   "old new young warm cold soft hard clean dirty busy quiet calm " +
   "red orange yellow green blue purple pink brown black white gray grey silver gold " +
   "person people man woman someone something everything nothing " +
   "photo photograph picture image scene moment day morning afternoon evening " +
   "his hers theirs ours mine")
    .split(/\s+/)
    .filter(Boolean),
);

/** Accent- and case-free tokens of a string. */
function tokens(v) {
  return String(v || "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .split(/[^\p{Letter}]+/u)
    .filter(Boolean);
}

/**
 * Everything the recap is ALLOWED to name, as a token set.
 *
 * The learner's found words, the scene description when there is one, and the
 * cached INVENTORY, which is the fullest and most reliable account of what is
 * in the photograph that this system has: sixty to ninety nameable things,
 * looked at once and stored per image.
 */
function allowedTokens(words, description, inventory) {
  const out = new Set(RECAP_FREE);
  for (const w of words || []) for (const tk of tokens(w)) out.add(tk);
  for (const tk of tokens(description)) out.add(tk);
  for (const e of inventory || []) for (const tk of tokens(e?.gloss)) out.add(tk);
  return out;
}

/**
 * Which words in a recap name something nobody can vouch for.
 *
 * THE FAILURE THIS CATCHES. Given no scene context the model writes a plausible
 * stock vignette: Mark's recap of a bus interior placed it in a parking lot with
 * an elevator, a trash can and a faucet, and an unguided reproduction here had
 * a passenger waiting on a sidewalk for a bus that "arrives and stops to pick
 * up the passenger", for a photograph taken inside the moving bus.
 *
 * Only plausible NOUNS are judged: short words, adverbs and participles are let
 * through, because the goal is to catch invented THINGS and not to grade
 * grammar. A word that survives all of that and is still in nothing the system
 * knows about the picture is an invention.
 */
function untruths(sentences, allow) {
  const bad = new Set();
  for (const line of sentences || []) {
    const tk = tokens(line);
    for (let i = 1; i < tk.length; i++) {
      // ONLY WHAT THE RECAP NAMES. A word introduced by a determiner is a thing
      // being named; everything else is grammar, and grading grammar here
      // produced refusals for "uses", "where", "held" and "along" while the
      // actual inventions sat beside them. This asks the narrow question the
      // law asks: is every setting or object it NAMES either a found word or
      // really in the picture?
      if (!DETERMINERS.has(tk[i - 1])) continue;
      // An adjective can sit between the determiner and the noun ("a busy
      // street"), so the noun may be one or two words along; both are checked
      // and either being known clears the phrase, because "a red bus" is about
      // the bus.
      const head = tk[i + 1] && !DETERMINERS.has(tk[i + 1]) ? [tk[i], tk[i + 1]] : [tk[i]];
      if (head.some((w) => known(w, allow))) continue;
      bad.add(head[head.length - 1]);
    }
  }
  return [...bad];
}

/** Is this word, or its obvious singular, something we can vouch for? */
function known(w, allow) {
  if (!w || w.length <= 2) return true;
  // Adverbs and participles are grammar wearing a noun's position ("sat
  // quietly", "the waiting passengers"). They name nothing, so they are never
  // an invention.
  if (w.endsWith("ly") || w.endsWith("ing") || w.endsWith("ed")) return true;
  if (allow.has(w)) return true;
  if (w.endsWith("s") && allow.has(w.slice(0, -1))) return true;
  if (w.endsWith("es") && allow.has(w.slice(0, -2))) return true;
  return false;
}

/** The words that introduce a named thing. */
const DETERMINERS = new Set([
  "a", "an", "the", "this", "that", "these", "those",
  "his", "her", "its", "their", "our", "your", "my",
  "another", "each", "every", "some", "one", "two", "three",
]);


function buildPrompt(lang, level, words) {
  const langName = LANG_NAME[lang];
  const guide = SENTENCE_GUIDE[level] || SENTENCE_GUIDE.B1;
  return [
    `You write a two-sentence recap of a photograph for a language learner, in ${langName}.` +
      (lang === "en" ? ` ${AMERICAN}` : ""),
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
    "- Describe THIS photograph and NOTHING ELSE. Everything you name must be in",
    "  the list of found words or in what the photograph shows below. If you are",
    "  not told where the scene is, DO NOT DECIDE where it is: say what the words",
    "  let you say and stop. A recap that places the scene somewhere it is not is",
    "  worse than a short one, and it is the one failure this feature cannot have.",
    "- Do not describe the learner or the game.",
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
  const imageKey = (body.imageKey || "").toString().trim().slice(0, 64);

  // One word is not a recap, it is a sentence with a noun in it. Two is the
  // floor at which "using every found word" means anything.
  if (words.length < 2) return res.status(200).json(soft("too_few_words"));

  const inventory = await sceneInventory(imageKey);

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
        { role: "user", content: buildUser(words, description, inventory) },
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

  // THE TRUTH GATE. Everything the recap names has to be a found word or
  // something the picture actually contains, and this is the last place it can
  // be stopped. A recap that places a bus interior in a parking lot with an
  // elevator, a trash can and a faucet is not a flourish that went wrong: it is
  // the never-lie law broken inside the feature Mark likes most, and it is
  // better to show no recap than a confident false one. The frontend already
  // hides the box when there is no text, so refusing costs a nicety and keeps
  // the promise.
  const invented = untruths(sentences, allowedTokens(words, description, inventory));
  if (invented.length) {
    console.log(
      `[ispy-recap] REFUSED, ${invented.length} invented word(s) ` +
        `(lang=${lang} level=${level} scene=${inventory ? inventory.length : 0} entries): ${invented.join(", ")}`,
    );
    return res.status(200).json(soft("invented_scene"));
  }

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
