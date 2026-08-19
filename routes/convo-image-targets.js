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
//                 box?,       // { x, y, w, h } the thing's extent, when usable
//                 cloze,      // natural sentence with a ___ blank
//                 choices,    // the answer + up to 3 plausible distractors
//                 answerIndex,// index of `label` inside `choices`
//                 aliases,    // other acceptable ways to name the same thing
//                 difficulty  // "easy" | "medium" | "hard"
//               } ] }
//
//   `box` is the answer to the second playtest's grounding failure: a marker
//   placed slightly off a calculator read as the desk behind it, and a point
//   alone cannot say which was meant. When present, `point` IS the box's centre,
//   so a caller that only understands points is already better off. `box` is
//   absent on every row cached before it existed, and callers must treat it as
//   optional rather than assume it.
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
// CACHE: table image_targets, keyed (image_key, lang, level). See
// migrations/0005_image_targets.sql and 0007_image_targets_level.sql. Degrades
// gracefully when Supabase env is missing (the route still works, it just pays
// for the model every time).
//
// `level` is "" when the caller did not ask for a band, which is what every row
// cached before levels existed already holds, so those rows keep serving the
// scenario-default round for free. Asking for a NEW level on a picture is one
// fresh vision call, cached forever after under its own key.
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

import { cropRegion, imageSize, releaseSource } from "../lib/image-crop.js";
import { withTiming, withPhase, timed, report } from "../lib/scan-timing.js";

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

// Bumped when a row must be re-checked rather than merely re-read.
//
//   v2  every box the row already carried was cut out and shown to the model on
//       its own. It says nothing about boxes the row does NOT carry.
//   v3  every LABEL was re-examined for instances the row never held, and each
//       instance found was crop-checked in turn.
//
// The distinction is the whole point of bumping it. The sixth playtest's row was
// written by current v6 code, was stamped v2, and every one of its targets was
// boxOk:true: a perfectly audited row holding one chair box in a room with seven
// chairs, because "audited" meant "the boxes present are right", and nothing
// could express "and there are no others". A v2 row is therefore stale now, and
// says so, which is what makes the healing on next serve decidable rather than
// guessed. Distinct from TARGETS_V, which discards the row and re-bills a full
// generation; this re-examines it in place.
const VERIFIED_V = 3;

const MIN_TARGETS = 5;
// Asked for twelve, not eight, and the reason is latency rather than variety —
// though v8 wants both.
//
// Stage 0 measured the top-up at 13 s, 43% of a 30 s cold scan, and it fired on
// two scans out of three. It fires because generation returns eight, crop
// verification drops half of them, and four is under the floor of five. So the
// route paid for a SECOND generation, a second enumeration and a second round
// of crop checks to climb back over a line the first call could have cleared on
// its own.
//
// Over-generating pays for the same attrition inside a call that is already in
// flight. Twelve asked for, roughly half surviving, still lands above the floor,
// and the top-up stops firing. It costs output tokens on the generate call —
// measured below — and buys back the entire second round trip.
const MAX_TARGETS = 12;

// Sixteen at the two high bands, twelve everywhere else.
//
// Attrition is not uniform: a C2 round is told to name PARTS and MATERIALS, so
// it returns a stud earring, a sleeve button and a lapel rather than a blazer,
// and boxes that small fail the crop check far more often than a chunky B1
// target does. Measured on the same scene at C2, twelve located targets came
// back as four survivors, under the floor, which paid for the whole ten-second
// top-up the twelve-target pool exists to avoid.
//
// This is only affordable because A8 made locating cheap. Under the old single
// call, four more targets meant four more clozes, riddles and choice sets
// written up front for targets that were about to be deleted. Now the extra ask
// costs a few hundred locate tokens and some crop checks that run in parallel,
// and it buys back a serial round trip.
/**
 * How many targets a DEEP scan may return.
 *
 * Lightning asks for this. A sprint runs forty-five to ninety seconds at roughly
 * three seconds a word, so a pool of twelve is one lap and a bit and then it is
 * recycling; a playtest watched a lap run out after about six words and start
 * again on the same ones Riddle had just served.
 *
 * Twenty-four is two full laps at the longest band, which is the point at which
 * the clock runs out before the words do. Mark has explicitly authorised paying
 * for it in load time.
 */
const DEEP_TARGETS = 24;

// ── The inventory ───────────────────────────────────────────────────────────
//
// v10 rebuilds generation as INVENTORY-FIRST, BAND-SECOND, and the airport
// diagnosis is the whole argument for it. A C1 request on a check-in scene came
// back as five garment close-ups and not one airport word, because the band was
// in the room while the model looked: the C1 prompt said "do not hunt for more
// objects, name parts and materials", and its self-check said to DROP anything a
// B1 learner would name on sight, which threw away the boarding pass, the kiosk
// and the carousel for the crime of being visible.
//
// So the LOOKING is band-free now. One pass enumerates what is nameable in the
// photograph across every granularity; a cheap text pass then decides which
// entries serve which band and what to call them. The inventory is a property of
// the PICTURE, cached once per image, shared by every band, every language and
// every deepening, which is also what makes a level change cheap: the expensive
// vision look is already done.

// Storage key for the inventory row. Not a CEFR value and not "", so no client
// request can ever collide with it: the handler gates requested levels to CEFR.
const INVENTORY_LEVEL_KEY = "__inv1";
const INVENTORY_LANG_KEY = "xx"; // glosses are plain English; bands translate
const INV_V = 101; // far from TARGETS_V, so a band row can never read as inventory

// How many entries the first look returns, and how many a mining pass may add.
// 32 is far past what any band round needs; it exists so six bands and a deep
// Lightning bank can all draw without a second look at the pixels.
const INVENTORY_MAX = 32;
const MINE_MAX = 16;

// The granularities the inventory is asked to cover. "action" is a thing frozen
// in the frame (pouring, boarding, waving); "state" is a condition (wet, torn,
// crowded, delayed). Both are nameable and both are exactly what the high bands
// starve without.
const GRANULARITIES = ["object", "part", "material", "surface", "state", "action"];

/** The floor a deep scan tops up to, rather than MIN_TARGETS. */
const DEEP_MIN_TARGETS = 16;

function maxTargetsFor(level, deep = false) {
  if (deep) return DEEP_TARGETS;
  return HIGH_BANDS.has(level) ? 16 : MAX_TARGETS;
}

// ── First playable ──────────────────────────────────────────────────────────
//
// A learner does not need the whole pool to start. Three verified words is a
// round, and the difference between waiting for three and waiting for twelve is
// most of the wait: the tail of the scan is crop checks on targets nobody has
// been asked about yet, plus a top-up that only exists to keep the pool deep.
//
// So the first few located targets are verified and written FIRST, the response
// goes out the moment three of them are ready, and everything after that
// happens while the round is already being played. A top-up firing in that tail
// costs the learner nothing, because they are not waiting for it.

/** How many located targets to push through verification before answering. */
// Four rather than three, because verification drops roughly half and a wave of
// exactly three would usually come out under the bar and serve nothing early.
const FIRST_WAVE = 4;

/** How many must survive that wave for a round to be worth starting. */
const FIRST_PLAYABLE = 3;

/**
 * The handle the client sends back to collect the rest.
 *
 * It is the row's identity rather than a new one: the tail's whole job is to
 * write the full row, and the follow-up is that row being read. Inventing a
 * separate id would mean storing a second thing that has to be kept in step
 * with the first.
 */
function makeScanId(imageKey, lang, level) {
  return `${imageKey}|${lang}|${level}`;
}

function parseScanId(raw) {
  const [imageKey = "", lang = "", level = ""] = String(raw || "").split("|");
  return { imageKey: imageKey.slice(0, 128), lang, level };
}

// A target needs the answer plus at least two distractors for the final hint to
// still be a real choice. Four is what we ask for; three is the graceful floor,
// because dropping an otherwise-perfect target (good point, good cloze) over one
// duplicated distractor costs the learner a word for no reader-visible gain.
const MIN_CHOICES = 3;
const MAX_CHOICES = 4;

// Other ways of saying the same thing, so a learner who names the object
// correctly but not in the exact words the model chose is not told they are
// wrong. Includes the bare head noun, which is the single most common near
// miss: "monitor" for "a computer monitor".
//
// NOT part of TARGETS_V. A set cached before aliases existed is still a
// perfectly good round, and mass-invalidating the cache would re-bill a vision
// call for every picture anyone has already played. Old sets simply come back
// without aliases, and the frontend's fuzzy tier covers them.
//
// Raised from 4 because four slots cannot hold what one garment actually
// answers to: swim trunks, swimming trunks, trunks, a bathing suit, a swimsuit,
// board shorts are six names for the same thing, and a learner who produces the
// wrong one of them should never be told they are wrong.
// How many near-miss terms to keep. Few: this list only has to catch the
// obvious ways to describe a thing, and a long one starts holding words that
// are really synonyms, which would turn right answers into "close".
const MAX_NEAR = 4;

const MAX_ALIASES = 8;

// The regional usage note that rides with a set of variants, when there is one.
// Optional and usually absent: most objects have a single name everywhere, and
// a note invented for those teaches something false.
const MAX_NOTE_CHARS = 140;

// The riddle clue, which is only ever a handful of adjectives.
const MAX_RIDDLE_CHARS = 60;

// How many instances of one label are worth carrying. Past a few, the label is
// describing a crowd rather than a thing, and the target should not exist.
const MAX_INSTANCES = 6;

// How well one instance can be seen, as the enumeration pass rates it, best
// first. Ordering matters: the crops in stage C take the most visible instance,
// and "most visible" is decided by this list.
const VISIBILITY_ORDER = ["full", "partial", "sliver"];
const VISIBILITY = new Set(VISIBILITY_ORDER);

// How much of its own crop an instance actually IS, judged on the crop rather
// than on the scene. This is the stage C gate: a crop is a promise that the
// thing is in the picture you are about to be shown, and the sixth playtest's
// chair crop kept that promise only in the sense that a sliver of chair was
// present behind a table, some papers, a lap and an arm.
const PROMINENCE_ORDER = ["main", "part", "edge"];
const PROMINENCE = new Set(PROMINENCE_ORDER);

// What a crop must be at least, for a crop-based mode to use it.
const CROP_GATE = new Set(["main", "part"]);

// How many previously-missed words are offered to a scan. Enough to give the
// picture a real chance of containing one, few enough that the list does not
// start steering the whole round.
const MAX_MISSES_OFFERED = 8;

// Head words the caller already played on this picture, which the scan is told
// to avoid. Capped because it rides on every request and a learner who has
// played a picture many times would otherwise send a paragraph of exclusions.
const MAX_EXCLUDED = 24;

// Words this learner is already working on: what they have kept in My Words, and
// what has beaten them before. Offered as a PREFERENCE and nothing stronger, so
// a picture that contains one teaches it and a picture that does not is left
// alone.
//
// Capped harder than the exclusions, and the cap is the whole safety of this
// feature rather than a size limit. A preference list long enough to cover most
// of a learner's vocabulary would stop being a preference and start being the
// round: the model would reach for a listed word on every picture, and a round
// where nothing new ever appears is the opposite of what a picture is for.
const MAX_PREFERRED = 12;

// Words the learner met lately on OTHER pictures. Capped lower than the
// exclusions because this one is a STEER and a long steer becomes a rule by
// weight of repetition, which is exactly what it must not be: a second cafe
// really does contain a cup.
const MAX_AVOIDED = 16;

// A box smaller than this is a mis-drawn sliver rather than an object; a box
// bigger than this in BOTH directions is the whole scene, which points at
// nothing. Either way the point is the better answer.
const MIN_BOX_SIDE = 0.02;
const MAX_BOX_SIDE = 0.9;

// Keep the marker off the very edge so a 28px dot is never half outside the
// frame. Points outside [0,1] are INVALID (dropped); a valid point inside the
// image is only nudged in from the rim.
const POINT_INSET = 0.03;

const DIFFICULTY_VALUES = new Set(["easy", "medium", "hard"]);

const CEFR_VALUES = new Set(["A1", "A2", "B1", "B2", "C1", "C2"]);

// The bands where a basic noun is a failure rather than a gentle round.
const HIGH_BANDS = new Set(["C1", "C2"]);

// The other end, and it needs teeth of its own for the same reason the high end
// did. "an espresso machine" came back in a live A2 round: the band description
// says specialist names are out, and the description alone did not hold.
const LOW_BANDS = new Set(["A1", "A2"]);

/**
 * How complex the game's own SENTENCES may be at each band.
 *
 * The clue sentence is the thing a learner actually reads, and it was being
 * written at whatever register the model felt like: a C2-shaped sentence around
 * an A1 noun is a C2 sentence, and it is the sentence, not the noun, that
 * decides whether a beginner can read the question at all.
 *
 * Deliberately not LEVEL_GUIDE, which is about which NOUNS are worth naming, and
 * deliberately the same six-step shape ispy-recap uses for the scene recap, so
 * the two surfaces a learner reads are calibrated the same way.
 */
const SENTENCE_BAND = {
  A1: "Very short and very plain. Present tense. No subordinate clauses. Max 8 words.",
  A2: "Short and plain. Present or simple past. At most one linking word. Max 10 words.",
  B1: "Ordinary sentences of comfortable length. Common connectors are fine. Max 12 words.",
  B2: "Natural sentences with some subordination and varied verb forms. Max 14 words.",
  C1: "Fluent, well-joined sentences. Precise verbs and natural modification. Max 14 words.",
  C2: "Fully idiomatic, with the range a native writer would use. Max 14 words.",
};

// How few targets a round may be served with before it is worth paying for a
// fresh vision call. Below four, the round is over before it starts.
const MIN_SERVED_TARGETS = 4;

// A box this big is the scene, not a thing in it. The side-length rule above
// only catches a box that is huge in BOTH directions, which lets a full-width
// band of sky, sand or floor through: exactly the "Where is the sand?" round
// the fourth playtest hit, served from a row cached before the rule existed.
const MAX_BOX_AREA = 0.5;
const MAX_BOX_BAND = 0.9;

