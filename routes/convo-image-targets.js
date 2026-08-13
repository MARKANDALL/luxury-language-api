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

import { cropRegion, imageSize } from "../lib/image-crop.js";

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

// Bumped when a row must be re-checked rather than merely re-read. v2 is the
// first generation whose boxes were shown to the model on their own.
const VERIFIED_V = 2;

const MIN_TARGETS = 5;
const MAX_TARGETS = 8;

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
const MAX_ALIASES = 8;

// The regional usage note that rides with a set of variants, when there is one.
// Optional and usually absent: most objects have a single name everywhere, and
// a note invented for those teaches something false.
const MAX_NOTE_CHARS = 140;

// The riddle clue, which is only ever a handful of adjectives.
const MAX_RIDDLE_CHARS = 60;

// How many instances of one label are worth carrying. Past a few, the label is
// describing a crowd rather than a thing, and the target should not exist.
const MAX_INSTANCES = 4;

// How many previously-missed words are offered to a scan. Enough to give the
// picture a real chance of containing one, few enough that the list does not
// start steering the whole round.
const MAX_MISSES_OFFERED = 8;

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
    B1: `B1 intermediate. Ordinary specific nouns, including everyday compounds.
YES: "a backpack", "a paper cup", "a life jacket", "a windowsill", "a first-aid kit".
NO: bare basics a beginner already owns ("a bag", "a cup"), and nothing technical.`,
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
    B1: `B1 intermediate. Ordinary specific nouns, including everyday compounds.
YES: "la mochila", "el vaso de papel", "el chaleco salvavidas", "el botiquin".
NO: bare basics a beginner already owns ("la bolsa", "la taza"), and nothing technical.`,
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
function sanitizeTarget(raw, lang, seed, level) {
  if (!raw || typeof raw !== "object") return null;

  const label = String(raw.label == null ? "" : raw.label)
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 60);
  if (!label) return null;

  // 1) Where the thing is. A valid box wins, because its CENTRE is a better
  //    marker spot than a point the model estimated separately: a point drawn a
  //    little low reads as the desk behind the calculator, and the box says
  //    which of the two was meant. A missing or broken box falls back to the
  //    point, which is also what every row cached before boxes existed does.
  //
  //    A label can name more than one thing in frame. The fifth playtest asked
  //    "where is the parking ticket" in a scene holding two of them, one on
  //    each car, and scored only the one the model happened to pick: the
  //    learner tapped a ticket, was told no, and was then shown a ticket. So
  //    every instance the model found is kept, and the first is the one the
  //    marker and the crops use.
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
  const x = px;
  const y = py;

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

  // 4) Aliases: other correct ways to name this thing. The head noun is always
  //    one of them, since dropping the article is the commonest near miss and
  //    it should never be graded as wrong. Distractors are excluded by
  //    construction: an alias that matches one of the wrong choices would make
  //    that choice correct too.
  const aliasSeen = new Set([fold(label)]);
  const wrongChoices = new Set(shuffled.map(fold).filter((f) => f !== fold(label)));
  const aliases = [];
  const pushAlias = (v) => {
    const s = String(v == null ? "" : v).trim().replace(/\s+/g, " ").slice(0, 60);
    if (!s || aliases.length >= MAX_ALIASES) return;
    const key = fold(s);
    if (!key || aliasSeen.has(key) || wrongChoices.has(key)) return;
    aliasSeen.add(key);
    aliases.push(s);
  };
  if (head) pushAlias(head);
  (Array.isArray(raw.aliases) ? raw.aliases : []).forEach(pushAlias);

  // 5) The usage note. Kept only when there is something for it to be about: a
  //    note with no variant behind it is a lecture attached to the plain word,
  //    and the frontend only ever says it after an alias was matched anyway.
  const note = String(raw.americanNote == null ? "" : raw.americanNote)
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, MAX_NOTE_CHARS);
  const hasVariant = aliases.some((a) => fold(a) !== head);

  // 6) The riddle clue: attributes only. A clue holding the answer, or any word
  //    of it, is not a clue, and the same leak check the cloze gets applies
  //    here for the same reason. Dropped rather than repaired: a riddle is
  //    optional and a broken one gives the round away.
  let riddle = String(raw.riddle == null ? "" : raw.riddle)
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

  const target = {
    label,
    point: { x, y },
    // Omitted rather than null when there is no usable box, so a target from a
    // fresh call and a target from the pre-box cache are the same shape.
    ...(box ? { box } : null),
    ...(boxes.length > 1 ? { boxes } : null),
    cloze,
    choices: shuffled,
    answerIndex,
    aliases,
    // Omitted rather than empty, so a target from before this field existed and
    // a target that simply has no regional variation are the same shape.
    ...(note && hasVariant ? { americanNote: note } : null),
    ...(riddle ? { riddle } : null),
    ...(raw.revisit === true ? { revisit: true } : null),
    difficulty: DIFFICULTY_VALUES.has(difficultyRaw) ? difficultyRaw : "medium",
  };

  // The same gate the cache read applies, so nothing a served row would be
  // filtered for can be written in the first place. Without this the two halves
  // disagree: a row is stored, then permanently rejected on read, and every
  // play of that picture pays for a regeneration that stores the same thing.
  const bad = ruleFailure(target, lang, level);
  if (bad) return null;

  return target;
}

