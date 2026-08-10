// routes/convo-image-targets.js
// One-line: I Spy / Veo veo — find the nameable things in a conversation image
// and turn each one into a vocabulary target the learner can be pointed at.
//
// The convo gallery can start an optional vocabulary game on any image the
// conversation generated. The game needs, per image, a small set of things worth
// naming: WHERE each one is (so a marker can point at it), WHAT it is called in
// the target language (with its article — the article is half the word in
// Spanish), a cloze sentence that can be offered as the first hint, and four
// options for the last hint. This route produces that set in ONE vision call and
// caches it, because the set is a property of the image and never changes.
//
// Cloned from the routes/word-info.js skeleton: same CORS + admin-token gate,
// same LUX_AI_QUICK_MODEL -> LUX_AI_MODEL -> gpt-4.1-mini chain, same
// json_object + jsonrepair parsing, same Supabase cache-read / model /
// cache-write shape, same `v`-stamp trick for invalidating a stale schema
// without a migration.
//
// Contract (POST /api/convo-image-targets):
//   Request:  { imageUrl, imageKey?, description?, lang }
//     imageUrl    — the image itself: a data: URI (what /api/convo-image
//                   returns) or an http(s) URL. Required on a cache MISS; it is
//                   also what the cache key is derived from when imageKey is
//                   absent, so in practice always send it.
//     imageKey    — optional caller-supplied stable id for this image. When
//                   present it IS the cache key, so a caller that can identify
//                   its own images keeps a stable key even if the bytes are
//                   re-encoded — which also lets it PROBE the cache with the key
//                   alone and skip uploading megabytes on a replay. Otherwise
//                   the key is derived here, and a client that wants to
//                   reproduce it must match this exactly: the lowercase hex
//                   SHA-256 of the imageUrl STRING (not the decoded bytes),
//                   truncated to its first 32 characters. Hash anything else —
//                   the bytes, a re-encoded URI, the full digest — and every
//                   replay silently misses and re-bills a vision call.
//     description — the scene description already stored on the image record
//                   (convo-render.js keeps it on the .lux-convoImage wrapper as
//                   data-description). Pure grounding: it steers the model
//                   toward the things the scene is actually about.
//     lang        — active pack: "es" or "en" (default). Decides the language of
//                   every string the model returns. `pack` is accepted as an
//                   alias: this repo carries the same concept under two names
//                   (the word-motor routes read `lang`, most others read
//                   `pack`), so this route reads `body.lang || body.pack` the
//                   way coach-page.js already does rather than picking a side
//                   and making the caller guess. Case and region are forgiven
//                   too — "ES" and "es-MX" are Spanish. Silently dealing an
//                   English round to a Spanish learner is the worst possible
//                   failure here, because nothing about it looks like an error.
//
//   Response: { ok: true, cached: boolean, imageKey, lang, targets: [ {
//                 label,      // target-language noun WITH its article ("la taza")
//                 point,      // { x, y } normalized 0..1 within the image
//                 cloze,      // natural sentence with a ___ blank
//                 choices,    // the answer + up to 3 plausible distractors
//                 answerIndex,// index of `label` inside `choices`
//                 difficulty  // "easy" | "medium" | "hard"
//               } ] }
//
//   - This route NEVER throws to the caller. The game is optional, so on any
//     internal failure it returns { ok:true, cached:false, targets:[],
//     reason:"<short code>" } and the gallery simply doesn't offer the game for
//     that image. The only non-200s are the admin gate (401) and a wrong method
//     (405) — both of which are caller bugs, not degradations.
//   - Determinism, as in word-image: temperature 0, and the choice order is a
//     stable hash-derived shuffle rather than Math.random, so the same image
//     always produces the same round even if the cache is cleared.
//
// WHICH MODEL, and why not Gemini: routes/convo-image.js talks to Gemini, but
// that client is wired to the image-GENERATION previews
// (gemini-3.1-flash-image-preview / gemini-3-pro-image-preview) — it makes
// pictures, it does not return strict JSON about them. Every route in this repo
// that reads something and returns strict JSON uses the OpenAI client with the
// LUX_AI_QUICK_MODEL -> LUX_AI_MODEL -> gpt-4.1-mini chain, and that chain is
// vision-capable: an image is passed as an image_url content part, and a data:
// URI is accepted verbatim. So this route reuses the repo's JSON model client
// and feeds it the same image bytes convo-image.js works with. Set
// LUX_AI_VISION_MODEL to pin a different vision model without a code change.
//
// CACHE: table image_targets, keyed (image_key, lang). See
// migrations/0005_image_targets.sql. Degrades gracefully when Supabase env is
// missing (the route still works, it just pays for the model every time).
//
// SIZE — READ THIS BEFORE WRITING A CALLER. A 1024² PNG data URI runs 2-3 MB,
// and the platform rejects a function body over ~4.5 MB AT THE EDGE, before this
// route runs at all. So MAX_IMAGE_CHARS is not a substitute for the caller
// behaving: it is deliberately set BELOW the platform ceiling so there is a real
// window in which an oversized image degrades to reason:"image_too_large"
// instead of surfacing as an opaque 413 the client has to special-case. Past the
// platform ceiling nothing here can help — the request never arrives.
//
// The caller's job is therefore to downscale before sending. A ~768px JPEG is
// plenty for this task, keeps the body an order of magnitude under every limit,
// and cuts the vision bill. A caller that also wants to skip the upload entirely
// on a replay should send `imageKey` alone (see above) — a cache hit needs no
// image bytes at all.