// Things whose name is a surface rather than an object. A learner cannot point
// at "the sand": their tap lands in it wherever they put it, and the question
// has no answer that is more right than any other. Head nouns, folded, so the
// article is already gone by the time they are compared.
const SURFACE_NOUNS = {
  en: [
    "sand", "sky", "water", "sea", "ocean", "lake", "river", "grass", "lawn",
    "wall", "floor", "ceiling", "ground", "desk", "table", "counter",
    "countertop", "tabletop", "road", "street", "sidewalk", "pavement", "snow",
    "beach", "shore", "shoreline", "coast", "coastline", "field", "background",
    "foreground", "horizon", "dirt", "mud", "wave", "waves", "surf", "foam",
  ],
  es: [
    "arena", "cielo", "agua", "mar", "oceano", "lago", "rio", "cesped",
    "hierba", "pasto", "pared", "muro", "piso", "suelo", "techo", "escritorio",
    "mesa", "mostrador", "barra", "carretera", "calle", "camino", "acera",
    "banqueta", "nieve", "playa", "orilla", "costa", "campo", "fondo",
    "horizonte", "tierra", "lodo", "barro", "ola", "olas", "oleaje", "espuma",
  ],
};

// Nouns a B1 learner already produces on sight. Harmless lower down, wrong at
// C1 and C2, where the whole point of the band is the precise word, the part or
// the material. This is a floor, not the mechanism: the prompt's per-band
// exemplars and self-check do the work, and this catches what slips past.
const BASIC_NOUNS = {
  en: [
    "chair", "door", "window", "book", "car", "dog", "cat", "house", "tree",
    "bed", "phone", "cup", "glass", "shirt", "shoe", "shoes", "bag", "hat",
    "ball", "clock", "box", "bottle", "cake", "bread", "apple", "man", "woman",
    "boy", "girl", "child", "baby", "hand", "head", "face", "hair", "eye",
    "eyes", "food", "plate", "spoon", "fork", "knife", "lamp", "television",
    "computer", "bike", "bicycle", "bus", "train", "flower", "bird", "fish",
    "sun", "moon", "star", "pen", "pencil", "paper", "key", "sock", "coat",
    "jacket", "pants", "trousers", "dress", "towel", "soap", "toy", "chair",
    "picture", "bowl", "shelf", "basket", "mirror", "suitcase", "umbrella",
  ],
  es: [
    "silla", "puerta", "ventana", "libro", "coche", "carro", "auto", "perro",
    "gato", "casa", "arbol", "cama", "telefono", "taza", "vaso", "camisa",
    "zapato", "zapatos", "bolsa", "sombrero", "pelota", "reloj", "caja",
    "botella", "pastel", "pan", "manzana", "hombre", "mujer", "nino", "nina",
    "bebe", "mano", "cabeza", "cara", "pelo", "cabello", "ojo", "ojos",
    "comida", "plato", "cuchara", "tenedor", "cuchillo", "lampara",
    "television", "computadora", "bicicleta", "autobus", "tren", "flor",
    "pajaro", "pez", "sol", "luna", "estrella", "boligrafo", "lapiz", "papel",
    "llave", "calcetin", "abrigo", "chaqueta", "pantalones", "vestido",
    "toalla", "jabon", "juguete", "cuadro", "tazon", "estante", "canasta",
    "espejo", "maleta", "paraguas",
  ],
};

const SURFACE_SETS = {
  en: new Set(SURFACE_NOUNS.en),
  es: new Set(SURFACE_NOUNS.es),
};
const BASIC_SETS = {
  en: new Set(BASIC_NOUNS.en),
  es: new Set(BASIC_NOUNS.es),
};

/**
 * The one word the label is really about.
 *
 * "the sandy beach" is a beach and "a lifeguard shirt" is a shirt, but neither
 * matches a list of plain nouns, which is how both walked into a live round: the
 * first check compared whole phrases and a modifier was enough to slip past it.
 *
 * English puts the head last, Spanish puts it first. Both put it before "of" /
 * "de", so "the brim of the hat" is a brim, not a hat — without that, naming a
 * PART of a basic object, which is exactly what C1 is for, would be rejected as
 * the basic object.
 */
function headWord(label, lang) {
  let head = headNoun(label, lang);
  if (!head) return "";
  const cut = lang === "es" ? / de la | del | de los | de las | de / : / of the | of a | of /;
  const m = cut.exec(` ${head} `);
  if (m) head = ` ${head} `.slice(0, m.index).trim();
  const parts = head.split(" ").filter(Boolean);
  if (!parts.length) return "";
  return lang === "es" ? parts[0] : parts[parts.length - 1];
}

/** The word, and its singular if it looks plural. Beaches, waves, walls. */
function wordForms(w) {
  const forms = [w];
  if (w.length > 3 && w.endsWith("es")) forms.push(w.slice(0, -2));
  if (w.length > 3 && w.endsWith("s")) forms.push(w.slice(0, -1));
  return forms;
}

function inSet(set, label, lang) {
  if (!set) return false;
  const whole = headNoun(label, lang);
  const head = headWord(label, lang);
  for (const w of [...wordForms(whole), ...wordForms(head)]) {
    if (w && set.has(w)) return w;
  }
  return false;
}

/**
 * Why this target may not be served, or "".
 *
 * Applied in two places on purpose. Fresh model output runs through it, so a
 * bad target never reaches the cache. Cached rows run through it AS THEY ARE
 * READ, so a row written before a rule existed cannot keep serving what the
 * rule now forbids. That second half is the one that matters: the rules against
 * vast surfaces were already in the prompt when the fourth playtest was asked
 * "Where is the sand?", because the row predated them and nothing re-checked it.
 */
function ruleFailure(target, lang, level) {
  if (!target || typeof target !== "object") return "not_an_object";
  if (!headNoun(target.label, lang)) return "no_label";

  const surface = inSet(SURFACE_SETS[lang], target.label, lang);
  if (surface) return `surface:${surface}`;

  const box = target.box;
  if (box && typeof box === "object") {
    const w = Number(box.w);
    const h = Number(box.h);
    if (Number.isFinite(w) && Number.isFinite(h)) {
      if (w * h > MAX_BOX_AREA) return "box_area";
      if (w >= MAX_BOX_BAND || h >= MAX_BOX_BAND) return "box_band";
    }
  }

  if (HIGH_BANDS.has(level)) {
    // Matched on the HEAD word, so a modifier cannot buy a basic noun its way
    // in. The first C2 run of this rule came back with "a bucket hat" and
    // "a lifeguard shirt", which are a hat and a shirt with a word in front.
    const basic = inSet(BASIC_SETS[lang], target.label, lang);
    if (basic) return `too_basic:${basic}`;
  }

  return "";
}

// How to talk to the model about each band.
//
// Describing a band ("more precise vocabulary") does not move the model: the
// fourth playtest asked for C2 and got "a first-aid kit", which is a B1 label.
// What moves it is a worked contrast, so every band carries examples IN THE
// TARGET LANGUAGE of what belongs and what does not, and the two high bands say
// out loud that a part or a material is the right kind of answer there.
//
// The two ends still lean inward: a picture has only so many A1 nouns in it,
// and a C2 round of words that are not really visible stops being a game about
// the scene.
const LEVEL_GUIDE = {
  en: {
    A1: `A1 beginner. The commonest concrete nouns, the first words anyone learns.
YES: "a dog", "a car", "a chair", "a book", "a door".
NO: parts of objects, materials, or any word a beginner has not met.
If the picture will not yield enough of these, lean up to A2 rather than inventing obscure ones.`,
    A2: `A2 elementary. Everyday objects, clothes and furniture from a first year of study.
YES: "a jacket", "a towel", "a mirror", "a suitcase", "a shelf".
NO: parts of objects, materials, or specialist names.`,
    B1: `B1 intermediate. Ordinary specific nouns and everyday compounds, of the kind
someone meets in daily life rather than at work or in a trade.
YES: "a backpack", "a paper cup", "a notebook", "a receipt", "a blanket",
     "a bucket", "a napkin", "a shelf".
NO: bare basics a beginner already owns ("a bag", "a cup").
NO: workplace, trade or safety equipment. "a clipboard", "an apron", "a life
    jacket", "a first-aid kit" and "a stethoscope" are all B2 or above, however
    ordinary the OBJECT looks: the question is whether a B1 learner holds the
    WORD, and for these they do not.
NO: parts of things. "a windowsill", "a cuff" and "a hem" are parts, and parts
    belong at C1.`,
    B2: `B2 upper intermediate. The specific name for the thing rather than its category.
YES: "a windbreaker" rather than "a jacket"; "a thermos" rather than "a bottle";
     "a stretcher" rather than "a bed"; "a paperback" rather than "a book".
NO: the general category word when a more specific one is plainly visible.`,
    C1: `C1 advanced. Precise hyponyms, MATERIALS, and PARTS of the objects shown.
Parts and materials are not merely allowed at this band, they are what it is for.
YES: "driftwood" rather than "wood"; "a tourniquet" rather than "a bandage";
     "whitecaps" rather than "waves"; "the visor" rather than "the helmet";
     "gauze", "the hem", "the lapel", "the tread", "the shoulder strap".
NO: any noun a B1 learner would produce on sight. If you would teach the word at
    B1, it does not belong in a C1 round.`,
    C2: `C2 mastery. The most precise word that exists for what is shown: technical terms,
trade names for parts, materials, and regional names.
YES: "the ferrule", "a carabiner", "hoarfrost", "a cannula", "the selvage",
     "the escutcheon", "the plimsoll line", "the aglet".
NO: anything you could equally have offered at B1 or B2. Where the picture cannot
    honestly support this band, lean down to C1 rather than naming something that
    is not really there.`,
  },
  es: {
    A1: `A1 beginner. The commonest concrete nouns, the first words anyone learns.
YES: "el perro", "el coche", "la silla", "el libro", "la puerta".
NO: parts of objects, materials, or any word a beginner has not met.
If the picture will not yield enough of these, lean up to A2 rather than inventing obscure ones.`,
    A2: `A2 elementary. Everyday objects, clothes and furniture from a first year of study.
YES: "la chaqueta", "la toalla", "el espejo", "la maleta", "el estante".
NO: parts of objects, materials, or specialist names.`,
    B1: `B1 intermediate. Ordinary specific nouns and everyday compounds, of the kind
someone meets in daily life rather than at work or in a trade.
YES: "la mochila", "el vaso de papel", "el cuaderno", "el recibo", "la manta",
     "la cubeta", "la servilleta", "el estante".
NO: bare basics a beginner already owns ("la bolsa", "la taza").
NO: workplace, trade or safety equipment. "el portapapeles", "el delantal",
    "el chaleco salvavidas" and "el botiquin" are all B2 or above, however
    ordinary the OBJECT looks: the question is whether a B1 learner holds the
    WORD, and for these they do not.
NO: parts of things, which belong at C1.`,
    B2: `B2 upper intermediate. The specific name for the thing rather than its category.
YES: "el cortavientos" rather than "la chaqueta"; "el termo" rather than "la botella";
     "la camilla" rather than "la cama".
NO: the general category word when a more specific one is plainly visible.`,
    C1: `C1 advanced. Precise hyponyms, MATERIALS, and PARTS of the objects shown.
Parts and materials are not merely allowed at this band, they are what it is for.
YES: "el torniquete" rather than "la venda"; "la visera" rather than "el casco";
     "la gasa", "el dobladillo", "la solapa", "la banda de rodadura", "el tirante".
NO: any noun a B1 learner would produce on sight. If you would teach the word at
    B1, it does not belong in a C1 round.`,
    C2: `C2 mastery. The most precise word that exists for what is shown: technical terms,
trade names for parts, materials, and regional names.
YES: "la contera", "el mosquiton", "la escarcha", "la canula", "el orillo",
     "el bocallave", "el herrete".
NO: anything you could equally have offered at B1 or B2. Where the picture cannot
    honestly support this band, lean down to C1 rather than naming something that
    is not really there.`,
  },
};

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

/**
 * Answer, but only the first time.
 *
 * First-playable means this handler keeps working after it has replied: it
 * verifies the tail, tops up and writes the row while the round is already
 * being played. Every later exit therefore has to be able to run without
 * speaking, and a guard on each of them separately is a guard somebody will
 * forget to add.
 */
function sendOnce(res, body) {
  if (res._luxSent || res.headersSent) return res;
  res._luxSent = true;
  return res.status(200).json(body);
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

/** A finite number inside [0,1], unclamped. Box edges may legitimately be 0 or 1. */
function unitRaw(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1) return null;
  return n;
}

/**
 * The thing's extent, not just a spot on it.
 *
 * A point alone was the second playtest's first grounding failure: a marker
 * placed a little off the calculator read as the desk behind it, and the learner
 * had no way to tell which of the two was meant. A box says how big the thing
 * is, which lets the frontend put the dot at its true centre and, when an answer
 * goes wrong, show the extent so there is no doubt.
 *
 * Accepts { x, y, w, h } from the model. Rejects a box that is inverted, empty,
 * out of bounds, or so large it is really "the whole picture" (which teaches
 * nothing and would dim nothing). Returns null on any of those, and the caller
 * falls back to the point, exactly as every already-cached row does.
 */
function unitBox(raw) {
  if (!raw || typeof raw !== "object") return null;
  const x = unitRaw(raw.x);
  const y = unitRaw(raw.y);
  const w = unitRaw(raw.w);
  const h = unitRaw(raw.h);
  if (x === null || y === null || w === null || h === null) return null;
  if (w < MIN_BOX_SIDE || h < MIN_BOX_SIDE) return null;
  if (w > MAX_BOX_SIDE && h > MAX_BOX_SIDE) return null;
  if (x + w > 1.0001 || y + h > 1.0001) return null;
  // Trim the rounding slop the bounds check just tolerated.
  return {
    x,
    y,
    w: Math.min(w, 1 - x),
    h: Math.min(h, 1 - y),
  };
}

/**
 * Turn one raw model item into a valid target, or null.
 *
 * Everything here is defensive: the model output is untrusted, so each field is
 * trimmed, length-capped and range-checked, and a target that cannot support the
 * full hint ladder (point -> cloze -> choices) is dropped rather than shipped
 * half-working.
 */
