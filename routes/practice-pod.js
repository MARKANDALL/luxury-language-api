// routes/practice-pod.js
// One-line: Practice pod — a type-aware ladder of five short, sayable lines for one saved word.
//
// The frontend's practice pod is a drawer where a learner works ONE saved word by
// recording and scoring five short utterances in a row. This route generates that
// ladder. The pedagogy is deliberate: short repeatable lines the learner can say
// in one breath, ordered easy to hard, and shaped by what KIND of word it is — a
// verb needs its conjugations, a noun needs its plural and its article, a fixed
// phrase needs a chunk-to-whole build-up. A single generic "use it in a sentence"
// prompt teaches none of that.
//
// Cloned from routes/word-image.js: same CORS + admin-token gate, same cheap-model
// config (LUX_AI_QUICK_MODEL -> LUX_AI_MODEL -> gpt-4.1-mini), same temperature 0 +
// json_object + jsonrepair parsing, same never-throw degradation. It does NOT touch
// the coach-ask lens map — coach-ask has its own `depth` param and this is a
// separate route.
//
// Contract (POST /api/practice-pod):
//   Request:  { word, lang, l1, level, uid, depth }
//   Response: { ok: true, wordType, lines: [ { text, focus }, ... ] }   (<= 5)
//
//   - wordType is one of "verb" | "noun" | "adjective" | "phrase" | "other".
//   - Exactly 5 lines when the model cooperates, never more. Each `text` is ONE
//     short natural utterance (roughly 4-10 words) containing the target word or
//     an inflected form of it. `focus` is a 2-to-4-word label of what that line
//     exercises — UI metadata, not practice material, so it is written in the
//     learner's L1 when an `l1` is given that differs from `lang`.
//   - Ladder order is part of the contract: lines run easiest to hardest.
//   - This route NEVER throws to the caller. On any failure it returns
//     { ok:true, wordType:"other", lines:[], reason:"<short code>" } so the drawer
//     degrades to a friendly empty state instead of showing an error.
//   - Determinism replaces caching for v1 (temperature 0): reopening the pod on the
//     same word gives the same ladder, which is the point — a drill the learner
//     cannot re-run identically is not a drill.
//
// Depth (optional `depth`, default 1):
//   depth 2 is the learner asking for a harder set of the SAME word: longer
//   utterances, faster-feeling rhythm, subordinate clauses — one clear notch up,
//   and DIFFERENT sentences rather than the depth-1 set with words bolted on. The
//   type shape is unchanged (a verb ladder stays a verb ladder). Absent or
//   unrecognised depth takes the depth-1 path with the base prompt untouched.

export const config = {
  api: {
    bodyParser: true,
    externalResolver: true,
  },
};

// Exactly five rungs: enough to feel like a ladder, few enough to finish in one
// sitting. The cap is enforced here, not trusted to the model.
const MAX_LINES = 5;
// Below this a "ladder" is not a ladder — a one-line pod is worse than the empty
// state, so a thin result degrades rather than half-renders.
const MIN_LINES = 2;

// Defensive caps on the model's strings. Generous enough that a legitimate line
// (a 14-word depth-2 Spanish sentence) is never truncated.
const MAX_TEXT_CHARS = 200;
const MAX_FOCUS_CHARS = 80;

const MAX_TOKENS = 600;

const WORD_TYPES = new Set(["verb", "noun", "adjective", "phrase", "other"]);

// Map the incoming l1 code to a readable language name for the prompt (mirrors the
// L1_NAMES map coach-ask uses for its contrast lens). Fallback is the raw l1
// string, so an unlisted code still names a language to the model.
const L1_NAMES = {
  es: "Spanish",
  en: "English",
  pt: "Portuguese",
  fr: "French",
  de: "German",
  it: "Italian",
  zh: "Chinese",
};

const CEFR_VALUES = new Set(["A1", "A2", "B1", "B2", "C1", "C2"]);

// The graceful empty shape. Unlike word-image there is no legitimate "success with
// nothing to show" here — every word can be laddered — so every empty result
// carries a reason code naming what went wrong.
function empty(reason) {
  return { ok: true, wordType: "other", lines: [], reason };
}