import crypto from "node:crypto";

export const config = {
  api: {
    bodyParser: true,
    externalResolver: true,
  },
};

// Bump when the target shape changes. A cached row stamped with an older v is
// treated as a MISS and overwritten in place — the same no-migration
// invalidation trick word-info.js plays with card.v.
const TARGETS_V = 1;

const MIN_TARGETS = 5;
const MAX_TARGETS = 8;

// A target needs the answer plus at least two distractors for the final hint to
// still be a real choice. Four is what we ask for; three is the graceful floor,
// because dropping an otherwise-perfect target (good point, good cloze) over one
// duplicated distractor costs the learner a word for no reader-visible gain.
const MIN_CHOICES = 3;
const MAX_CHOICES = 4;

// Keep the marker off the very edge so a 28px dot is never half outside the
// frame. Points outside [0,1] are INVALID (dropped); a valid point inside the
// image is only nudged in from the rim.
const POINT_INSET = 0.03;

const DIFFICULTY_VALUES = new Set(["easy", "medium", "hard"]);

// Deliberately under the ~4.5 MB platform body cap, so this guard is REACHABLE:
// an image between here and the cap degrades gracefully instead of 413-ing at
// the edge where the route never sees it. Past the cap, nothing here runs.
const MAX_IMAGE_CHARS = 3_500_000;

const MAX_DESCRIPTION_CHARS = 2000;

// Leading articles, per pack. Stripped only to compare two labels for sameness
// and to catch a cloze that leaks its own answer — never from the label itself,
// which keeps its article because the article is part of the word being taught.
const ARTICLES = {
  en: ["the", "a", "an"],
  es: ["el", "la", "los", "las", "un", "una", "unos", "unas"],
};

// The graceful empty shape. `reason` is attached for internal failures
// (no_image, model_failed, ...); it is absent when the model simply found
// nothing nameable, which is a success.
function empty(imageKey, lang, reason) {
  const out = { ok: true, cached: false, imageKey, lang, targets: [] };
  if (reason) out.reason = reason;
  return out;
}

function sha256(s) {
  return crypto.createHash("sha256").update(String(s || ""), "utf8").digest("hex");
}

/** Accent- and case-insensitive form, for comparing two words for sameness. */
function fold(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The label without its leading article: "la taza" -> "taza". */
function headNoun(label, lang) {
  const folded = fold(label);
  if (!folded) return "";
  const parts = folded.split(" ");
  if (parts.length > 1 && ARTICLES[lang].includes(parts[0])) return parts.slice(1).join(" ");
  return folded;
}

/**
 * Where `needle` (a folded, possibly multi-word phrase) appears in `words` as
 * whole words, or -1. Whole-word matching on folded tokens is what keeps "taza"
 * from matching inside another word, and it handles multi-word heads ("coffee
 * cup") that a single-token comparison would miss entirely.
 */
function findPhrase(words, needle) {
  const parts = String(needle || "").split(" ").filter(Boolean);
  if (!parts.length) return -1;
  for (let i = 0; i + parts.length <= words.length; i++) {
    let hit = true;
    for (let j = 0; j < parts.length; j++) {
      if (fold(words[i + j]) !== parts[j]) {
        hit = false;
        break;
      }
    }
    if (hit) return i;
  }
  return -1;
}

/**
 * Stable, seeded ordering. The answer must not always sit in the same slot, but
 * the round must be identical every time this image is played, so the order
 * comes from a hash rather than Math.random.
 */
function seededShuffle(list, seed) {
  return list
    .map((value, i) => ({ value, k: sha256(`${seed}|${i}|${value}`) }))
    .sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0))
    .map((x) => x.value);
}