/**
 * LOCATE-time validation: the label, where the thing is, and nothing else.
 *
 * Split from the old one-shot sanitizer when generation was split. This half
 * runs on the lite call's output, BEFORE any crop is cut, so a target that
 * breaks a rule is dropped before the route pays a penny to write teaching
 * material for it. ruleFailure lives here rather than at enrich time for the
 * same reason: it only ever needed the label, the box and the band.
 */
function sanitizeLocated(raw, lang, level) {
  if (!raw || typeof raw !== "object") return null;

  const label = String(raw.label == null ? "" : raw.label)
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 60);
  if (!label) return null;

  // Where the thing is. A valid box wins, because its CENTRE is a better marker
  // spot than a point the model estimated separately: a point drawn a little low
  // reads as the desk behind the calculator, and the box says which of the two
  // was meant. A missing or broken box falls back to the point, which is also
  // what every row cached before boxes existed does.
  //
  // A label can name more than one thing in frame. The fifth playtest asked
  // "where is the parking ticket" in a scene holding two of them, one on each
  // car, and scored only the one the model happened to pick: the learner tapped
  // a ticket, was told no, and was then shown a ticket. So every instance the
  // model found is kept, and the first is the one the marker and the crops use.
  const boxes = (Array.isArray(raw.boxes) ? raw.boxes : [])
    .map(unitBox)
    .filter(Boolean)
    .slice(0, MAX_INSTANCES);
  const box = unitBox(raw.box) || boxes[0] || null;
  if (box && !boxes.some((b) => b.x === box.x && b.y === box.y && b.w === box.w && b.h === box.h)) {
    boxes.unshift(box);
  }
  const px = box ? unitCoord(box.x + box.w / 2) : unitCoord(raw.point?.x);
  const py = box ? unitCoord(box.y + box.h / 2) : unitCoord(raw.point?.y);
  if (px === null || py === null) return null;

  const difficultyRaw = String(raw.difficulty == null ? "" : raw.difficulty).trim().toLowerCase();

  const target = {
    label,
    point: { x: px, y: py },
    // Omitted rather than null when there is no usable box, so a target from a
    // fresh call and a target from the pre-box cache are the same shape.
    ...(box ? { box } : null),
    ...(boxes.length > 1 ? { boxes } : null),
    ...(raw.revisit === true ? { revisit: true } : null),
    difficulty: DIFFICULTY_VALUES.has(difficultyRaw) ? difficultyRaw : "medium",
  };

  // The same gate the cache read applies, so nothing a served row would be
  // filtered for can be written in the first place. Without this the two halves
  // disagree: a row is stored, then permanently rejected on read, and every play
  // of that picture pays for a regeneration that stores the same thing.
  if (ruleFailure(target, lang, level)) return null;
  return target;
}

/**
 * ENRICH-time validation: the teaching material, checked onto a target that has
 * already survived the crop.
 *
 * Everything here can still reject the target, and that is deliberate: a cloze
 * that leaks its own answer is worse than no round at all. What has changed is
 * WHEN the rejection costs something. It used to throw away a target the model
 * had also drawn a box for; now the box work is already done and paid for, and
 * only the writing is lost.
 */
function applyEnrichment(base, raw, lang, seed) {
  if (!base) return null;
  const label = base.label;
  const head = headNoun(label, lang);

  // The cloze must actually have a blank, and must not give the answer away.
  let cloze = String(raw?.cloze == null ? "" : raw.cloze)
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

  // Choices: the answer plus plausible distractors, de-duplicated by folded form
  // so "La taza" and "la taza" cannot both appear.
  const seen = new Set();
  const choices = [];
  const push = (v) => {
    const str = String(v == null ? "" : v).trim().replace(/\s+/g, " ").slice(0, 60);
    if (!str) return;
    const key = fold(str);
    if (!key || seen.has(key)) return;
    seen.add(key);
    choices.push(str);
  };
  push(label); // the answer always makes it in, whatever the model returned
  (Array.isArray(raw?.choices) ? raw.choices : []).forEach(push);
  if (choices.length < MIN_CHOICES) return null;
  const shuffled = seededShuffle(choices.slice(0, MAX_CHOICES), `${seed}|${fold(label)}`);
  const answerIndex = shuffled.findIndex((c) => fold(c) === fold(label));
  if (answerIndex < 0) return null; // unreachable in practice; never ship a round with no answer

  // Aliases: other correct ways to name this thing. The head noun is always one
  // of them, since dropping the article is the commonest near miss and it should
  // never be graded wrong. Distractors are excluded by construction: an alias
  // matching a wrong choice would make that choice correct too.
  const aliasSeen = new Set([fold(label)]);
  const wrongChoices = new Set(shuffled.map(fold).filter((f) => f !== fold(label)));
  const aliases = [];
  const pushAlias = (v) => {
    const str = String(v == null ? "" : v).trim().replace(/\s+/g, " ").slice(0, 60);
    if (!str || aliases.length >= MAX_ALIASES) return;
    const key = fold(str);
    if (!key || aliasSeen.has(key) || wrongChoices.has(key)) return;
    aliasSeen.add(key);
    aliases.push(str);
  };
  if (head) pushAlias(head);
  (Array.isArray(raw?.aliases) ? raw.aliases : []).forEach(pushAlias);

  // Near misses: reasonable descriptions of this thing that are NOT its name.
  //
  // Filtered against the aliases and the label, and that filter is the whole
  // safety of the feature. A term that is BOTH would make a right answer wrong,
  // and the frontend checks near last precisely so acceptance always wins; this
  // makes the same guarantee one step earlier, where it is cheaper.
  const near = [];
  for (const v of Array.isArray(raw?.near) ? raw.near : []) {
    const str = String(v == null ? "" : v).trim().replace(/\s+/g, " ").slice(0, 60);
    if (!str || near.length >= MAX_NEAR) continue;
    const key = fold(str);
    // aliasSeen already holds the label and every accepted alias.
    if (!key || aliasSeen.has(key) || near.some((n) => fold(n) === key)) continue;
    near.push(str);
  }

  // The usage note. Kept only when there is something for it to be about: a note
  // with no variant behind it is a lecture attached to the plain word, and the
  // frontend only says it after an alias was matched anyway.
  const note = String(raw?.americanNote == null ? "" : raw.americanNote)
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, MAX_NOTE_CHARS);
  const hasVariant = aliases.some((a) => fold(a) !== head);

  // The riddle clue: attributes only. A clue holding the answer, or any word of
  // it, is not a clue, and the same leak check the cloze gets applies here for
  // the same reason. Dropped rather than repaired: a riddle is optional and a
  // broken one gives the round away.
  let riddle = String(raw?.riddle == null ? "" : raw.riddle)
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[.!?]+$/, "")
    .slice(0, MAX_RIDDLE_CHARS);
  if (riddle) {
    const words = riddle.split(" ");
    const leaks =
      findPhrase(words, head) >= 0 ||
      head.split(" ").some((part) => part.length > 2 && findPhrase(words, part) >= 0);
    if (leaks) riddle = "";
  }

  return {
    ...base,
    cloze,
    choices: shuffled,
    answerIndex,
    aliases,
    ...(near.length ? { near } : null),
    // Omitted rather than empty, so a target from before this field existed and
    // a target that simply has no regional variation are the same shape.
    ...(note && hasVariant ? { americanNote: note } : null),
    ...(riddle ? { riddle } : null),
  };
}

/** Intersection over union of two normalized boxes. 0 when they do not meet. */
function iou(a, b) {
  if (!a || !b) return 0;
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.w, b.x + b.w);
  const t2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, r - x) * Math.max(0, t2 - y);
  if (inter <= 0) return 0;
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * How much two boxes must agree before they are called ONE OBJECT.
 *
 * IoU, and specifically NOT containment, and that choice is the whole design.
 * Containment would fold "the lapel" into "the blazer", and parts of objects are
 * exactly what C1 and C2 are FOR: the high bands are told to name a hat's brim
 * and a shirt's cuff, and a containment rule would delete every one of them. Two
 * labels for the SAME EXTENT score high on IoU; a small part inside a big garment
 * scores low, because the union is the whole garment.
 *
 * 0.6 is deliberately high. A wrong merge silently deletes a real target, and a
 * missed merge leaves the duplicate the head-word check already mostly catches.
 */
const SAME_REFERENT_IOU = 0.6;

/**
 * Which of two labels for one object to keep.
 *
 * Band-aware, because "better" is not a property of the label on its own. At the
 * low bands the simpler word is the one the learner can use, so the shorter label
 * wins; at the high bands the point is precision, so the longer, more specific
 * one does. In the middle, and on a tie, the model's own ordering stands: it led
 * with that label for a reason.
 *
 * The case that produced this: one round served "a suit jacket" and "a blazer" as
 * two targets on one garment, so the same coat was asked about twice and the
 * scene recap described a man wearing both.
 */
function betterLabel(kept, candidate, level) {
  const a = String(kept.label || "").length;
  const b = String(candidate.label || "").length;
  if (a === b) return kept;
  if (HIGH_BANDS.has(level)) return b > a ? candidate : kept;
  if (level === "A1" || level === "A2") return b < a ? candidate : kept;
  return kept;
}

/**
 * Fold labels that name the same object in the picture into one target.
 *
 * The head-word check above cannot catch this and never could: "a blazer" and "a
 * suit jacket" share no head word, so by every text test they are two different
 * words. They are two names for one garment, and the only thing that knows that
 * is WHERE THEY ARE.
 */
function dedupeSameReferent(list, level) {
  const out = [];
  for (const t of list) {
    const boxes = Array.isArray(t.boxes) && t.boxes.length ? t.boxes : t.box ? [t.box] : [];
    const primary = boxes[0];
    // A target with no box cannot be compared this way, and is kept: it is the
    // shape of a row generated before boxes existed, not a duplicate.
    if (!primary) {
      out.push(t);
      continue;
    }
    const hitIdx = out.findIndex((kept) => {
      const keptBoxes = Array.isArray(kept.boxes) && kept.boxes.length ? kept.boxes : kept.box ? [kept.box] : [];
      return keptBoxes[0] && iou(keptBoxes[0], primary) >= SAME_REFERENT_IOU;
    });
    if (hitIdx < 0) {
      out.push(t);
      continue;
    }
    const winner = betterLabel(out[hitIdx], t, level);
    console.log(
      `[convo-image-targets] same referent: "${out[hitIdx].label}" and "${t.label}" ` +
        `overlap ${iou((out[hitIdx].boxes?.[0] || out[hitIdx].box), primary).toFixed(2)}, keeping "${winner.label}"`,
    );
    out[hitIdx] = winner;
  }
  return out;
}

/**
 * Sanitize a whole LOCATE response: drop duplicates by head noun and by
 * referent, cap at MAX_TARGETS.
 */
function sanitizeLocatedList(rawList, lang, level, deep = false) {
  const out = [];
  const heads = new Set();
  for (const raw of Array.isArray(rawList) ? rawList : []) {
    const t = sanitizeLocated(raw, lang, level);
    if (!t) continue;
    // Two markers pointing at the same word is a broken round, not a bonus.
    //
    // Keyed on the HEAD WORD, not the whole noun phrase. Keying on the phrase
    // let "a salad bowl" and "a bowl" both into one six-target round, pointing
    // at the same box: distinct phrases, one answer word, and a learner who says
    // "bowl" is right twice and told so once.
    const head = headWord(t.label, lang) || headNoun(t.label, lang) || fold(t.label);
    if (heads.has(head)) continue;
    heads.add(head);
    out.push(t);
    if (out.length === maxTargetsFor(level, deep)) break;
  }
  // Applied AFTER the head-word pass and BEFORE verification, so a duplicate
  // never costs a crop check, and never reaches the round or the recap.
  return dedupeSameReferent(out, level);
}

// ── The inventory pass ──────────────────────────────────────────────────────

/**
 * The one vision look. Band-free on purpose: see the constants block above.
 *
 * The box discipline lives here now, moved whole from the old locate prompt,
 * because boxes are a property of the looking and not of the band.
 */
function buildInventoryPrompt() {
  return `
You are looking at a photorealistic illustration from a language-learning
conversation. Build its nameable INVENTORY: everything in the picture a person
could point at and name, across EVERY granularity, so that later passes can
teach from it at any level from beginner to mastery.

Granularities, and every one of them matters:
- "object": whole things. A kiosk, a suitcase, a lanyard, a hat.
- "part": parts of those things. A brim, a cuff, a strap, a screen bezel.
- "material": what things are made of, where it is visible. Leather, chrome.
- "surface": distinct surfaces worth naming. A tiled floor, a glass partition.
- "state": visible conditions. A queue, a crease, a reflection, wear.
- "action": actions frozen in the frame. Pouring, weighing, boarding.

Return up to ${INVENTORY_MAX} entries. For each:
- "gloss": a short plain-English noun phrase naming the thing precisely.
  Prefer the SPECIFIC name: "a boarding pass" not "a paper", "a check-in kiosk"
  not "a machine". The gloss is what a later pass teaches from, and a vague
  gloss wastes the entry.
- "granularity": one of ${JSON.stringify(GRANULARITIES)}.
- "box": { "x", "y", "w", "h" } - the thing's BOUNDING BOX as fractions of the
  image: x and y its top-left corner from the left and top edges, w and h its
  width and height.
  The box is not decoration: a learner will TAP inside it to answer, so it has
  to be right.
  * TIGHT. It must hug the object. A box with room to spare around the thing
    accepts taps on whatever is beside it.
  * IT MUST CONTAIN THE THING YOU NAMED. If the box you would draw does not have
    the object inside it, the entry is wrong. Check this before you keep it.
  * NEVER A PERSON'S BODY. A box over someone's chest, neck, face or arm is only
    acceptable when the thing you named IS what they are wearing or holding, and
    then the box goes around the garment or the item, not the person.
  * NO VAST SURFACES. Do not target a whole desk, wall, floor, ceiling or
    counter top as an entry: their boxes swallow half the picture and every tap
    lands in them. A DISTINCT surface region (a doormat, a tiled splashback) is
    fine when its box is honest.
- "boxes": when the picture contains MORE THAN ONE of the thing, list a box for
  EVERY one of them here, up to ${MAX_INSTANCES}, and still give the clearest one
  as "box". A learner asked to find "the ticket" in a scene with two tickets
  will point at whichever they see first, and being told they are wrong for
  finding the thing they were asked for is the worst answer a game can give.
  Omit the field when there is only one.
- "point": { "x": 0.00-1.00, "y": 0.00-1.00 } - the centre of the thing.

Entries must be VISUALLY UNAMBIGUOUS. Before you keep one, look at what
surrounds it: if a NEARBY thing could plausibly be given the same gloss, the
question has two right answers. Either make the gloss specific to one of them or
list both in "boxes".

Do NOT write sentences, questions, clues or wrong answers here. A later pass
does that, and only for the entries that survive checking. Naming the thing and
placing it is the whole job.

COUNT CHECK, entry by entry: if there are several of a thing, either list every
one in "boxes" or make the gloss specific to ONE of them.
Never pick one of several lookalikes silently.

Before you answer, re-read your own list once and drop anything whose box does not
contain the thing it names, anything drawn over a person's body that is not
their clothing or held item, and any vast bare surface.

Output MUST be valid JSON only, exactly:
{ "inventory": [ { "gloss": "...", "granularity": "object",
                   "box": { "x": 0.0, "y": 0.0, "w": 0.0, "h": 0.0 },
                   "boxes": [ { "x": 0.0, "y": 0.0, "w": 0.0, "h": 0.0 } ],
                   "point": { "x": 0.0, "y": 0.0 } } ] }
`.trim();
}

