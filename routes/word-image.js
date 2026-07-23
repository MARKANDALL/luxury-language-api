// routes/word-image.js
// One-line: Word-image — is this word picturable, and if so, what photo(s) to show?
//
// Lux teaches vocabulary. For a concrete word, a photograph teaches faster than a
// sentence and bypasses translation entirely: the learner sees the thing, not an
// English or Spanish gloss. This route answers ONE question — is this word
// picturable, and if so what should we show — and returns up to 3 Pexels photos.
//
// Cloned from routes/coach-ask.js: same CORS + admin-token gate, same cheap-model
// config (LUX_AI_QUICK_MODEL -> LUX_AI_MODEL -> gpt-4.1-mini), same json_object +
// jsonrepair parsing. It does NOT touch the coach-ask lens map — this is a
// separate route.
//
// Contract (POST /api/word-image):
//   Request:  { word, sentence, lang, l1, uid }
//   Response: { ok: true, imageable: true, query, images: [
//                { thumb, full, alt, photographer, sourceUrl }, ... ] }   (<= 3)
//
//   - imageable:false means the word has no useful picture (abstract nouns,
//     function words, most verbs of cognition). Then images:[] — this is a
//     SUCCESS, not an error.
//   - This route NEVER throws to the caller. On any internal failure it returns
//     { ok:true, imageable:false, images:[], reason:"<short code>" } so the UI
//     degrades to a friendly empty state.
//   - Determinism replaces caching for v1: classification runs at temperature 0
//     and we keep Pexels' own result order and take the first 3, so the same word
//     returns the same pictures every time (a word that changes its picture on
//     each visit harms memory anchoring — the whole point of the feature).

export const config = {
  api: {
    bodyParser: true,
    externalResolver: true,
  },
};

const PEXELS_ENDPOINT = "https://api.pexels.com/v1/search";
// Timeout for the outbound Pexels call, guarded with an AbortController the same
// way outbound calls elsewhere are bounded. Pexels normally answers in well under
// a second; on timeout we degrade to the graceful empty shape.
const PEXELS_TIMEOUT_MS = 6000;
const MAX_IMAGES = 3;

// The graceful empty shape. A `reason` is attached ONLY for internal failures
// (no_key, model_failed, ...); a legitimately non-picturable word returns this
// with no reason (it is a success, not a failure).
function empty(reason) {
  const out = { ok: true, imageable: false, images: [] };
  if (reason) out.reason = reason;
  return out;
}