/** A finite number inside [0,1], or null. */
function unitCoord(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (n < 0 || n > 1) return null;
  return Math.min(1 - POINT_INSET, Math.max(POINT_INSET, n));
}

/**
 * Turn one raw model item into a valid target, or null.
 *
 * Everything here is defensive: the model output is untrusted, so each field is
 * trimmed, length-capped and range-checked, and a target that cannot support the
 * full hint ladder (point -> cloze -> choices) is dropped rather than shipped
 * half-working.
 */
function sanitizeTarget(raw, lang, seed) {
  if (!raw || typeof raw !== "object") return null;

  const label = String(raw.label == null ? "" : raw.label)
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 60);
  if (!label) return null;

  // 1) The point must land inside the image.
  const x = unitCoord(raw.point?.x);
  const y = unitCoord(raw.point?.y);
  if (x === null || y === null) return null;

  // 2) The cloze must actually have a blank, and must not give the answer away.
  const head = headNoun(label, lang);
  let cloze = String(raw.cloze == null ? "" : raw.cloze)
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 200);
  if (!cloze) return null;
  // Any run of 2+ underscores is the blank the model meant to write.
  cloze = cloze.replace(/_{2,}/g, "___");
  if (!cloze.includes("___")) {
    // No blank at all: if the sentence contains the word, blank it out ourselves
    // rather than throwing away an otherwise good target.
    const words = cloze.split(" ");
    const at = findPhrase(words, head);
    if (at < 0) return null;
    words.splice(at, head.split(" ").length, "___");
    cloze = words.join(" ");
  }
  // Leak check: the answer must not still be sitting in the sentence.
  if (head && findPhrase(cloze.split(" "), head) >= 0) return null;

  // 3) Choices: the answer plus plausible distractors, de-duplicated by folded
  //    form so "La taza" and "la taza" cannot both appear.
  const seen = new Set();
  const choices = [];
  const push = (v) => {
    const s = String(v == null ? "" : v).trim().replace(/\s+/g, " ").slice(0, 60);
    if (!s) return;
    const key = fold(s);
    if (!key || seen.has(key)) return;
    seen.add(key);
    choices.push(s);
  };
  push(label); // the answer always makes it in, whatever the model returned
  (Array.isArray(raw.choices) ? raw.choices : []).forEach(push);
  if (choices.length < MIN_CHOICES) return null;
  const shuffled = seededShuffle(choices.slice(0, MAX_CHOICES), `${seed}|${fold(label)}`);
  const answerIndex = shuffled.findIndex((c) => fold(c) === fold(label));
  if (answerIndex < 0) return null; // unreachable in practice; never ship a round with no answer

  const difficultyRaw = String(raw.difficulty == null ? "" : raw.difficulty).trim().toLowerCase();

  return {
    label,
    point: { x, y },
    cloze,
    choices: shuffled,
    answerIndex,
    difficulty: DIFFICULTY_VALUES.has(difficultyRaw) ? difficultyRaw : "medium",
  };
}

/** Sanitize the whole set, drop duplicates by head noun, cap at MAX_TARGETS. */
function sanitizeTargets(rawList, lang, seed) {
  const out = [];
  const heads = new Set();
  for (const raw of Array.isArray(rawList) ? rawList : []) {
    const t = sanitizeTarget(raw, lang, seed);
    if (!t) continue;
    // Two markers pointing at the same word is a broken round, not a bonus.
    const head = headNoun(t.label, lang) || fold(t.label);
    if (heads.has(head)) continue;
    heads.add(head);
    out.push(t);
    if (out.length === MAX_TARGETS) break;
  }
  return out;
}

// ── Prompt (localized per pack) ─────────────────────────────────────────────