/**
 * The mining variant's user turn: a second look that must not repeat the first.
 *
 * The taken-gloss block keeps the exact sentence the old top-up used, because it
 * is the right sentence and the deepen is the top-up's successor: it fires when
 * a band or a draw cannot fill from what the inventory already holds.
 */
function buildMineText(description, taken, wantGrans, lang, exclude, prefer) {
  const lines = [
    `This image has already been inventoried. Find up to ${MINE_MAX} MORE nameable`,
    `entries, at any granularity, that are genuinely in the picture.`,
    "",
    "Already taken, do NOT return any of these or a synonym of one:",
    taken.map((g) => `- ${g}`).join("\n"),
  ];
  if (wantGrans.length) {
    lines.push(
      "",
      `Mine especially these granularities, which the inventory is thinnest on:`,
      wantGrans.map((g) => `- ${g}`).join("\n"),
    );
  }
  lines.push(
    "",
    "Look harder and further into the scene: smaller things, things at the edges,",
    "things behind or beside the obvious subject, parts of things already listed,",
    "the materials they are made of, their visible condition. Follow every rule",
    "you were given. If the picture genuinely holds nothing else worth naming,",
    "return an empty list rather than inventing something.",
  );
  // The learner-shaped blocks ride here too: what to avoid mining, and what to
  // mine FOR. A mine that rediscovers the excluded words wastes its whole pass.
  lines.push(...preferBlock(prefer));
  if (exclude?.length) {
    lines.push(
      "",
      "This learner has ALREADY been taught these words from this picture. Find",
      "OTHER things. Do not return any of these, or a longer phrase built around",
      "one of them:",
      exclude.map((w) => `- ${w}`).join("\n"),
    );
  }
  if (description) {
    lines.push("", "What this scene is (describe only what you can actually SEE):", description);
  }
  return lines.join("\n");
}

/** Sanitize one raw inventory entry, or null. Ids are assigned by the CALLER. */
function sanitizeInventoryEntry(raw) {
  const gloss = String(raw?.gloss || "").trim().replace(/\s+/g, " ").slice(0, 80);
  if (!gloss) return null;
  const granularity = GRANULARITIES.includes(raw?.granularity) ? raw.granularity : "object";
  const box = unitBox(raw?.box);
  const boxes = (Array.isArray(raw?.boxes) ? raw.boxes : [])
    .map(unitBox)
    .filter(Boolean)
    .slice(0, MAX_INSTANCES);
  let point = null;
  const px = Number(raw?.point?.x);
  const py = Number(raw?.point?.y);
  // STRICT, not clamped. A point at x=28 is the percentages-as-fractions model
  // regression, and clamping it into the frame would hide exactly the failure
  // the no_valid_targets diagnostics exist to catch.
  if (Number.isFinite(px) && Number.isFinite(py) && px >= 0 && px <= 1 && py >= 0 && py <= 1) {
    point = { x: clampPoint(px), y: clampPoint(py) };
  }
  if (!point && box) point = { x: clampPoint(box.x + box.w / 2), y: clampPoint(box.y + box.h / 2) };
  if (!point) return null;
  return { gloss, granularity, ...(box ? { box } : null), ...(boxes.length > 1 ? { boxes } : null), point };
}

/**
 * Run one inventory look (first or mining) and return sanitized entries.
 * Ids are assigned here, offset past what already exists, so a mined entry can
 * never collide with a cached one.
 */
async function runInventory(openai, model, imageUrl, { description, taken = [], wantGrans = [], lang = "en", exclude = [], prefer = [], startId = 0 }) {
  const { jsonrepair } = await import("jsonrepair");
  const mining = taken.length > 0;
  const userText = mining
    ? buildMineText(description, taken, wantGrans, lang, exclude, prefer)
    : [
        "Build the inventory for this image.",
        description ? `\nWhat this scene is (describe only what you can actually SEE):\n${description}` : "",
      ].join("");
  const resp = await timed(mining ? "mine" : "inventory", () =>
    openai.chat.completions.create({
      model,
      temperature: 0,
      // 32 entries with boxes and glosses. At 2800 the tail of a full inventory
      // risks the same silent truncation the old locate call once hit.
      max_tokens: 3600,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: buildInventoryPrompt() },
        {
          role: "user",
          content: [
            { type: "text", text: userText },
            { type: "image_url", image_url: { url: imageUrl, detail: "high" } },
          ],
        },
      ],
    }),
  );
  const raw = resp?.choices?.[0]?.message?.content || "{}";
  let obj;
  try {
    try {
      obj = JSON.parse(raw);
    } catch {
      obj = JSON.parse(jsonrepair(raw));
    }
  } catch (e) {
    const err = new Error(e?.message || "unparseable");
    err.code = "bad_model_json";
    throw err;
  }
  const list = Array.isArray(obj?.inventory) ? obj.inventory : [];
  const out = [];
  const seen = new Set(taken.map((g) => fold(g)));
  for (const r of list) {
    const e = sanitizeInventoryEntry(r);
    if (!e) continue;
    const key = fold(e.gloss);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ id: startId + out.length, ...e });
    if (out.length >= (mining ? MINE_MAX : INVENTORY_MAX)) break;
  }
  // rawCount is what the model OFFERED, kept beside what survived, because
  // "found nothing" and "found things that all failed validation" are opposite
  // failures and the handler reports them apart.
  return { entries: out, rawCount: list.length };
}

/** The inventory row, if this picture has one. */
async function readInventory(sb, imageKey) {
  if (!sb) return null;
  try {
    const { data, error } = await timed("db.readInv", () =>
      sb
        .from("image_targets")
        .select("targets, v")
        .eq("image_key", imageKey)
        .eq("lang", INVENTORY_LANG_KEY)
        .eq("level", INVENTORY_LEVEL_KEY)
        .maybeSingle(),
    );
    if (error) {
      console.warn("[convo-image-targets] inventory read failed:", error.message);
      return null;
    }
    if (data?.v !== INV_V || !Array.isArray(data?.targets) || !data.targets.length) return null;
    return data.targets;
  } catch (e) {
    console.warn("[convo-image-targets] inventory read failed", e?.message || e);
    return null;
  }
}

/** Persist the inventory. Best effort: a cacheless run still plays. */
async function writeInventory(sb, imageKey, inventory) {
  if (!sb) return;
  try {
    const { error } = await timed("db.writeInv", () =>
      sb.from("image_targets").upsert(
        {
          image_key: imageKey,
          lang: INVENTORY_LANG_KEY,
          level: INVENTORY_LEVEL_KEY,
          targets: inventory,
          v: INV_V,
          verified: 0,
          model: pickModel(),
        },
        { onConflict: "image_key,lang,level" },
      ),
    );
    if (error) console.warn("[convo-image-targets] inventory write failed:", error.message);
  } catch (e) {
    console.warn("[convo-image-targets] inventory write failed", e?.message || e);
  }
}

/** Which granularities the inventory is thinnest on, for a mining pass. */
function thinnestGranularities(inventory) {
  const tally = Object.fromEntries(GRANULARITIES.map((g) => [g, 0]));
  for (const e of inventory) tally[e.granularity] = (tally[e.granularity] || 0) + 1;
  return GRANULARITIES.filter((g) => tally[g] <= 1);
}

// ── The band pass ───────────────────────────────────────────────────────────

/**
 * Choose WORDS for one band from the inventory. Text-only and cheap: the
 * expensive looking is already done, which is what makes a level change fast
 * and six bands affordable on one picture.
 */
function buildBandPassPrompt(lang, level, deep) {
  const p = PACK[lang];
  const { band } = bandText(lang, level);
  const cap = maxTargetsFor(level, deep);

  // The lesson of the airport diagnosis, stated as the rule it should always
  // have been. The old self-check asked "would a B1 learner name this THING"
  // and so threw away the boarding pass for being visible.
  const wordNotThing = `

JUDGE THE WORD, NOT THE THING. "a carousel", "a kiosk", "a boarding pass",
"a lanyard" are advanced WORDS for perfectly visible objects, and an advanced
word on an ordinary object is exactly what the upper bands want. Never reject an
entry because the OBJECT is obvious; ask only whether the WORD is at the band.`;

  const swap = HIGH_BANDS.has(level)
    ? `

LEVEL SELF-CHECK (${level} only, do this last). Read your labels back one at a
time and ask: would a B1 learner produce this WORD on sight? If yes, SWAP the
entry for a deeper one from the inventory: a part, a material, a state, or the
precise domain word for the same thing. The inventory is built to hold those.
Adding a modifier does not raise the band: "a bucket hat" is still a hat. Drop a
slot only when the inventory truly holds nothing deeper, and prefer a short
round of real ${level} words over a padded one.`
    : LOW_BANDS.has(level)
      ? `

LEVEL SELF-CHECK (${level} only, do this last). Read your labels back one at a
time and ask: is this the word a beginner meets FIRST for this thing? If a
plainer everyday word names the same entry, use the plainer word as the label.
"an espresso machine" is a coffee maker. "a mug" is a cup. "a blazer" is a
jacket. A brand name, a model, a technical term or a specialist compound is
never an ${level} label. If an entry has no plain name, SWAP it for a plainer
entry from the inventory: there is always a hand, a cup, a chair, a shirt.
The learner may still ANSWER with the sharper word and be marked right; that is
handled by the aliases, and it is not a reason to ask with the sharper word.`
      : "";

  return `
You are choosing WORDS for a language learner from the nameable INVENTORY of a
photograph. Someone has already looked at the picture and listed everything in
it; your job is which entries to teach at this level, and what to call them.
${band}${wordNotThing}${swap}

Pick between ${MIN_TARGETS} and ${cap} entries. For each, return:
- "id": the inventory entry's id, copied exactly.
- "label": the word to teach, in ${p.langName}, at this level.
  ${p.articleRule} ${p.pluralRule}
- "difficulty": "easy", "medium" or "hard" for a learner at this level.

Prefer entries SPREAD OUT across the picture over five things on one table, and
entries a learner can point at with confidence over ambiguous ones.

Also return "counts": for EVERY band A1, A2, B1, B2, C1, C2, your honest
estimate of how many inventory entries could serve a round at that band. This is
an estimate from the list, not a promise; it powers an honest "try B2 instead"
when a band comes up short.

Output MUST be valid JSON only, exactly:
{ "targets": [ { "id": 0, "label": "...", "difficulty": "easy" } ],
  "counts": { "A1": 0, "A2": 0, "B1": 0, "B2": 0, "C1": 0, "C2": 0 } }
`.trim();
}

/** The band pass's user turn: the inventory itself, plus the learner's lists. */
function buildBandPassUser(inventory, description, lang, misses, level, exclude, prefer, avoid) {
  const lines = [
    "The inventory. Each line is: id. gloss (granularity)",
    ...inventory.map((e) => `${e.id}. ${e.gloss} (${e.granularity})`),
  ];
  if (misses?.length) {
    lines.push(
      "",
      "This learner has previously failed to name these words. If ANY of them",
      "matches an inventory entry and makes a fair target at this level, include",
      'it and mark it with "revisit": true. Include NONE of them if none is',
      "really there. Do not stretch:",
      misses.map((m) => `- ${m}`).join("\n"),
    );
  }
  if (exclude?.length) {
    lines.push(
      "",
      "This learner has ALREADY been taught these words from this picture. Find",
      "OTHER things. Do not return any of these, or a longer phrase built around",
      "one of them:",
      exclude.map((w) => `- ${w}`).join("\n"),
    );
  }
  lines.push(...preferBlock(prefer));
  lines.push(...avoidBlock(avoid));
  if (description) {
    lines.push("", "What this scene is (for grounding):", description);
  }
  return lines.join("\n");
}

/**
 * Run the band pass and JOIN in code: labels from the model, geometry from the
 * inventory, by id. The model never copies a box, so it can never mangle one.
 */