// Strict validation of the model's `lines`. Anything that is not an object with a
// non-empty STRING text and a non-empty STRING focus is dropped rather than
// patched: a malformed rung would render as a blank recording target. Dropping
// happens before the cap, so five good lines survive four bad ones.
function shapeLines(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    if (typeof item.text !== "string" || typeof item.focus !== "string") continue;
    const text = item.text.trim();
    const focus = item.focus.trim();
    if (!text || !focus) continue;
    out.push({
      text: text.slice(0, MAX_TEXT_CHARS),
      focus: focus.slice(0, MAX_FOCUS_CHARS),
    });
    if (out.length === MAX_LINES) break;
  }
  return out;
}

export default async function handler(req, res) {
  // 1) CORS / method (mirrors word-image)
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  // 2) ADMIN_TOKEN gate (cost-control), same as word-image. The router also gates
  //    this route; this is defense-in-depth for direct invocation.
  const token =
    (req.headers["x-admin-token"] || "").toString().trim() ||
    (req.query?.token || "").toString().trim();
  const expected = (process.env.ADMIN_TOKEN || "").toString().trim();
  if (!expected || token !== expected) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  // 3) Validate input. `uid` is accepted for contract compatibility (the frontend
  //    sends it) but the ladder does not depend on it — nothing is logged here.
  const body = req.body || {};
  const word = (body.word || "").toString().trim().slice(0, 60);
  const lang = (body.lang || "en").toString().trim() === "es" ? "es" : "en";
  const targetLangName = lang === "es" ? "Spanish" : "English";

  const levelRaw = (body.level || "B1").toString().trim().toUpperCase();
  const level = CEFR_VALUES.has(levelRaw) ? levelRaw : "B1";

  // The `focus` labels are UI captions, so they are most useful in the learner's
  // first language. That only applies when an l1 is actually given AND differs
  // from the language being practised; otherwise the labels stay in the target
  // language (where l1 === lang the two are the same thing anyway).
  const l1 = (body.l1 || "").toString().trim().slice(0, 24).toLowerCase();
  const l1IsUseful = !!l1 && l1 !== "universal" && l1 !== lang;
  const focusLangName = l1IsUseful ? L1_NAMES[l1] || l1 : targetLangName;

  // depth 2 = "give me a harder one"; anything else -> 1 (same normalisation as
  // coach-ask's depth).
  const depth = Number(body.depth) === 2 ? 2 : 1;

  // No word, no ladder — degrade gracefully (the contract is "always 200, never
  // throw") so the drawer shows its empty state.
  if (!word) {
    return res.status(200).json(empty("no_word"));
  }

  // 4) Imports & init (mirrors word-image). On any init failure we degrade to the
  //    empty shape rather than 500 — this route never throws to the caller. The
  //    OpenAI client is constructed INSIDE this guard on purpose: the openai v4
  //    constructor throws synchronously when OPENAI_API_KEY is missing, and that
  //    throw must degrade to the empty shape, not surface as a 500.
  let jsonrepair, openai;
  try {
    const modAI = await import("openai");
    const modRepair = await import("jsonrepair");
    jsonrepair = modRepair.jsonrepair;
    openai = new modAI.OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  } catch (e) {
    console.error("[practice-pod] init error", e);
    return res.status(200).json(empty("init_error"));
  }

  const MODEL =
    (process.env.LUX_AI_QUICK_MODEL || "").toString().trim() ||
    (process.env.LUX_AI_MODEL || "").toString().trim() ||
    "gpt-4.1-mini";

  // ── Classify + build the ladder, in ONE model call ──────────────────────────
  // Classification and generation are the same judgement (you cannot order a verb
  // ladder without knowing it is a verb), so splitting them into two calls would
  // double the cost to re-derive the same fact. Temperature 0 keeps the pod
  // reproducible across visits.
  const BASE_SYSTEM = `
You build a PRACTICE LADDER: five short lines a language learner says out loud,
one after another, to drill ONE saved word.

You get the WORD, the language it is in, the learner's CEFR level, and the
language to write the focus labels in. Return JSON only — no markdown.

Do two things:

1. wordType (string): classify the word as exactly one of
   "verb" | "noun" | "adjective" | "phrase" | "other".
   - phrase = a multi-word chunk: a collocation, an idiom, a fixed expression.
   - other = adverbs, function words, and anything that fits nowhere else.

2. lines (array): EXACTLY 5 objects, each { "text": ..., "focus": ... }.
   - text: ONE short natural utterance in ${targetLangName}, roughly 4 to 10
     words, that a learner can say in a single breath. It MUST contain the word
     itself or an inflected form of it. Plain sentence only — no quotation marks,
     no list markers, no explanation, no translation.
   - focus: a 2-to-4-word label naming what that line exercises, written in
     ${focusLangName}. This is a caption for the app UI, not practice material.
   - ORDER MATTERS. The ladder runs easiest to hardest: line 1 is the shortest
     and simplest, line 5 the longest and most demanding.
   - Natural, speakable, and level-appropriate for CEFR ${level}. Real speech,
     not textbook filler.

Shape the ladder to the wordType you chose:

- verb: the SAME verb across different conjugations and tenses, each in a tiny
  context — base form, third person, past, progressive, perfect — adapted to what
  the language actually does. In Spanish, use tu-register forms (tú, not usted)
  among the natural mix.
- noun: the noun in different forms and slots — singular, plural (get irregular
  plurals right), with an article, and inside a question.
- adjective: attributive, then predicative, then comparative, then a question. In
  Spanish the set must show gender and number agreement changing across the lines.
- phrase: a chunk-to-whole build-up. Line 1 is the core chunk of the phrase on its
  own; each line adds a little more; the last line puts the FULL phrase inside a
  longer natural sentence.
- other: five short natural sentences using the word, graded from shortest to
  longest.

Output MUST be valid JSON only, with exactly these keys:
{ "wordType": "verb", "lines": [ { "text": "...", "focus": "..." } ] }
`.trim();

  // Appended for depth 2 only, so a depth-1 request sends the base prompt exactly.
  const DEPTH_2_SYSTEM = `
DEPTH: 2

The learner has already worked the basic ladder for this word and wants a harder
one. Keep the same wordType and the same type shape above, but move one clear
notch up:

- Longer utterances, roughly 8 to 14 words, with more to hold in the mouth.
- Faster-feeling rhythm: contractions, linking, weak forms, and function-word
  clusters the learner has to get through without stalling.
- At least two lines carry a subordinate clause.
- The lines must be DIFFERENT sentences from the basic ladder — new contexts and
  new sentences, NOT the basic lines with words bolted on.
- Still natural, still sayable in one breath, still ordered easiest to hardest.
`.trim();

  const system = depth === 2 ? BASE_SYSTEM + "\n\n" + DEPTH_2_SYSTEM : BASE_SYSTEM;

  const userPayload = {
    word,
    language: targetLangName,
    level,
    focusLanguage: focusLangName,
    depth,
  };

  let resp;
  try {
    resp = await openai.chat.completions.create({
      model: MODEL,
      temperature: 0, // determinism: the same word must ladder the same way
      max_tokens: MAX_TOKENS,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(userPayload) },
      ],
    });
  } catch (e) {
    console.error("[practice-pod] model call failed", e?.message || e);
    return res.status(200).json(empty("model_failed"));
  }

  const raw = resp?.choices?.[0]?.message?.content || "{}";
  let parsed;
  try {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = JSON.parse(jsonrepair(raw));
    }
  } catch (e) {
    console.warn("[practice-pod] could not parse model JSON", e?.message || e);
    return res.status(200).json(empty("bad_model_json"));
  }

  const lines = shapeLines(parsed?.lines);

  // A ladder too thin to climb is a failure, not a result: send the empty shape so
  // the drawer shows its empty state rather than a one-rung pod.
  if (lines.length < MIN_LINES) {
    console.warn(
      `[practice-pod] only ${lines.length} usable line(s) for "${word}" — degrading`
    );
    return res.status(200).json(empty("bad_model_json"));
  }

  // An unrecognised wordType is not worth failing a good ladder over — the lines
  // are the product, the type is a label the UI shows — so it normalises to
  // "other" and the ladder still ships.
  const wordTypeRaw = (parsed?.wordType || "").toString().trim().toLowerCase();
  const wordType = WORD_TYPES.has(wordTypeRaw) ? wordTypeRaw : "other";

  return res.status(200).json({ ok: true, wordType, lines });
}