/** Sanitize the whole set, drop duplicates by head noun, cap at MAX_TARGETS. */
function sanitizeTargets(rawList, lang, seed, level) {
  const out = [];
  const heads = new Set();
  for (const raw of Array.isArray(rawList) ? rawList : []) {
    const t = sanitizeTarget(raw, lang, seed, level);
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

function buildSystemPrompt(lang, level) {
  const p = PACK[lang];
  const guide = level ? LEVEL_GUIDE[lang]?.[level] : "";
  const band = guide
    ? `

VOCABULARY LEVEL: ${guide}

Pick targets whose NAMES sit at that level. The things themselves are whatever is
in the picture; the level decides which of them are worth naming and how precisely
to name them.`
    : "";

  // The self-check the two high bands need. Stated as a test the model applies
  // to its own finished list, because the band description alone did not hold:
  // a C2 round came back with "a first-aid kit", a label this route's own B1
  // examples use. Naming that failure is the point.
  const bandCheck = HIGH_BANDS.has(level)
    ? `

HOW TO FIND ${level} TARGETS. Most photographs hold only three or four objects a
beginner could name, so do not hunt for more objects. Look HARDER at the objects
already in front of you and name their PARTS and their MATERIALS. A hat has a
brim, a crown, an eyelet and a chin cord. A shirt has a collar, a cuff, a hem and
a seam. A rescue buoy has a tow line, a webbing strap and a moulded handle. Those
parts are the ${level} round; the hat and the shirt are not.

LEVEL SELF-CHECK (${level} only, do this last). Read your labels back one at a time
and ask: would a B1 learner name this thing with this same word, on sight? If yes,
the target is too easy for this round. Replace it with a part of it, the material
it is made of, or a more precise word for it. If none of those is honestly
visible, drop the target rather than keeping it.
Adding a modifier does NOT raise the band. "a bucket hat", "a yellow bucket hat"
and "a lifeguard shirt" are all a hat and a shirt, and all three fail this check.
"a first-aid kit" is a B1 label and fails it too; "gauze", "a tourniquet" and
"the shoulder strap" are the same object seen at ${level}.
Never target a bare surface (sand, sky, water, waves, a wall, a floor, a desk) at
any level, and never pad the list with them to reach a count.
RETURN AS FEW AS ${MIN_SERVED_TARGETS} TARGETS at this band if that is all the picture honestly
holds. A short round of real ${level} words is the goal; a long round padded with
easy ones is the failure.`
    : "";
  return `
You are looking at a photorealistic illustration from a language-learning
conversation. Find the things in it that are worth teaching as vocabulary, and
describe where each one is.${band}

Return between ${MIN_TARGETS} and ${MAX_TARGETS} targets. Every string you write must be in
${p.langName} — labels, sentences and options alike. Return JSON only, no markdown.

Choose targets that are:
- CONCRETE and clearly visible: objects, clothing, furniture, food, parts of the
  setting. A learner must be able to see the thing and say "that one".
- SPREAD OUT across the picture, not five things on one table.
- WORTH LEARNING: everyday nouns a learner will meet again. Skip abstractions,
  skip anything you are guessing at, and skip anything too small to point at.
- Prefer things the scene is actually about over background filler.
- VISUALLY UNAMBIGUOUS. This is the one that matters most. Before you keep a
  target, look at what surrounds it: if a NEARBY object could plausibly be given
  the same name, or could plausibly answer the same sentence, then the question
  has two right answers and the learner will be told they are wrong for giving
  one of them. A folder on a desk covered in paper is not a safe target for
  "pamphlet". Either pick a different thing, or write a sentence that only the
  thing you mean can complete.

For each target return:
- "label": the noun. ${p.articleRule} ${p.pluralRule}
- "box": { "x", "y", "w", "h" } — the thing's BOUNDING BOX as fractions of the
  image: x and y are its top-left corner from the left and top edges, w and h are
  its width and height.
  The box is not decoration: a learner will TAP inside it to answer, so it has
  to be right.
  * TIGHT. It must hug the object. A box with room to spare around the thing
    accepts taps on whatever is beside it.
  * IT MUST CONTAIN THE THING YOU NAMED. If the box you would draw does not have
    the object inside it, the target is wrong. Check this before you keep it.
  * NEVER A PERSON'S BODY. A box over someone's chest, neck, face or arm is only
    acceptable when the thing you named IS what they are wearing or holding, and
    then the box goes around the garment or the item, not the person.
  * NO VAST SURFACES. Do not target a desk, a wall, a floor, a ceiling or a
    counter top. Their boxes swallow half the picture and every tap lands in
    them, which makes the question meaningless.
- "boxes": when the picture contains MORE THAN ONE of the thing you named, list
  a box for EVERY one of them here, up to ${MAX_INSTANCES}, and still give the clearest one as
  "box". This matters more than it sounds. A learner asked to find "the ticket"
  in a street with a ticket on two different windscreens will point at whichever
  they see first, and being told they are wrong for finding the thing they were
  asked for is the worst answer this game can give.
  Your two options, and you must take one of them:
    either list every instance here, so any of them counts;
    or write a label and a sentence that can only mean ONE of them ("the ticket
    on the red car's windscreen"), and give that one box.
  Never pick one of several lookalikes silently and hope.
  Omit this field entirely when there is only one of the thing.
- "point": { "x": 0.00-1.00, "y": 0.00-1.00 } — the centre of that same thing, as
  a fallback if the box is unusable. 0.5/0.5 is the middle of the picture.
- "cloze": ONE natural sentence about this picture, in ${p.langName}, with the
  target word replaced by exactly three underscores: ___
  Example: "${p.clozeExample}"
  The sentence must NOT contain the answer word anywhere else, and must read like
  something a person would say. Max 14 words.
  It must also be LITERALLY TRUE OF THIS IMAGE. Describe only what is actually
  depicted: do not write "holding" unless the thing is in someone's hand, do not
  write "wearing" unless it is on their body, do not write "on the table" unless
  it is on the table. A sentence that describes a plausible scene rather than
  THIS scene will be answered correctly and marked wrong.
- "choices": exactly 4 options — the label itself plus 3 plausible wrong answers
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
    (${p.regionExample}).
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
- "riddle": the ATTRIBUTES of this thing and nothing else, in ${p.langName}, for
  the game "I spy something red". ${p.riddleRule}
  Two or three attributes at most, from what is actually visible: colour first,
  then material, size or shape. ${p.riddleExample}
  It MUST NOT contain the noun, or any word from the noun, or any word that
  names what the thing IS. "small and red" is a riddle; "a small red toolbox" is
  the answer. Omit the field if the thing has no attribute worth saying.
- "difficulty": "easy", "medium" or "hard" — roughly how hard this word is for a
  learner.

Before you answer, re-read your own list once and drop or rewrite anything that
fails any of these: a sentence that is not literally true of this image, a
target another nearby object could just as well answer, a box that does not
contain the thing it names, a box drawn over a person's body when the target is
not their clothing or something they hold, and any target that is really a
surface rather than an object.

COUNT CHECK, and do it target by target, out loud to yourself. For each label
you wrote, count how many of that thing are actually in this picture. If the
answer is more than one, you have written a question with several right answers
and picked one of them in secret. Fix it, one of the two ways:
  - list every one of them in "boxes", so any of them counts; or
  - rewrite the label AND the sentence so they can only mean one of them.
This is not a rare case. A street has several cars, a table has several chairs,
a face has two eyes, a shirt has several buttons. If you wrote "a car" and there
are four cars, that target is broken as it stands.${bandCheck}

Output MUST be valid JSON only, exactly:
{ "targets": [ { "label": "...",
                 "box": { "x": 0.0, "y": 0.0, "w": 0.0, "h": 0.0 },
                 "boxes": [ { "x": 0.0, "y": 0.0, "w": 0.0, "h": 0.0 },
                            { "x": 0.0, "y": 0.0, "w": 0.0, "h": 0.0 } ],
                 "point": { "x": 0.0, "y": 0.0 },
                 "cloze": "...", "choices": ["...","...","...","..."],
                 "aliases": ["...","..."],
                 "americanNote": "...",
                 "riddle": "...",
                 "revisit": false,
                 "difficulty": "easy" } ] }
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
const VERIFY_CONCURRENCY = 4;

function verifyPrompt(label, langName) {
  return `You are shown a small crop taken from a larger photograph.
Answer one question about the crop ALONE. You cannot see the rest of the photo
and must not guess what is outside the crop.

Question: is "${label}" (${langName}) clearly visible in this crop?

Say yes ONLY if the thing itself is in the crop and a learner shown this crop
could point at it. Say no if it is absent, if it is cut off past recognition, if
you can only infer it from context, or if what is here is a different object
that merely sits near it.

Return JSON only: { "shows": true } or { "shows": false, "why": "<six words>" }`;
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
    return { shows: parsed?.shows === true, why: String(parsed?.why || "").slice(0, 60) };
  } catch (e) {
    // A verification that could not be run is NOT a failure of the target. The
    // alternative, dropping targets when the checker itself breaks, empties
    // rounds for a reason that has nothing to do with the picture.
    console.warn("[convo-image-targets] verify call failed:", e?.message || e);
    return { shows: true, why: "verifier unavailable" };
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
  let size = null;
  try {
    size = await imageSize(imageUrl);
  } catch (e) {
    console.warn("[convo-image-targets] could not size image, skipping verification:", e?.message || e);
    return targets;
  }

  const checked = await pooled(
    targets.map((t) => async () => {
      const boxes = Array.isArray(t.boxes) && t.boxes.length ? t.boxes : t.box ? [t.box] : [];
      // Nothing to check. The field is omitted rather than nulled, so a row
      // that predates boxes comes back the exact shape it went in as.
      if (!boxes.length) return t;

      const kept = [];
      const notes = [];
      for (const box of boxes) {
        const crop = await cropRegion(imageUrl, box, size);
        if (!crop) {
          // Could not be cut: not the target's fault, so it stays unjudged.
          kept.push(box);
          continue;
        }
        const first = await askCrop(openai, model, crop, t.label, langName);
        if (first.shows) {
          kept.push(box);
          continue;
        }
        notes.push(first.why);

        // ONE more chance, and only for the instance that failed.
        const again = await relocalize(openai, model, imageUrl, t.label, langName);
        if (!again) continue;
        const crop2 = await cropRegion(imageUrl, again, size);
        const second = crop2 ? await askCrop(openai, model, crop2, t.label, langName) : { shows: false };
        if (second.shows) kept.push(again);
      }

      if (!kept.length) {
        return { ...t, boxOk: false, boxWhy: notes[0] || "not in crop" };
      }
      const first = kept[0];
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
        ...(kept.length > 1 ? { boxes: kept } : null),
        // The point follows the box it belongs to, or the marker keeps pointing
        // at where the box used to be.
        point: { x: clampPoint(first.x + first.w / 2), y: clampPoint(first.y + first.h / 2) },
        boxOk: true,
      };
    }),
    VERIFY_CONCURRENCY,
  );

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
    const { error } = await sb.from("image_targets").upsert(
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
    );
    if (error) console.warn("[convo-image-targets] cache write failed:", error.message);
  } catch (e) {
    console.warn("[convo-image-targets] cache write failed", e?.message || e);
  }
}

function buildUserText(description, lang, misses) {
  const p = PACK[lang];
  const lines = [
    `Find ${MIN_TARGETS}-${MAX_TARGETS} vocabulary targets in this image. Answer in ${p.langName}.`,
  ];
  // Words this learner has already been beaten by. Offered, never demanded:
  // a word planted in a picture that does not contain it is a question with no
  // answer, which is worse than not revisiting it at all.
  if (misses?.length) {
    lines.push(
      "",
      "This learner has previously failed to name these words. If ANY of them is",
      "genuinely present in this image and would make a fair target, include it,",
      "mark it with \"revisit\": true, and follow every other rule for it as normal.",
      "Include NONE of them if none is really there. Do not stretch:",
      misses.map((m) => `- ${m}`).join("\n"),
    );
  }
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
      const { data, error } = await sb
        .from("image_targets")
        .select("targets, v, verified")
        .eq("image_key", imageKey)
        .eq("lang", lang)
        .eq("level", level)
        .maybeSingle();
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
          return res.status(200).json({ ok: true, cached: true, imageKey, lang, targets: kept });
        }
        if (servable && data.verified !== VERIFIED_V && imageUrl) {
          const openaiForCheck = await tryOpenAI();
          if (openaiForCheck) {
            const model = pickModel();
            const checked = await verifyTargets(openaiForCheck, model, imageUrl, kept, lang);
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
        } else if (servable) {
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

  // 6) ONE vision call. temperature 0 for determinism, same as word-image.
  let resp;
  try {
    resp = await openai.chat.completions.create({
      model: MODEL,
      temperature: 0,
      max_tokens: 1400,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: buildSystemPrompt(lang, level) },
        {
          role: "user",
          content: [
            { type: "text", text: buildUserText(description, lang, misses) },
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
  const sane = sanitizeTargets(rawTargets, lang, imageKey, level);

  // 7b) Model truth. Every surviving box is cut out and shown to the model on
  //     its own; what the crop does not show is re-localized once and then
  //     dropped. This is the only check in the pipeline the generating call
  //     cannot talk its way past.
  const targets = await verifyTargets(openai, MODEL, imageUrl, sane, lang);

  if (!targets.length) {
    // These two look identical to a caller but mean opposite things, and
    // collapsing them hides the failure that actually needs fixing. "The model
    // found nothing nameable in this picture" is a fine outcome for a blurry
    // close-up. "The model answered and every single target failed validation"
    // is a prompt or a model regression — the classic shape being coordinates
    // returned as percentages, where every point fails the [0,1] range check and
    // the whole set silently evaporates.
    if (rawTargets.length || sane.length) {
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

  return res.status(200).json({ ok: true, cached: false, imageKey, lang, targets });
}