async function runBandPass(openai, model, inventory, { lang, level, deep, description, misses, exclude, prefer, avoid }) {
  const { jsonrepair } = await import("jsonrepair");
  const resp = await timed("bandpass", () =>
    openai.chat.completions.create({
      model,
      temperature: 0,
      max_tokens: 1200,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: buildBandPassPrompt(lang, level, deep) },
        { role: "user", content: buildBandPassUser(inventory, description, lang, misses, level, exclude, prefer, avoid) },
      ],
    }),
  );
  const raw = resp?.choices?.[0]?.message?.content || "{}";
  let obj;
  try {
    try {
      obj = JSON.parse(raw);
    } catch {
      obj = JSON.parse(jsonrepair(raw));
    }
  } catch (e) {
    const err = new Error(e?.message || "unparseable");
    err.code = "bad_model_json";
    throw err;
  }
  const byId = new Map(inventory.map((e) => [e.id, e]));
  const seen = new Set();
  const chosen = [];
  for (const t of Array.isArray(obj?.targets) ? obj.targets : []) {
    const entry = byId.get(Number(t?.id));
    const label = String(t?.label || "").trim();
    if (!entry || !label || seen.has(entry.id)) continue;
    seen.add(entry.id);
    chosen.push({
      label,
      difficulty: ["easy", "medium", "hard"].includes(t?.difficulty) ? t.difficulty : "medium",
      ...(entry.box ? { box: entry.box } : null),
      ...(entry.boxes ? { boxes: entry.boxes } : null),
      point: entry.point,
      ...(t?.revisit === true ? { revisit: true } : null),
      _invId: entry.id,
    });
  }
  const counts = {};
  for (const b of ["A1", "A2", "B1", "B2", "C1", "C2"]) {
    const n = Number(obj?.counts?.[b]);
    counts[b] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
  }
  return { chosen, counts };
}

/**
 * The nearest band that can field a round, by the band pass's own estimate.
 * Ties prefer the LOWER band, because "come down one" is the kinder offer.
 */
function nearestBand(level, counts) {
  const order = ["A1", "A2", "B1", "B2", "C1", "C2"];
  const at = order.indexOf(level);
  if (at < 0) return "";
  let best = "";
  let bestDist = Infinity;
  for (let i = 0; i < order.length; i++) {
    if (i === at) continue;
    if ((counts?.[order[i]] || 0) < MIN_TARGETS) continue;
    const dist = Math.abs(i - at);
    if (dist < bestDist || (dist === bestDist && i < at)) {
      bestDist = dist;
      best = order[i];
    }
  }
  return best;
}

// ── Prompt (localized per pack) ─────────────────────────────────────────────

const PACK = {
  en: {
    langName: "English",
    articleRule:
      'Write every label as the noun WITH its article, lowercase: "a mug", "the barista", "a window".',
    clozeExample: 'The barista is wearing ___.',
    synonymExample: '"a couch" and "a sofa"; "a cap" and "a hat"',
    regionExample:
      '"swim trunks", "swimming trunks", "trunks", "a bathing suit", "a swimsuit", "board shorts" are all the same garment; so are "a jumper" and "a sweater", "a lift" and "an elevator", "a torch" and "a flashlight"',
    defaultRegion: "American English",
    noteYes:
      'a faucet / a tap, a trash can / a bin, a sweater / a jumper, a flashlight / a torch, sneakers / trainers, an elevator / a lift, swim trunks / a bathing suit / swimming costume, a cookie / a biscuit, an eggplant / an aubergine, an apartment / a flat, a stroller / a pushchair, a diaper / a nappy, the hood / the bonnet, the trunk / the boot',
    noteNo: 'a mug / a cup, a plate / a dish, a sofa / a couch, a pot / a saucepan',
    noteRule:
      'Write it exactly like: In American English you\'ll usually hear "swim trunks". Warm, one sentence, no lecture.',
    pluralRule:
      'Some garments and tools are plural only. Write "swim trunks", "shorts", "trousers", "glasses", "scissors", never an invented singular like "a swim trunk".',
    riddleRule:
      'Write ONLY the words that follow "I spy something ...", lowercase, no article and no final stop.',
    riddleExample: 'Like "red and metal", "small and round", "tall and made of glass".',
  },
  es: {
    langName: "Spanish (neutral Latin American)",
    articleRule:
      'Write every label as the noun WITH its definite article, lowercase: "la taza", "el barista", "la ventana". The article carries the gender, so a label without one is wrong.',
    clozeExample: 'El barista está preparando el café en ___.',
    synonymExample: '"el sofá" y "el sillón"; "la gorra" y "el sombrero"',
    regionExample:
      '"el traje de baño", "el bañador", "la malla", "el short de baño" son la misma prenda; también "la computadora" y "el ordenador", "el celular" y "el móvil", "el elevador" y "el ascensor", "el jugo" y "el zumo"',
    defaultRegion: "Mexican Spanish",
    noteYes:
      'la llave / el grifo / la canilla, la computadora / el ordenador, el celular / el móvil, el jugo / el zumo, la alberca / la piscina, el refrigerador / la nevera, el elevador / el ascensor, el popote / la pajita, los lentes / las gafas, la chamarra / la cazadora, el camión / el autobús, la banqueta / la acera, el clóset / el armario, el fregadero / la pileta',
    noteNo: 'la taza / el pozuelo, el plato / la fuente, el sillón / el sofá',
    noteRule:
      'Write it exactly like: En México se dice más "el traje de baño". Warm, one sentence, no lecture.',
    pluralRule:
      'Some garments and tools are plural only. Write "los pantalones", "los lentes", "las tijeras", never an invented singular.',
    riddleRule:
      'Write ONLY the words that follow "Veo veo... algo ...", lowercase, no article and no final stop. The adjectives agree with "algo", so they are MASCULINE SINGULAR whatever the noun\'s own gender is: "algo roja" is wrong, "algo rojo" is right.',
    riddleExample: 'Like "rojo y de metal", "pequeño y redondo", "alto y de vidrio".',
  },
};

/**
 * The band text both calls share. Extracted when generation was split: the
 * locate call needs it to CHOOSE at the right level, and the enrich call needs
 * it to WRITE at the right level, and two copies would drift apart.
 */
/**
 * How WIDE to cast the net, per band.
 *
 * The complaint this answers: the picks leaned almost entirely on objects the
 * scenario was about, which made low bands nearly unplayable (a networking event
 * has no A1 nouns in its subject matter) and wasted the thousand other nameable
 * things in any photograph. A person is standing there with a hand, a face, hair,
 * a sleeve and a shoe, and none of it was ever offered.
 *
 * The scenario's own words stay the PRIMARY lean at every band, because
 * practising them is the point of the conversation this picture came from. This
 * is additive: it says what to reach for once those are taken, and how far to
 * reach.
 *
 * Kept separate from LEVEL_GUIDE, which answers a different question. That one
 * says how PRECISELY to name a thing; this one says WHICH things are eligible at
 * all. Merging them is how "name the parts" at C1 turned into "only name the
 * parts of the scenario's objects".
 */
const BREADTH = {
  A1: `BREADTH AT THIS BAND. Lead with the words this scene is about, then fill the
round from the UNIVERSAL nameables that are in almost every photograph of people:
parts of the body (a hand, a finger, an arm, hair, an eye, a face), clothes (a
shirt, a shoe, a jacket), and the plainest everyday objects in frame. A beginner
must be able to play ANY picture, and they can only do that if the round is not
limited to what the conversation happened to be about. Prefer a universal word a
beginner already knows over a scene-specific word they do not.`,
  A2: `BREADTH AT THIS BAND. Lead with the words this scene is about, then fill the
round from the UNIVERSAL nameables present in almost any photograph of people:
body parts, clothing, bags, chairs, cups, phones, doors, windows. The scene's own
subject matter will not yield enough words at this level in most pictures, and
padding it with harder ones is the failure. Reach wider instead.`,
  B1: `BREADTH AT THIS BAND. Lead with the words this scene is about, then mix in
ordinary objects from anywhere in the frame. Both halves are fair game; neither
should crowd the other out.`,
  B2: `BREADTH AT THIS BAND. Lead with the words this scene is about, then mix in
specific names for ordinary objects anywhere in the frame. Both halves are fair
game; neither should crowd the other out.`,
  C1: `BREADTH AT THIS BAND. Lead with the words this scene is about, then go as
specific and as technical as the picture honestly allows, ANYWHERE in the frame.
Fine parts, materials, fastenings, trims and fittings all count, and they count on
background objects as much as on the subject. The whole photograph is available,
not just what the conversation was about.`,
  C2: `BREADTH AT THIS BAND. Lead with the words this scene is about, then go as
specific and as technical as the picture honestly allows, ANYWHERE in the frame.
Trade names for parts, materials, and the fine detail of any object in shot are
all in range. The whole photograph is available, not just what the conversation
was about.`,
};

function bandText(lang, level) {
  const guide = level ? LEVEL_GUIDE[lang]?.[level] : "";
  const breadth = level && BREADTH[level] ? `\n\n${BREADTH[level]}` : "";
  const band = guide
    ? `

VOCABULARY LEVEL: ${guide}

Pick targets whose NAMES sit at that level. The things themselves are whatever is
in the picture; the level decides which of them are worth naming and how precisely
to name them.${breadth}`
    : "";
  // The band self-checks that used to be assembled here live in
  // buildBandPassPrompt now, beside the JUDGE-THE-WORD rule the airport
  // diagnosis forced: they are about choosing WORDS, and this function serves
  // the enrich call too, which only ever needed the band description.
  return { band };
}

/**
 * ENRICH: the teaching material, for the targets that survived.
 *
 * Runs AFTER crop verification, so every word written here is written for a
 * target that is really in the picture and really where it claims to be. That
 * is the whole saving: half of what the old single call wrote was thrown away
 * by the crop check a few seconds later.
 *
 * The picture goes with it, because the cloze has to be literally true of THIS
 * scene, and a sentence written from a label alone describes a plausible room
 * rather than the one in frame.
 */
function buildEnrichPrompt(lang, level, labels) {
  const p = PACK[lang];
  const { band } = bandText(lang, level);
  const sentence = SENTENCE_BAND[level]
    ? `

SENTENCE LEVEL: ${SENTENCE_BAND[level]}
This governs the CLUE SENTENCE and the riddle, not the answer word. The answer
word's level is already settled; what is open here is the language wrapped around
it, and a beginner cannot read an A1 noun inside a C2 sentence.`
    : "";

  // Upward credit, and it only needs saying at the low bands. Higher up, the
  // label already IS the precise word and the aliases run the other way.
  const upward = LOW_BANDS.has(level)
    ? `
  * THE SHARPER WORDS TOO, and this matters most at this band. The label is the
    PLAIN word because that is what a beginner should be asked for; a learner who
    happens to know a better one must never be told they are wrong for it. If the
    label is "a cup", then "an espresso cup", "a coffee cup", "a teacup" and
    "a mug" all belong here. If it is "a coffee maker", then "an espresso
    machine" and "a coffee machine" belong here. Ask plainly, accept generously.`
    : "";

  return `
You are looking at a photorealistic illustration from a language-learning
conversation. Someone has already chosen the words this round will teach and
checked that each one is really in the picture. Your job is to write the round
for them.${band}${sentence}

Write for EVERY one of these, in this order, and change none of them:
${labels.map((l, i) => `${i + 1}. ${l}`).join("\n")}

Every string must be in ${p.langName}. Return JSON only, no markdown.

For each one return:
- "label": copied back exactly as it was given, so entries can be matched up.
- "cloze": ONE natural sentence about this picture, in ${p.langName}, with the
  target word replaced by exactly three underscores: ___
  Example: "${p.clozeExample}"
  The sentence must NOT contain the answer word anywhere else, and must read like
  something a person would say, at the SENTENCE LEVEL given above.
  It must also be LITERALLY TRUE OF THIS IMAGE. Describe only what is actually
  depicted: do not write "holding" unless the thing is in someone's hand, do not
  write "wearing" unless it is on their body, do not write "on the table" unless
  it is on the table. A sentence that describes a plausible scene rather than
  THIS scene will be answered correctly and marked wrong.
- "choices": exactly 4 options - the label itself plus 3 plausible wrong answers
  in the same language and the same style (same kind of thing, same article
  form). A distractor should be temptingly wrong, not absurd.
- "aliases": up to ${MAX_ALIASES} OTHER ways a learner could correctly name this same thing,
  each of which you would accept as right. Anything listed here is marked
  correct, so it must be a real name for THIS object, and must not repeat any of
  the wrong choices.
  Be generous. This is what stops a learner who knows the word being told they
  are wrong for knowing a different one. Include:
  * the bare noun without its article;
  * a shorter everyday form of a compound ("monitor" for "a computer monitor");
  * every common SYNONYM (${p.synonymExample});
  * every common REGIONAL VARIANT, including the ones from other countries
    (${p.regionExample}).${upward}
- "americanNote": include this field when the names above differ BY REGION OR
  COUNTRY and one of them is the usual one in ${p.defaultRegion}.
  THE TEST IS THE LIST YOU JUST WROTE. If any two names in your own "aliases"
  are used in different countries or different regions, this field is REQUIRED.
  Pairs like these DO earn a note whenever they appear: ${p.noteYes}.
  Ordinary synonyms do NOT: ${p.noteNo}. Those are two words everyone uses, and
  a note about them teaches something false. Omit the field entirely for those,
  and for any target whose name is the same everywhere.
  One short sentence in ${p.langName}, addressed to the learner, naming the form
  they will actually hear. ${p.noteRule}
- "near": up to 4 answers a learner might REASONABLY give for this thing that are
  NOT its name and must NOT be accepted as it. These are descriptions and
  neighbouring words, not synonyms: anything you would accept belongs in
  "aliases" instead, and putting a real name here would make a right answer
  wrong.
  For "a ceiling leak" they are "a hole", "water damage", "a stain", "a crack".
  For "a colander" they are "a bowl", "a strainer" only if a strainer is a
  DIFFERENT object here, "a pot".
  The game uses these to say "close, but I want the exact word" and hand the
  turn back without charging a guess, so a wrong entry here costs the learner
  nothing; an entry that is really a synonym costs them a correct answer.
  Omit the field when nothing plausible comes to mind.
- "riddle": the ATTRIBUTES of this thing and nothing else, in ${p.langName}, for
  the game "I spy something red". ${p.riddleRule}
  Two or three attributes at most, from what is actually visible: colour first,
  then material, size or shape. ${p.riddleExample}
  It MUST NOT contain the noun, or any word from the noun, or any word that
  names what the thing IS. "small and red" is a riddle; "a small red toolbox" is
  the answer. Omit the field if the thing has no attribute worth saying.

Before you answer, re-read every sentence you wrote and drop or rewrite any that
is not literally true of this image, and any cloze or riddle that still contains
its own answer.

Output MUST be valid JSON only, exactly:
{ "targets": [ { "label": "...",
                 "cloze": "...", "choices": ["...","...","...","..."],
                 "aliases": ["...","..."],
                 "near": ["...","..."],
                 "americanNote": "...",
                 "riddle": "..." } ] }
`.trim();
}