export default async function handler(req, res) {
  // 1) CORS / method (mirrors coach-ask)
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  // 2) ADMIN_TOKEN gate (cost-control), same as coach-ask. The router also gates
  //    this route; this is defense-in-depth for direct invocation.
  const token =
    (req.headers["x-admin-token"] || "").toString().trim() ||
    (req.query?.token || "").toString().trim();
  const expected = (process.env.ADMIN_TOKEN || "").toString().trim();
  if (!expected || token !== expected) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  // 3) Validate input. l1 + uid are accepted for contract compatibility (the
  //    frontend sends them) but the image logic does not need them.
  const body = req.body || {};
  const word = (body.word || "").toString().trim().slice(0, 60);
  const sentence = (body.sentence || "").toString().trim().slice(0, 600);
  const lang = (body.lang || "en").toString().trim() === "es" ? "es" : "en";
  const targetLangName = lang === "es" ? "Spanish" : "English";

  // A missing/empty word simply is not picturable — degrade gracefully (the
  // contract is "always 200, never throw"), so the UI shows its empty state.
  if (!word) {
    return res.status(200).json(empty("no_word"));
  }

  // 4) Imports & init (mirrors coach-ask). On any init failure we degrade to the
  //    graceful empty shape rather than 500 — this route never throws to the
  //    caller. The OpenAI client is constructed INSIDE this guard on purpose: the
  //    openai v4 constructor throws synchronously when OPENAI_API_KEY is missing,
  //    and that throw must degrade to the empty shape, not surface as a 500.
  let jsonrepair, openai;
  try {
    const modAI = await import("openai");
    const modRepair = await import("jsonrepair");
    jsonrepair = modRepair.jsonrepair;
    openai = new modAI.OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  } catch (e) {
    console.error("[word-image] init error", e);
    return res.status(200).json(empty("init_error"));
  }

  const MODEL =
    (process.env.LUX_AI_QUICK_MODEL || "").toString().trim() ||
    (process.env.LUX_AI_MODEL || "").toString().trim() ||
    "gpt-4.1-mini";

  // ── STEP 1 — classify + build an English search query (the smart part) ──────
  // One small model call, JSON only, temperature 0 for determinism. It decides
  // two things: (a) is a photograph a good teacher for this word, and (b) the
  // best 1-to-3-word ENGLISH search query (Pexels searches best in English, so a
  // Spanish word is translated; the sentence disambiguates sense).
  const system = `
You decide whether a single vocabulary word can be taught with a PHOTOGRAPH, and
if so, what to search for on a stock-photo site (Pexels).

You get: a WORD a language learner tapped, the SENTENCE it appeared in (may be
empty), and the language of the word. Return JSON only — no markdown.

Decide two things:

1. imageable (boolean): true only if a single photograph would clearly teach a
   learner what this word means.
   - true: concrete nouns (shelf, raindrops, cafe), concrete physical actions
     (running, cooking), and adjectives that are visibly depictable (wet,
     crowded, red).
   - false: abstract nouns (freedom, idea), function words (however, the, of),
     auxiliaries and modals (would, has), verbs of cognition or feeling (think,
     believe, seem), and anything a photo cannot show unambiguously.

2. query (string): the best 1-to-3-word ENGLISH search phrase for a stock-photo
   site.
   - Pexels searches best in English, so if the word is not English, translate it
     to English.
   - Use the SENTENCE to pick the right sense when the word is ambiguous (a "bank"
     beside a river is a riverbank, not a financial bank).
   - Keep it concrete and photographable: 1 to 3 words, no punctuation. If
     imageable is false, return an empty string for query.

Output MUST be valid JSON only, with exactly these keys:
{ "imageable": true, "query": "shelf" }
`.trim();

  let imageable = false;
  let query = "";
  {
    let resp;
    try {
      resp = await openai.chat.completions.create({
        model: MODEL,
        temperature: 0, // determinism: the same word must classify the same way
        max_tokens: 60,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          {
            role: "user",
            content: JSON.stringify({ word, sentence, language: targetLangName }),
          },
        ],
      });
    } catch (e) {
      console.error("[word-image] classify model call failed", e?.message || e);
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
      console.warn("[word-image] could not parse model JSON", e?.message || e);
      return res.status(200).json(empty("bad_model_json"));
    }

    imageable = parsed?.imageable === true;
    query = (parsed?.query || "").toString().trim().slice(0, 60);
  }

  // Not picturable (or no usable query) -> success with empty images. Crucially,
  // we do NOT call Pexels here: a non-imageable word must never reach the network.
  if (!imageable || !query) {
    return res.status(200).json(empty());
  }

  // ── STEP 2 — query Pexels ───────────────────────────────────────────────────
  const PEXELS_KEY = (process.env.PEXELS_API_KEY || "").toString().trim();
  if (!PEXELS_KEY) {
    // Log a single clear warning (never the key itself) and degrade gracefully.
    console.warn(
      "[word-image] PEXELS_API_KEY is not set — returning an empty image set"
    );
    return res.status(200).json(empty("no_key"));
  }

  const url = `${PEXELS_ENDPOINT}?${new URLSearchParams({
    query,
    per_page: String(MAX_IMAGES),
    orientation: "landscape",
  }).toString()}`;

  let data;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PEXELS_TIMEOUT_MS);
  try {
    const pr = await fetch(url, {
      headers: { Authorization: PEXELS_KEY },
      signal: ctrl.signal,
    });
    if (!pr.ok) {
      console.warn(`[word-image] Pexels responded ${pr.status}`);
      return res.status(200).json(empty("pexels_error"));
    }
    data = await pr.json();
  } catch (e) {
    const timedOut = e?.name === "AbortError";
    console.warn(
      `[word-image] Pexels request ${timedOut ? "timed out" : "failed"}: ${
        e?.message || e
      }`
    );
    return res.status(200).json(empty(timedOut ? "pexels_timeout" : "pexels_error"));
  } finally {
    clearTimeout(timer);
  }

  // ── STEP 3 — shape the result ───────────────────────────────────────────────
  // Preserve Pexels' own order and take the first 3 (determinism). Use the
  // medium/large sizes rather than the very large originals. `alt` is the search
  // query, so screen readers and broken-image states both say something useful.
  const photos = Array.isArray(data?.photos) ? data.photos : [];
  const images = photos
    .slice(0, MAX_IMAGES)
    .map((p) => {
      const src = p?.src || {};
      return {
        thumb: (src.medium || src.large || src.original || "").toString(),
        full: (src.large || src.original || src.medium || "").toString(),
        alt: query,
        photographer: (p?.photographer || "").toString(),
        sourceUrl: (p?.url || "").toString(),
      };
    })
    .filter((im) => im.thumb || im.full);

  // NB: a picturable word with zero Pexels matches returns imageable:true with an
  // empty images array. `imageable` reflects the WORD's nature (decided in Step 1),
  // not whether Pexels happened to stock a photo — the task defines imageable:false
  // as abstract/function/cognition words, which this is not. The frontend should
  // key its gallery on images.length, and may show a distinct message for a
  // picturable-but-unmatched word.
  return res.status(200).json({ ok: true, imageable: true, query, images });
}