const PACK = {
  en: {
    langName: "English",
    articleRule:
      'Write every label as the noun WITH its article, lowercase: "a mug", "the barista", "a window".',
    clozeExample: 'The barista is wearing ___.',
  },
  es: {
    langName: "Spanish (neutral Latin American)",
    articleRule:
      'Write every label as the noun WITH its definite article, lowercase: "la taza", "el barista", "la ventana". The article carries the gender, so a label without one is wrong.',
    clozeExample: 'El barista está preparando el café en ___.',
  },
};

function buildSystemPrompt(lang) {
  const p = PACK[lang];
  return `
You are looking at a photorealistic illustration from a language-learning
conversation. Find the things in it that are worth teaching as vocabulary, and
describe where each one is.

Return between ${MIN_TARGETS} and ${MAX_TARGETS} targets. Every string you write must be in
${p.langName} — labels, sentences and options alike. Return JSON only, no markdown.

Choose targets that are:
- CONCRETE and clearly visible: objects, clothing, furniture, food, parts of the
  setting. A learner must be able to see the thing and say "that one".
- SPREAD OUT across the picture, not five things on one table.
- WORTH LEARNING: everyday nouns a learner will meet again. Skip abstractions,
  skip anything you are guessing at, and skip anything too small to point at.
- Prefer things the scene is actually about over background filler.

For each target return:
- "label": the noun. ${p.articleRule}
- "point": { "x": 0.00-1.00, "y": 0.00-1.00 } — where to put a marker, as a
  fraction of the image: x from the LEFT edge, y from the TOP edge. Put it on the
  CENTER of the thing itself. 0.5/0.5 is the middle of the picture. Be accurate:
  a marker in the wrong place makes the question unanswerable.
- "cloze": ONE natural sentence about this picture, in ${p.langName}, with the
  target word replaced by exactly three underscores: ___
  Example: "${p.clozeExample}"
  The sentence must NOT contain the answer word anywhere else, and must read like
  something a person would say. Max 14 words.
- "choices": exactly 4 options — the label itself plus 3 plausible wrong answers
  in the same language and the same style (same kind of thing, same article
  form). A distractor should be temptingly wrong, not absurd.
- "difficulty": "easy", "medium" or "hard" — roughly how hard this word is for a
  learner.

Output MUST be valid JSON only, exactly:
{ "targets": [ { "label": "...", "point": { "x": 0.0, "y": 0.0 },
                 "cloze": "...", "choices": ["...","...","...","..."],
                 "difficulty": "easy" } ] }
`.trim();
}

function buildUserText(description, lang) {
  const p = PACK[lang];
  const lines = [
    `Find ${MIN_TARGETS}-${MAX_TARGETS} vocabulary targets in this image. Answer in ${p.langName}.`,
  ];
  if (description) {
    lines.push(
      "",
      "What this scene is (for grounding — describe only what you can actually SEE):",
      description
    );
  }
  return lines.join("\n");
}