// ── Model truth ─────────────────────────────────────────────────────────────
//
// A box is a claim, and until v6 nothing ever checked it. The fifth playtest
// filmed the cost: a zoom on "the parking sign" showed trees and street, and
// "where is the parking ticket" rejected taps on a ticket that was plainly
// there. The generating call cannot audit itself, because it can see the whole
// picture and the thing it named IS somewhere in that picture, so it agrees.
//
// So each box is cut out and shown to the model ON ITS OWN. With nothing else
// in frame there is nothing to be reminded of: either the crop shows the thing
// or it does not.

/** How many crops to have in the air at once. */
// Raised with the flat job pool: the work is now one crop check per INSTANCE
// across the whole set, not one per target, so there is more of it and it is
// finer grained. These are low-detail calls on a small crop, which is the
// cheapest request this route makes.
// Raised again with the twelve-target pool: the work is one check per INSTANCE,
// so a set half again as long with several instances apiece is comfortably more
// than six jobs, and six slots turned the tail of it back into a queue.
const VERIFY_CONCURRENCY = 12;

function verifyPrompt(label, langName) {
  return `You are shown a small crop taken from a larger photograph.
Answer about the crop ALONE. You cannot see the rest of the photo and must not
guess what is outside the crop.

Question 1: is "${label}" (${langName}) visible in this crop at all?

Say yes ONLY if the thing itself is in the crop and a learner shown this crop
could point at it. Say no if it is absent, if it is cut off past recognition, if
you can only infer it from context, or if what is here is a different object
that merely sits near it.

Question 2, only if yes: how much of this crop IS the thing?

  "main" the thing is what this crop is a picture of, plainly identifiable
  "part" clearly there and identifiable, but sharing the crop with other things
  "edge" only a fragment, or off at the side, or you had to hunt for it

Be strict about "edge". A crop that is mostly a table, some papers and an arm,
with a sliver of the thing behind them, is "edge" however certain you are that
the thing is there.

Return JSON only: { "shows": true, "prominence": "main" }
or { "shows": false, "why": "<six words>" }`;
}

async function askCrop(openai, model, crop, label, langName) {
  try {
    const resp = await openai.chat.completions.create({
      model,
      temperature: 0,
      max_tokens: 60,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: verifyPrompt(label, langName) },
            { type: "image_url", image_url: { url: crop, detail: "low" } },
          ],
        },
      ],
    });
    const parsed = JSON.parse(resp?.choices?.[0]?.message?.content || "{}");
    const prom = String(parsed?.prominence || "").toLowerCase();
    return {
      shows: parsed?.shows === true,
      why: String(parsed?.why || "").slice(0, 60),
      // Unrated but shown is treated as "part": good enough to score, not
      // asserted to be worth cropping.
      prominence: PROMINENCE.has(prom) ? prom : "part",
    };
  } catch (e) {
    // A verification that could not be run is NOT a failure of the target. The
    // alternative, dropping targets when the checker itself breaks, empties
    // rounds for a reason that has nothing to do with the picture.
    console.warn("[convo-image-targets] verify call failed:", e?.message || e);
    return { shows: true, why: "verifier unavailable", prominence: "part" };
  }
}