// ── Handler ─────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  // 1) CORS / method (mirrors word-info)
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  // 2) ADMIN_TOKEN gate (cost-control). The router also gates this route; this
  //    is defense-in-depth for direct invocation.
  const token =
    (req.headers["x-admin-token"] || "").toString().trim() ||
    (req.query?.token || "").toString().trim();
  const expected = (process.env.ADMIN_TOKEN || "").toString().trim();
  if (!expected || token !== expected) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  // 3) Validate input
  const body = req.body || {};
  // Region-tolerant: "es", "ES" and "es-MX" are all the Spanish pack. Anything
  // else is English, the same closed two-value space every other route uses.
  const langRaw = (body.lang || body.pack || "en").toString().trim().toLowerCase();
  const lang = langRaw === "es" || langRaw.startsWith("es-") ? "es" : "en";
  const imageUrl = (body.imageUrl || "").toString().trim();
  const description = (body.description || "").toString().trim().slice(0, MAX_DESCRIPTION_CHARS);

  const suppliedKey = (body.imageKey || "").toString().trim().slice(0, 128);
  const imageKey = suppliedKey || (imageUrl ? sha256(imageUrl).slice(0, 32) : "");

  if (!imageKey) {
    return res.status(200).json(empty("", lang, "no_image"));
  }
  if (imageUrl.length > MAX_IMAGE_CHARS) {
    return res.status(200).json(empty(imageKey, lang, "image_too_large"));
  }

  // 4) Supabase (lazy, optional — never let the cache break the game)
  let sb = null;
  try {
    const { getSupabaseAdmin } = await import("../lib/supabase.js");
    sb = getSupabaseAdmin();
  } catch {
    sb = null; // env not configured; run cacheless
  }

  // 4a) Cache read. A row stamped with an older schema version is a miss, so the
  //     upsert below overwrites it in place — no migration needed to reshape.
  if (sb) {
    try {
      const { data } = await sb
        .from("image_targets")
        .select("targets, v")
        .eq("image_key", imageKey)
        .eq("lang", lang)
        .maybeSingle();
      if (data?.v === TARGETS_V && Array.isArray(data.targets) && data.targets.length) {
        return res
          .status(200)
          .json({ ok: true, cached: true, imageKey, lang, targets: data.targets });
      }
    } catch (e) {
      console.warn("[convo-image-targets] cache read failed", e?.message || e);
    }
  }

  // A cache miss with no bytes to look at: the caller probed with an imageKey
  // only. Nothing to degrade to but the empty state.
  if (!imageUrl) {
    return res.status(200).json(empty(imageKey, lang, "no_image"));
  }

  // 5) Imports & init. The openai v4 constructor throws synchronously on a
  //    missing key, so it is built inside this guard and degrades, never 500s.
  let jsonrepair, openai;
  try {
    const modAI = await import("openai");
    const modRepair = await import("jsonrepair");
    jsonrepair = modRepair.jsonrepair;
    openai = new modAI.OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  } catch (e) {
    console.error("[convo-image-targets] init error", e);
    return res.status(200).json(empty(imageKey, lang, "init_error"));
  }

  const MODEL =
    (process.env.LUX_AI_VISION_MODEL || "").toString().trim() ||
    (process.env.LUX_AI_QUICK_MODEL || "").toString().trim() ||
    (process.env.LUX_AI_MODEL || "").toString().trim() ||
    "gpt-4.1-mini";

  // 6) ONE vision call. temperature 0 for determinism, same as word-image.
  let resp;
  try {
    resp = await openai.chat.completions.create({
      model: MODEL,
      temperature: 0,
      max_tokens: 1400,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: buildSystemPrompt(lang) },
        {
          role: "user",
          content: [
            { type: "text", text: buildUserText(description, lang) },
            { type: "image_url", image_url: { url: imageUrl, detail: "high" } },
          ],
        },
      ],
    });
  } catch (e) {
    console.error("[convo-image-targets] model call failed", e?.message || e);
    return res.status(200).json(empty(imageKey, lang, "model_failed"));
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
    console.warn("[convo-image-targets] could not parse model JSON", e?.message || e);
    return res.status(200).json(empty(imageKey, lang, "bad_model_json"));
  }

  // 7) Validate. The seed is the image key, so the choice order is stable for
  //    this image forever — cache hit or fresh call, the round is the same.
  const rawTargets = Array.isArray(parsed?.targets) ? parsed.targets : [];
  const targets = sanitizeTargets(rawTargets, lang, imageKey);

  if (!targets.length) {
    // These two look identical to a caller but mean opposite things, and
    // collapsing them hides the failure that actually needs fixing. "The model
    // found nothing nameable in this picture" is a fine outcome for a blurry
    // close-up. "The model answered and every single target failed validation"
    // is a prompt or a model regression — the classic shape being coordinates
    // returned as percentages, where every point fails the [0,1] range check and
    // the whole set silently evaporates.
    if (rawTargets.length) {
      console.warn(
        `[convo-image-targets] all ${rawTargets.length} targets failed validation ` +
          `(lang=${lang} model=${MODEL} key=${imageKey})`
      );
      return res.status(200).json(empty(imageKey, lang, "no_valid_targets"));
    }
    return res.status(200).json(empty(imageKey, lang, "no_targets"));
  }

  if (targets.length < rawTargets.length) {
    console.log(
      `[convo-image-targets] kept ${targets.length}/${rawTargets.length} targets (lang=${lang})`
    );
  }

  // 8) Cache write — fire and forget, exactly like word-info's.
  if (sb) {
    sb.from("image_targets")
      .upsert(
        { image_key: imageKey, lang, v: TARGETS_V, targets, model: MODEL, updated_at: new Date().toISOString() },
        { onConflict: "image_key,lang" }
      )
      .then(() => {})
      .catch((e) => console.warn("[convo-image-targets] cache write failed", e?.message || e));
  }

  return res.status(200).json({ ok: true, cached: false, imageKey, lang, targets });
}