/** "Point at it again, tightly." One attempt, on the whole picture. */
async function relocalize(openai, model, imageUrl, label, langName) {
  try {
    const resp = await openai.chat.completions.create({
      model,
      temperature: 0,
      max_tokens: 120,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Find "${label}" (${langName}) in this photograph and give its bounding box.
A previous attempt pointed at the wrong place, so look again and be exact.
The box must HUG the thing: x and y are its top-left corner as fractions of the
image from the left and top edges, w and h its width and height as fractions.
If "${label}" is genuinely not in this photograph, say so instead of guessing.
Return JSON only: { "box": { "x": 0.0, "y": 0.0, "w": 0.0, "h": 0.0 } }
or { "absent": true }`,
            },
            { type: "image_url", image_url: { url: imageUrl, detail: "high" } },
          ],
        },
      ],
    });
    const parsed = JSON.parse(resp?.choices?.[0]?.message?.content || "{}");
    if (parsed?.absent === true) return null;
    return unitBox(parsed?.box);
  } catch (e) {
    console.warn("[convo-image-targets] relocalize failed:", e?.message || e);
    return null;
  }
}

/** Run `jobs` with a cap on how many are in flight at once. */
async function pooled(jobs, limit) {
  const out = new Array(jobs.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, jobs.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= jobs.length) return;
      out[i] = await jobs[i]();
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Crop-check every target, re-localize the failures once, drop what is still
 * wrong. Returns the surviving targets, each stamped with what was decided.
 *
 * Every box a target carries is checked, not just the first: with two parking
 * tickets in frame, a second box that points at a wing mirror would score a tap
 * on the wing mirror.
 */
async function verifyTargets(openai, model, imageUrl, targets, lang) {
  const langName = PACK[lang].langName;
  // Every call below this line is a judgment, not a generation. See
  // pickCheckModel for why they run somewhere cheaper than `model`.
  const check = pickCheckModel();
  let size = null;
  try {
    size = await timed("imageSize", () => imageSize(imageUrl));
  } catch (e) {
    console.warn("[convo-image-targets] could not size image, skipping verification:", e?.message || e);
    return targets;
  }

  // 1) What each target will have checked: the boxes it arrived with.
  //
  //    There used to be a separate enumeration call here, a second vision
  //    request costing four to eight seconds, asking the model to go and find
  //    every instance of the labels it had just chosen. In v8 the LOCATE call
  //    does that itself — the COUNT CHECK is in its prompt — so the instances
  //    are already in `boxes` by the time this runs, and asking again was
  //    paying twice for one answer.
  //
  //    This is also the right shape for a row cached before any of this existed:
  //    it comes in with whatever boxes it has, and is judged on those.
  const plan = targets.map((t) => {
    const original = Array.isArray(t.boxes) && t.boxes.length ? t.boxes : t.box ? [t.box] : [];
    return {
      t,
      cands: original.slice(0, MAX_INSTANCES).map((box) => ({ box, visibility: "partial" })),
    };
  });

  // 3) Every candidate of every target, checked in ONE pool rather than one
  //    pool per target. A label with six instances no longer serializes six
  //    calls behind itself while three other labels wait for a slot.
  const jobs = [];
  plan.forEach((p, ti) =>
    p.cands.forEach((c, ci) =>
      jobs.push(async () => {
        const crop = await timed("crop.cut", () => cropRegion(imageUrl, c.box, size));
        // Could not be cut: not the target's fault, so it stays unjudged, and
        // unjudged is not evidence that it would make a good crop.
        if (!crop) return { ti, ci, shows: true, prominence: "part" };
        const a = await timed("crop.ask", () => askCrop(openai, check, crop, p.t.label, langName));
        return { ti, ci, shows: a.shows, why: a.why, prominence: a.prominence };
      }),
    ),
  );
  const verdicts = await pooled(jobs, VERIFY_CONCURRENCY);

  const byTarget = plan.map(() => []);
  const notes = plan.map(() => []);
  for (const v of verdicts) {
    if (!v) continue;
    const cand = plan[v.ti].cands[v.ci];
    // A sliver still SCORES: it is a real instance of the thing and a learner
    // who taps it is right. What it does not do is earn the right to be cropped.
    if (v.shows) byTarget[v.ti].push({ ...cand, prominence: v.prominence });
    else notes[v.ti].push(v.why);
  }

  // 4) A target nothing survived on gets the one last chance v6 gave it. Only
  //    reached when enumeration found nothing either, so it is rare now.
  const rescues = await pooled(
    plan.map((p, ti) => async () => {
      // Only for a target that HAD somewhere to look and lost it. A target with
      // no box at all is the row-cached-before-boxes-existed case, and it comes
      // back the exact shape it went in as: rescuing it would invent a location
      // for a target whose whole point is that it has none, which is how the
      // rim-point target came back pointing at the middle of the picture.
      if (byTarget[ti].length || !p.cands.length) return null;
      const again = await timed("relocalize", () =>
        relocalize(openai, check, imageUrl, p.t.label, langName),
      );
      if (!again) return null;
      const crop = await timed("crop.cut", () => cropRegion(imageUrl, again, size));
      if (!crop) return null;
      const a = await timed("crop.ask", () => askCrop(openai, check, crop, p.t.label, langName));
      return a.shows ? { ti, box: again, visibility: a.prominence || "partial" } : null;
    }),
    VERIFY_CONCURRENCY,
  );
  for (const r of rescues) if (r) byTarget[r.ti].push({ box: r.box, visibility: r.visibility });

  const checked = plan.map((p, ti) => {
    const t = p.t;
    // A target that arrived with nothing to look at keeps its shape exactly, so
    // a row cached before boxes existed comes back as it went in.
    if (!p.cands.length && !byTarget[ti].length) return t;
    const kept = byTarget[ti];
    if (!kept.length) {
      return { ...t, boxOk: false, boxWhy: notes[ti][0] || "not in crop" };
    }
    // Most visible first, so box[0] is the one the marker and the crops use.
    //
    // Ranked on the CROP first and the scene second. Prominence was judged on
    // the cut-out itself, which is the thing a crop-based mode will actually
    // show, and the scene rating only breaks its ties.
    kept.sort(
      (a, b) =>
        PROMINENCE_ORDER.indexOf(a.prominence) - PROMINENCE_ORDER.indexOf(b.prominence) ||
        VISIBILITY_ORDER.indexOf(a.visibility) - VISIBILITY_ORDER.indexOf(b.visibility),
    );
    const boxes = kept.map((k) => k.box);
    const first = boxes[0];
    // `boxes` is stripped off before the spread, not overwritten after it.
    // Spreading the original first and then conditionally re-adding meant a
    // target whose second instance was rejected kept the rejected instance
    // anyway, because the conditional adds nothing when there is one left and
    // the old array was already through the door. A tap on the wing mirror
    // would still have scored.
    const { boxes: _dropped, ...rest } = t;
    return {
      ...rest,
      box: first,
      ...(boxes.length > 1 ? { boxes } : null),
      // How well each kept instance can be seen, in the same order as `boxes`.
      vis: kept.map((k) => k.visibility),
      // Whether ANY instance is worth cutting out and showing. False excludes
      // this target from the crop-based modes for this picture; it stays a
      // perfectly good name and find target, because a box that is right is
      // still right even when the view of it is poor.
      cropOk: CROP_GATE.has(kept[0].prominence),
      // The point follows the box it belongs to, or the marker keeps pointing
      // at where the box used to be.
      point: { x: clampPoint(first.x + first.w / 2), y: clampPoint(first.y + first.h / 2) },
      boxOk: true,
    };
  });

  const dropped = checked.filter((t) => t.boxOk === false);
  if (dropped.length) {
    console.log(
      `[convo-image-targets] crop check dropped ${dropped.length}/${targets.length}: ` +
        dropped.map((t) => `${t.label} (${t.boxWhy})`).join("; "),
    );
  }
  return checked.filter((t) => t.boxOk !== false);
}

function clampPoint(v) {
  return Math.min(1 - POINT_INSET, Math.max(POINT_INSET, v));
}

/**
 * The model client, or null.
 *
 * A function rather than an inline construction because the cache-read path now
 * needs one too: a row written before boxes were ever checked gets checked as
 * it is read, and that read happens well before the generation path builds its
 * client. The openai v4 constructor throws synchronously on a missing key, so
 * this degrades rather than 500s, exactly as the inline version did.
 */
async function tryOpenAI() {
  try {
    const modAI = await import("openai");
    return new modAI.OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  } catch (e) {
    console.error("[convo-image-targets] openai init failed:", e?.message || e);
    return null;
  }
}

/**
 * The model for the JUDGMENTS, as opposed to the generation.
 *
 * Three of the four model calls in a scan are not creative work: "does this
 * crop show a lanyard", "where are the instances of these labels", "draw that
 * box again". They are binary or near-binary, they look at one small crop or
 * one picture with a closed list, and Stage 0 measured them at 8.1s
 * (enumeration) and 8.9s (thirteen crop checks) on the same model the
 * generation uses.
 *
 * gpt-4.1-nano was measured here in v8 and REJECTED. It is genuinely faster —
 * enumeration 8.1s -> 6.2s, thirteen crop checks 3.5s -> 1.4s of wall clock,
 * about 3s off a 25.7s scan — but it is also stricter, and it rejected one more
 * target per scan than gpt-4.1-mini did on both scenes tested (5 kept where
 * mini kept 6, twice each).
 *
 * One target is not a rounding error here, because the floor is five. Dropping
 * one more lands the pool ON the floor, and the scan that lands on the floor is
 * one bad crop away from firing the 13s top-up. That is exactly what happened:
 * networking-1 went from 16.4s on mini to 35.6s on nano, because nano's extra
 * attrition re-triggered the round trip the twelve-target pool had just
 * eliminated. Three seconds saved, thirteen risked.
 *
 * So the default is the generation model, and this is a seam rather than a
 * decision: set LUX_AI_CHECK_MODEL to try another judge without a code change.
 * A cheaper model becomes worth re-testing if the floor ever stops being the
 * thing that turns one lost target into a second round trip.
 */
function pickCheckModel() {
  return (process.env.LUX_AI_CHECK_MODEL || "").toString().trim() || pickModel();
}

function pickModel() {
  return (
    (process.env.LUX_AI_VISION_MODEL || "").toString().trim() ||
    (process.env.LUX_AI_QUICK_MODEL || "").toString().trim() ||
    (process.env.LUX_AI_MODEL || "").toString().trim() ||
    "gpt-4.1-mini"
  );
}

/**
 * Write the row. AWAITED by every caller, for the reason the generation path
 * documents at length: a promise scheduled and abandoned as the handler
 * responds is a cache that never fills, and the failure is invisible because
 * the game still works.
 */
async function writeRow(sb, { imageKey, lang, level, targets, model }) {
  if (!sb) return;
  try {
    const { error } = await timed("db.write", () =>
      sb.from("image_targets").upsert(
        {
          image_key: imageKey,
          lang,
          level,
          v: TARGETS_V,
          verified: VERIFIED_V,
          targets,
          model,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "image_key,lang,level" },
      ),
    );
    if (error) console.warn("[convo-image-targets] cache write failed:", error.message);
  } catch (e) {
    console.warn("[convo-image-targets] cache write failed", e?.message || e);
  }
}

/**
 * Bring a thin set back up to the floor, once, with one extra ask.
 *
 * Called from BOTH paths on purpose. A fresh scan and a cached row being
 * re-examined lose targets the same way (the crop check drops what it cannot
 * see), so a row that heals from five targets down to four has exactly the
 * problem this exists to fix, and the first cut of this only guarded the fresh
 * path: the healed row was written thin and stayed thin.
 */
/**
 * Write the round, for the targets that survived the crop check.
 *
 * ONE call for the whole set rather than one per target. The picture is the
 * expensive part of a vision request and sending it six times to write six
 * clozes would cost six times the input tokens to save nothing: these are
 * output-bound, and six short answers in one response take about as long as one.
 *
 * A target the model declines to write for, or writes badly enough to fail
 * validation, is DROPPED rather than shipped bare. Every mode in the game reads
 * these fields — naming needs the choices, the riddle mode needs the clue, the
 * hint ladder needs the cloze — so a target without them is not a smaller
 * target, it is a broken one.
 */
async function enrichTargets(openai, model, imageUrl, targets, { lang, level, seed }) {
  if (!targets.length) return targets;

  let byLabel = new Map();
  try {
    const { jsonrepair } = await import("jsonrepair");
    const resp = await timed("enrich", () =>
      openai.chat.completions.create({
        model,
        temperature: 0,
        max_tokens: 2800,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: buildEnrichPrompt(lang, level, targets.map((t) => t.label)) },
          {
            role: "user",
            content: [
              { type: "text", text: buildEnrichUserText(lang) },
              // "low" detail: this call is writing ABOUT things whose location is
              // already settled, so it needs the gist of the scene rather than
              // the pixels. The locate call is the one that had to see clearly.
              { type: "image_url", image_url: { url: imageUrl, detail: "low" } },
            ],
          },
        ],
      }),
    );
    const txt = resp?.choices?.[0]?.message?.content || "{}";
    let obj;
    try {
      obj = JSON.parse(txt);
    } catch {
      obj = JSON.parse(jsonrepair(txt));
    }
    for (const raw of Array.isArray(obj?.targets) ? obj.targets : []) {
      const key = fold(String(raw?.label || ""));
      if (key && !byLabel.has(key)) byLabel.set(key, raw);
    }
  } catch (e) {
    console.warn("[convo-image-targets] enrich failed:", e?.message || e);
    return [];
  }

  const out = [];
  for (const base of targets) {
    const full = applyEnrichment(base, byLabel.get(fold(base.label)), lang, seed);
    if (full) out.push(base.revisit ? { ...full, revisit: true } : full);
  }
  if (out.length < targets.length) {
    console.log(
      `[convo-image-targets] enrich kept ${out.length}/${targets.length} (lang=${lang} level=${level || "-"})`,
    );
  }
  return out;
}

async function topUpIfThin(openai, model, imageUrl, { sb, imageKey, description, lang, level, targets, exclude, prefer, avoid, misses, deep, inventory, offeredIds = [] }) {
  const floor = deep ? DEEP_MIN_TARGETS : MIN_TARGETS;
  if (!targets.length || targets.length >= floor || !imageUrl) return targets;
  // A deep ask may deepen TWICE; an ordinary one once. Each pass must see what
  // the last one added, or the second would mine for the same entries again.
  const rounds = deep ? 2 : 1;
  let out = targets;
  let inv = inventory || null;
  for (let n = 0; n < rounds && out.length < floor; n++) {
    const before = out.length;
    // eslint-disable-next-line no-await-in-loop -- see above.
    const grew = await withPhase("topup", () =>
      runDeepen(openai, model, imageUrl, {
        sb, imageKey, description, lang, level,
        targets: out, exclude, prefer, avoid, misses, deep, inventory: inv,
        offeredIds,
      }),
    );
    out = grew.targets;
    inv = grew.inventory;
    if (out.length === before) break; // the picture has nothing else to give
  }
  return out;
}

/**
 * DEEPEN: mine the inventory for entries it does not yet hold, then band-pass
 * the mined entries alone.
 *
 * This is the old top-up reborn as what Stage C asks for: a draw that cannot
 * fill does not re-ask the same question louder, it goes back to the picture
 * for a GRANULARITY not yet used. The mined entries join the cached inventory,
 * so every later band and every Lightning bank inherits them for free.
 *
 * Band-passing ONLY the mined entries is what keeps this from re-offering the
 * words the round already holds; the head-word and referent filters below are
 * the same two the old top-up used, kept because attrition still needs them.
 */
async function runDeepen(openai, model, imageUrl, { sb, imageKey, description, lang, level, targets, exclude, prefer, avoid, misses, deep, inventory, offeredIds = [] }) {
  const before = targets.length;
  let inv = inventory || (await readInventory(sb, imageKey)) || [];
  let out = targets;

  // The two filters every appended candidate goes through: no second marker on
  // one head word, and no second name for one referent. Both copied whole from
  // the old top-up, because attrition is the same problem it always was.
  const key = (l) => headWord(l, lang) || headNoun(l, lang) || fold(l);
  const taken = new Set(out.map((t) => key(t.label)));
  const keptBoxes = out
    .map((t) => (Array.isArray(t.boxes) && t.boxes.length ? t.boxes[0] : t.box))
    .filter(Boolean);
  const appendFrom = async (slice) => {
    const pass = await runBandPass(openai, model, slice, {
      lang, level, deep, description, misses, exclude, prefer, avoid,
    });
    const fresh = sanitizeLocatedList(pass.chosen, lang, level, deep).filter((m) => {
      const head = key(m.label);
      if (taken.has(head)) return false;
      const mine = Array.isArray(m.boxes) && m.boxes.length ? m.boxes[0] : m.box;
      if (mine && keptBoxes.some((b) => iou(b, mine) >= SAME_REFERENT_IOU)) {
        console.log(`[convo-image-targets] deepen dropped "${m.label}": same referent as a kept target`);
        return false;
      }
      taken.add(head);
      if (mine) keptBoxes.push(mine);
      return true;
    });
    if (!fresh.length) return;
    const okFresh = await verifyTargets(openai, model, imageUrl, fresh, lang);
    out = [...out, ...okFresh].slice(0, maxTargetsFor(level, deep));
  };

  try {
    // STEP 0, and usually the whole fix: REDRAW from the entries this band was
    // never offered. The inventory routinely holds dozens the first pass did
    // not pick, a redraw is one cheap text call, and a mine is a vision call:
    // paying for new pixels while unread entries sit in the row would be the
    // old top-up's mistake wearing a new name.
    const offered = new Set(offeredIds);
    const unused = offered.size ? inv.filter((e) => !offered.has(e.id)) : [];
    if (unused.length) {
      await appendFrom(unused);
      unused.forEach((e) => offered.add(e.id));
      if (out.length > before) {
        console.log(
          `[convo-image-targets] deepen redraw ${before} -> ${out.length} (no mine needed, key=${imageKey} level=${level || "-"})`,
        );
      }
      if (out.length >= (deep ? DEEP_MIN_TARGETS : MIN_TARGETS)) {
        return { targets: out, inventory: inv };
      }
    }

    const { entries: mined } = await runInventory(openai, model, imageUrl, {
      description,
      lang,
      exclude,
      prefer,
      taken: inv.map((e) => e.gloss),
      wantGrans: thinnestGranularities(inv),
      startId: inv.reduce((m, e) => Math.max(m, e.id + 1), 0),
    });
    if (!mined.length) {
      console.log(`[convo-image-targets] deepen mined nothing (key=${imageKey} level=${level || "-"})`);
      return { targets: out, inventory: inv };
    }
    inv = [...inv, ...mined];
    await writeInventory(sb, imageKey, inv);
    await appendFrom(mined);
  } catch (e) {
    // A deepen that fails leaves the round exactly as good as it was.
    console.warn("[convo-image-targets] deepen failed:", e?.message || e);
  }
  console.log(
    `[convo-image-targets] deepen ${before} -> ${out.length} (inventory ${inv.length}, key=${imageKey} level=${level || "-"})`,
  );
  return { targets: out, inventory: inv };
}

/**
 * The enrich call's user turn. Deliberately thin: the labels and every rule are
 * in the system prompt, and the description is NOT repeated here. The writing
 * has to be true of the picture in front of it, and a scene description would
 * give it a second, wordier account of the room to write from when the actual
 * room is attached.
 */
function buildEnrichUserText(lang) {
  return `Write the round for the listed words. Answer in ${PACK[lang].langName}.`;
}

/**
 * The preference block, shared by generation and the top-up.
 *
 * One function because the two calls must say the SAME thing about it. The
 * top-up is where this matters most and where it was missing: a top-up is
 * already asking "what else is in here", which is exactly the moment to reach
 * for a word the learner is working on rather than for whatever is left.
 *
 * Deliberately weaker language than the exclude list, which is a hard rule. This
 * one can only ever be a preference: a word planted in a picture that does not
 * contain it is a question with no answer, which is worse than never revisiting
 * it. The last line is the one that does the work.
 */
function preferBlock(prefer) {
  if (!prefer?.length) return [];
  return [
    "",
    "This learner is already working on the words below: some they have kept, some",
    "have beaten them before. If any of them is genuinely present in this image and",
    "would make a fair target under every rule above, PREFER it over an equally good",
    "alternative. This is a preference and nothing more. Do not stretch a label to",
    "match one, do not name something that is not clearly there, and return none of",
    "them if none is really in the picture:",
    prefer.map((w) => `- ${w}`).join("\n"),
  ];
}

/**
 * The soft steer away from what this learner met on OTHER pictures.
 *
 * Weaker than the exclude list on purpose, and the wording carries the whole
 * distinction. `exclude` is a rule and can be, because it is per picture and the
 * picture still holds everything else. This one crosses pictures, and a second
 * cafe genuinely does contain a cup: refusing to ever teach it again would be a
 * worse failure than teaching it twice. So it says "when the picture offers an
 * alternative", and says outright that returning one of them is fine when it
 * does not.
 */
function avoidBlock(avoid) {
  if (!avoid?.length) return [];
  return [
    "",
    "This learner has met the words below very recently, on OTHER pictures. Where",
    "this picture offers an equally good alternative, choose the alternative, so",
    "that two similar scenes do not teach the same handful of obvious objects.",
    "This is a steer and not a rule. If one of them is genuinely among the best",
    "targets here, keep it: a repeat is a much smaller failure than a bad target",
    "or a thin round.",
    avoid.map((w) => `- ${w}`).join("\n"),
  ];
}

// ── Handler ─────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  // One stopwatch per request, closed however the scan exits. The report is a
  // `finally` because the exits that matter most for latency are the early
  // ones — a cache hit, a heal, a regeneration — and a report wired only to
  // the happy path would measure the one route nobody is waiting on.
  return withTiming("scan", async () => {
    try {
      return await scan(req, res);
    } finally {
      report();
      // The picture this scan cut its crops from. A warm container that kept it
      // would hold the last photo of every scan it ever served.
      await releaseSource().catch(() => {});
    }
  });
}

async function scan(req, res) {
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
  const rawBody = req.body || {};
  // A follow-up: "the round I started is playing, send me the rest of it".
  //
  // It decodes to exactly the three fields that identify the row, and then this
  // is an ordinary key-only probe. The tail of the first request writes that
  // row, so there is nothing else to look up and nothing to keep in step: if
  // the tail has landed the full set comes back as a cache hit, and if it has
  // not, the probe misses and the round plays on with what it already has.
  const body = rawBody.scanId
    ? { ...rawBody, ...parseScanId(rawBody.scanId) }
    : rawBody;
  // Region-tolerant: "es", "ES" and "es-MX" are all the Spanish pack. Anything
  // else is English, the same closed two-value space every other route uses.
  const langRaw = (body.lang || body.pack || "en").toString().trim().toLowerCase();
  const lang = langRaw === "es" || langRaw.startsWith("es-") ? "es" : "en";

  // CEFR band for the words this round should teach. Absent means "whatever
  // the model thinks", which is exactly what every row cached before levels
  // existed holds, so absent is stored as "" and keeps serving those rows.
  const levelRaw = (body.level || "").toString().trim().toUpperCase();
  const level = CEFR_VALUES.has(levelRaw) ? levelRaw : "";

  // Offered to the scan, never part of the cache key: a cached row is a
  // property of the picture, and keying it by who is asking would give every
  // learner a private copy of every scan.
  const misses = (Array.isArray(req.body?.misses) ? req.body.misses : [])
    .map((m) => String(m || "").trim().slice(0, 60))
    .filter(Boolean)
    .slice(0, MAX_MISSES_OFFERED);
  // Head words this learner has already been taught from this picture. Like
  // misses, offered to the scan and never part of the cache key: a cached row
  // is a property of the picture, and keying it by who is asking would give
  // every learner a private copy of every scan.
  const exclude = (Array.isArray(body?.exclude) ? body.exclude : [])
    .map((w) => String(w || "").trim().slice(0, 60))
    .filter(Boolean)
    .slice(0, MAX_EXCLUDED);
  // What this learner is already working on. Deduped against `misses` and against
  // `exclude`: a missed word already has its own, stronger instruction and its
  // own revisit marking, and a word this picture has already taught is on the
  // do-not-return list, so naming it here as well would be the same prompt
  // asking for a word and forbidding it in two places.
  const preferSeen = new Set([...misses, ...exclude].map((w) => w.toLowerCase()));
  const prefer = (Array.isArray(body?.prefer) ? body.prefer : [])
    .map((w) => String(w || "").trim().slice(0, 60))
    .filter((w) => {
      // One pass, which also self-dedupes: the caller merges two of its own
      // lists and they overlap on any word that was both saved and missed.
      const k = w.toLowerCase();
      if (!w || preferSeen.has(k)) return false;
      preferSeen.add(k);
      return true;
    })
    .slice(0, MAX_PREFERRED);
  // Words met lately on OTHER pictures. Deduped against everything already
  // spoken for, and above all against `prefer`: a word the learner is working on
  // must never be asked for and steered away from in the same prompt.
  const avoidSeen = new Set([...misses, ...exclude, ...prefer].map((w) => w.toLowerCase()));
  const avoid = (Array.isArray(body?.avoid) ? body.avoid : [])
    .map((w) => String(w || "").trim().slice(0, 60))
    .filter((w) => {
      const k = w.toLowerCase();
      if (!w || avoidSeen.has(k)) return false;
      avoidSeen.add(k);
      return true;
    })
    .slice(0, MAX_AVOIDED);
  // A DEEP scan: more targets, at the cost of more time. Lightning asks for this
  // because a sprint burns through an ordinary pool in one lap. Not part of the
  // cache key: a deeper row is strictly better for every caller, so it upgrades
  // the same row rather than forking a second one.
  const deep = body?.deep === true;
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
      const { data, error } = await timed("db.read", () =>
        sb
          .from("image_targets")
          .select("targets, v, verified")
          .eq("image_key", imageKey)
          .eq("lang", lang)
          .eq("level", level)
          .maybeSingle(),
      );
      // PostgREST reports failure in `error` rather than by rejecting, so an
      // unchecked read makes a missing table or an anon-key RLS block look
      // exactly like a cache miss: the game keeps working and silently re-bills
      // a vision call every time, with nothing in the logs to say why.
      if (error) console.warn("[convo-image-targets] cache read failed:", error.message);
      if (data?.v === TARGETS_V && Array.isArray(data.targets) && data.targets.length) {
        // A cached row is answered against the rules AS THEY ARE NOW, not as
        // they were the day it was written. The fourth playtest was asked
        // "Where is the sand?" from a row that predated the no-surfaces rule;
        // the prompt had been fixed and the cache had not, and nothing between
        // them looked.
        const kept = data.targets.filter((t) => {
          const bad = ruleFailure(t, lang, level);
          if (bad) {
            console.log(
              `[convo-image-targets] dropped cached target (${bad}) key=${imageKey} level=${level || "-"}`
            );
          }
          return !bad;
        });

        // Serve unless the round has been gutted. Regeneration is one more
        // vision call, so it is worth paying only when what survives will not
        // make a game. A row that lost nothing is served whatever its length:
        // it was already written under these rules, and asking the model again
        // would return the same short set at the same price, every single play.
        const dropped = data.targets.length - kept.length;
        const servable = kept.length && (dropped === 0 || kept.length >= MIN_SERVED_TARGETS);

        // Every row written before v6 has boxes nobody ever looked at. They get
        // crop-checked ONCE, here, on the next read, and the result is written
        // back so the next play is free. This is the half that matters: the
        // rules and the checks were always applied to fresh generations, and
        // the pictures a learner has already played are precisely the ones
        // nobody re-examined.
        const hasBoxes = kept.some((t) => t.box || (Array.isArray(t.boxes) && t.boxes.length));
        if (servable && data.verified !== VERIFIED_V && !hasBoxes) {
          // Nothing to look at. Stamp it so this row is never re-examined, and
          // serve it: a set cached before boxes existed cannot be crop-checked
          // and is not wrong for that.
          await writeRow(sb, { imageKey, lang, level, targets: kept, model: pickModel() });
          if (!(deep && kept.length < DEEP_MIN_TARGETS)) {
            return res.status(200).json({ ok: true, cached: true, imageKey, lang, targets: kept });
          }
        }
        if (servable && data.verified !== VERIFIED_V && imageUrl) {
          const openaiForCheck = await tryOpenAI();
          if (openaiForCheck) {
            const model = pickModel();
            let checked = await verifyTargets(openaiForCheck, model, imageUrl, kept, lang);
            // Held to the same floor as a fresh scan. Re-examination drops
            // targets exactly the way generation does, so a row that heals from
            // five down to four is thin for the same reason and gets the same
            // one extra ask.
            checked = await topUpIfThin(openaiForCheck, model, imageUrl, {
              sb, imageKey, description, lang, level, targets: checked, exclude, prefer, avoid, misses, deep,
            });
            if (checked.length >= MIN_SERVED_TARGETS || checked.length === kept.length) {
              await writeRow(sb, { imageKey, lang, level, targets: checked, model });
              return res
                .status(200)
                .json({ ok: true, cached: true, imageKey, lang, targets: checked });
            }
            // Verification gutted the row. Fall through and regenerate: the
            // boxes were wrong, so re-serving them would be re-serving the bug.
            console.log(
              `[convo-image-targets] crop check left ${checked.length}/${kept.length}, regenerating ` +
                `(key=${imageKey} level=${level || "-"})`,
            );
          }
        } else if (servable && !(deep && kept.length < DEEP_MIN_TARGETS)) {
          return res.status(200).json({ ok: true, cached: true, imageKey, lang, targets: kept });
        }
        if (imageUrl) {
          console.log(
            `[convo-image-targets] regenerating: ${kept.length}/${data.targets.length} cached ` +
              `targets survived current rules (key=${imageKey} level=${level || "-"})`
          );
        } else if (kept.length) {
          // A key-only probe has no bytes to regenerate from. A thin round beats
          // pretending the picture has nothing in it.
          return res.status(200).json({ ok: true, cached: true, imageKey, lang, targets: kept });
        }
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
  let jsonrepair;
  const openai = await tryOpenAI();
  try {
    const modRepair = await import("jsonrepair");
    jsonrepair = modRepair.jsonrepair;
  } catch (e) {
    console.error("[convo-image-targets] init error", e);
    return res.status(200).json(empty(imageKey, lang, "init_error"));
  }
  if (!openai) return res.status(200).json(empty(imageKey, lang, "init_error"));

  const MODEL = pickModel();

  // 6) The INVENTORY: one band-free vision look, cached per picture. Every
  //    band, both languages and every deepening draw from this one row, which
  //    is also what makes a level change cheap: the looking is already done.
  let inventory = await readInventory(sb, imageKey);
  if (!inventory) {
    let looked;
    try {
      looked = await withPhase("inventory", () =>
        runInventory(openai, MODEL, imageUrl, { description, lang }),
      );
    } catch (e) {
      console.error("[convo-image-targets] inventory failed", e?.message || e);
      return res
        .status(200)
        .json(empty(imageKey, lang, e?.code === "bad_model_json" ? "bad_model_json" : "model_failed"));
    }
    inventory = looked.entries;
    if (!inventory.length) {
      // Opposite failures, reported apart: a blank wall is no_targets, a model
      // whose every entry failed validation is a regression worth a warning.
      if (looked.rawCount > 0) {
        console.warn(
          `[convo-image-targets] all ${looked.rawCount} targets failed validation ` +
            `(lang=${lang} model=${MODEL} key=${imageKey})`,
        );
        return res.status(200).json(empty(imageKey, lang, "no_valid_targets"));
      }
      return res.status(200).json(empty(imageKey, lang, "no_targets"));
    }
    await writeInventory(sb, imageKey, inventory);
  }

  // 7) The BAND PASS: which entries serve THIS band, and what to call them.
  //    Text-only and cheap; the band is only ever in the room for the WORDS,
  //    never for the looking, which is the whole of the airport fix.
  let pass;
  try {
    pass = await withPhase("bandpass", () =>
      runBandPass(openai, MODEL, inventory, {
        lang, level, deep, description, misses, exclude, prefer, avoid,
      }),
    );
  } catch (e) {
    console.error("[convo-image-targets] band pass failed", e?.message || e);
    return res
      .status(200)
      .json(empty(imageKey, lang, e?.code === "bad_model_json" ? "bad_model_json" : "model_failed"));
  }
  const counts = pass.counts;
  const rawTargets = pass.chosen;
  const sane = sanitizeLocatedList(rawTargets, lang, level, deep);

  // 7b) The first wave. A handful of located targets are verified and written
  //     ahead of the rest so a round can start on them.
  //
  // Opt-in, and deliberately so. A partial response is only safe for a caller
  // that knows to come back for the rest; anything else would take four targets
  // as the whole scan and never ask again. The frontend asks for it because it
  // implements the follow-up. A script, a probe, or any future consumer gets
  // the complete set by default.
  //
  // Splitting is also only worth it when there IS a tail: with five located
  // targets, serving four and chasing one costs an extra enrich call to save
  // nothing.
  const split = body.firstPlayable === true && sane.length > FIRST_WAVE + 1;
  const wave = split ? sane.slice(0, FIRST_WAVE) : sane;
  const rest = split ? sane.slice(FIRST_WAVE) : [];

  const checkedWave = await withPhase("wave1", () =>
    verifyTargets(openai, MODEL, imageUrl, wave, lang),
  );

  // The tail's crop checks start HERE, not after the response, so they run
  // underneath the wave's enrich call rather than queueing behind it. Nothing
  // awaits this until the round is already playing; it is started early purely
  // so the pool finishes growing sooner.
  const restChecked = rest.length
    ? verifyTargets(openai, MODEL, imageUrl, rest, lang)
    : Promise.resolve([]);
  // Nobody is listening yet, and an unhandled rejection here would take down the
  // process rather than the round.
  restChecked.catch(() => {});

  let early = await withPhase("wave1", () =>
    enrichTargets(openai, MODEL, imageUrl, checkedWave, { lang, level, seed: imageKey }),
  );

  // The round starts HERE, and everything below this line happens while it is
  // being played. The row is deliberately not written yet: a partial set cached
  // as if it were the whole scan would serve four targets to every future visit
  // and never be recomputed.
  let servedEarly = false;
  if (split && early.length >= FIRST_PLAYABLE) {
    sendOnce(res, {
      ok: true,
      cached: false,
      imageKey,
      lang,
      targets: early,
      partial: true,
      scanId: makeScanId(imageKey, lang, level),
    });
    servedEarly = true;
    console.log(
      `[convo-image-targets] first playable: ${early.length} targets, ` +
        `${rest.length} still to check (key=${imageKey} level=${level || "-"})`,
    );
  }

  // 7c) The tail. Nobody is waiting on any of this once the round has started.
  let targets = early;
  if (rest.length) {
    const checkedRest = await restChecked.catch(() => []);
    const enrichedRest = checkedRest.length
      ? await enrichTargets(openai, MODEL, imageUrl, checkedRest, { lang, level, seed: imageKey })
      : [];
    targets = [...early, ...enrichedRest];
  }

  // 7d) The floor, shared with the heal path so a re-examined row is held to the
  //     same standard as a fresh one. Held AFTER the tail, and after the early
  //     response, which is the point: a top-up used to be ten seconds the
  //     learner stood through, and is now ten seconds they play through.
  const beforeTopUp = targets.length;
  targets = await topUpIfThin(openai, MODEL, imageUrl, { sb, imageKey, description, lang, level, targets, exclude, prefer, avoid, misses, deep, inventory, offeredIds: rawTargets.map((t) => t._invId).filter((n) => Number.isInteger(n)) });
  if (targets.length > beforeTopUp) {
    // Top-up returns located targets; only the new ones need writing.
    const fresh = targets.slice(beforeTopUp);
    const written = await enrichTargets(openai, MODEL, imageUrl, fresh, {
      lang,
      level,
      seed: imageKey,
    });
    targets = [...targets.slice(0, beforeTopUp), ...written];
  }

  if (!targets.length) {
    // These two look identical to a caller but mean opposite things, and
    // collapsing them hides the failure that actually needs fixing. "The model
    // found nothing nameable in this picture" is a fine outcome for a blurry
    // close-up. "The model answered and every single target failed validation"
    // is a prompt or a model regression — the classic shape being coordinates
    // returned as percentages, where every point fails the [0,1] range check and
    // the whole set silently evaporates.
    // NEVER a bare refusal. The counts came free with the band pass, so the
    // answer can say which band CAN field a round, and the frontend can offer
    // it by name instead of blaming the photograph.
    const near = nearestBand(level, counts);
    const honesty = { bandShort: true, ...(near ? { nearest: near } : null), counts };
    if (rawTargets.length || sane.length) {
      console.warn(
        `[convo-image-targets] all ${rawTargets.length} targets failed validation ` +
          `(lang=${lang} model=${MODEL} key=${imageKey})`
      );
      return sendOnce(res, { ...empty(imageKey, lang, "no_valid_targets"), ...honesty });
    }
    return sendOnce(res, { ...empty(imageKey, lang, "no_targets"), ...honesty });
  }

  if (targets.length < rawTargets.length) {
    console.log(
      `[convo-image-targets] kept ${targets.length}/${rawTargets.length} targets (lang=${lang})`
    );
  }

  // 8) Cache write. AWAITED, not fire and forget.
  //
  // word-info.js can afford to abandon its cache write because a missed write
  // there costs one cheap text call. Here the write IS the feature: the whole
  // route exists so that opening a picture a second time is free. A promise
  // scheduled and then abandoned as the handler responds is a cache that never
  // fills, and the failure is invisible, because the game still works. It just
  // pays for a vision call every single time.
  //
  // That is not hypothetical. The first cut of this route did fire and forget,
  // and three consecutive calls for the same image ran the model three times
  // and left zero rows behind. word-info.js already learned the same lesson for
  // its logOnly insert, which it awaits "so the row lands before the serverless
  // function can freeze after the response".
  await writeRow(sb, { imageKey, lang, level, targets, model: MODEL });

  // The tail's real product. A learner who started on the early four collects
  // the rest by reading this row back; a learner who arrives later reads it as
  // an ordinary cache hit and waits for nothing at all.
  // A thin round is still served (it beats nothing), but it says so, and says
  // where a full one lives, so the caller can offer that band by name.
  const shortInfo =
    targets.length < MIN_SERVED_TARGETS
      ? { bandShort: true, ...(nearestBand(level, counts) ? { nearest: nearestBand(level, counts) } : null), counts }
      : null;
  return sendOnce(res, { ok: true, cached: false, imageKey, lang, targets, ...shortInfo });
}
