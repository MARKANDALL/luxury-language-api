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
import { cropWindow } from "../lib/crop-window.js";
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
//       instance found was crop-checked in turn. THIS WAS NOT TRUE. See v4.
//   v4  what v3 claimed, actually done, plus enrichment re-derived.
//
// The distinction is the whole point of bumping it. The sixth playtest's row was
// written by current v6 code, was stamped v2, and every one of its targets was
// boxOk:true: a perfectly audited row holding one chair box in a room with seven
// chairs, because "audited" meant "the boxes present are right", and nothing
// could express "and there are no others". A v2 row is therefore stale now, and
// says so, which is what makes the healing on next serve decidable rather than
// guessed. Distinct from TARGETS_V, which discards the row and re-bills a full
// generation; this re-examines it in place.
//
// WHY v4 EXISTS, AND WHY IT IS A CORRECTION RATHER THAN A STEP FORWARD.
//
// v3 above describes a pass this file did not have. v8 deleted the enumeration
// call on the reasoning that the locate prompt carries the count check, so a
// fresh scan already knows its instances by the time verification runs. True,
// and irrelevant to a CACHED row, which never went through today's locate call:
// verifyTargets planned its candidates from the boxes the row arrived with, so a
// heal could only ever lose an instance and never find one. A v3 row is
// therefore a row that was STAMPED as instance-audited without being one.
//
// Mark met it as "Where is a poster?" in a classroom covered in posters, with
// one small poster accepting. Three separate things had to be wrong at once and
// all three are fixed under this number:
//
//   THE HEAL DID NOT LOOK. enumerateInstances is restored, on the heal path only.
//   THE VERDICT GUESSED. instanceConfidence took a single box as proof there was
//     only one, on the strength of a hand-written CROWD_WORDS list that names
//     people and garments and could never enumerate what a photograph repeats.
//     It now refuses to say "one" unless something actually counted.
//   ENRICHMENT WAS EXEMPT. A heal re-derived geometry and nothing else, so a row
//     written before riddles existed healed into an audited row with no clues,
//     and top-up additions could be written bare and stamped current.
//
// Every row at v3 or below re-heals on its next serve, which is the point: what
// Mark judges by eye has to have been made under the rules he is judging.
const VERIFIED_V = 4;

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
// THE CEILING WAS THE PROBLEM, not the model's imagination.
//
// Standing in front of the interview scene Mark named the man's ring, the word
// RESUME printed on the clipboard, individual fingers, fingernails, the shirt
// under the blazer, her earring, her eyebrows, nose, lips, the KIND of smile she
// has, his intense expression, his wrinkled forehead, his stubble, the stripes
// on the tie. Thirty-two entries cannot hold that, so the pass spent them on
// topic-adjacent basics and stopped, and every downstream shortage (a four-word
// pool, a hidden Lightning chip, a Riddle with nothing to say, words repeating
// across modes) is that ceiling wearing a different symptom.
//
// The inventory is cached once per image and shared by every band, both
// languages and every deepening, so this is paid for once per photograph, ever.
const INVENTORY_MAX = 90;
const MINE_MAX = 40;

// The granularities the inventory is asked to cover. "action" is a thing frozen
// in the frame (pouring, boarding, waving); "state" is a condition (wet, torn,
// crowded, delayed). Both are nameable and both are exactly what the high bands
// starve without.
const GRANULARITIES = [
  "object", "part", "material", "surface", "state", "action",
  // v13. The first six were about THINGS, and a photograph of people is mostly
  // not things: a face is the richest surface in most scenes and had nowhere to
  // live. "person" carries anatomy and features, "text" carries words actually
  // printed in the frame, and "interpretive" carries what a scene means, which
  // is the only tier a C2 learner is really short of.
  "person", "text", "interpretive",
];

/**
 * The sweep: what the inventory pass must WALK rather than wander.
 *
 * A checklist, not a vibe. Each tier carries a floor, and the floors add up to
 * more than any one pass would volunteer, which is the point: breadth is forced
 * by structure instead of hoped for. Floors are per-tier minimums where the
 * picture can honestly support them, never a licence to invent.
 */
const SWEEP_TIERS = [
  {
    key: "person",
    min: 14,
    title: "EVERY PERSON, HEAD TO TOE",
    body: `Work down each visible person in turn and do not skip:
  hair (and its style), hairline, forehead and any lines on it, eyebrows, eyes,
  eyelashes, the gaze and where it is directed, nose, cheeks, lips, mouth, teeth
  if shown, chin, jaw, stubble or beard, ears, earrings and any other jewelry,
  neck, shoulders, arms, hands, individual fingers, fingernails, knuckles,
  a ring on a finger, a watch;
  then EVERY LAYER OF CLOTHING separately, and the parts of each layer: a collar,
  a lapel, a cuff, a button, a buttonhole, a seam, a hem, a pocket, a zip, and
  the PATTERN on it (stripes, a check, a weave, a knit).
  Say WHOSE it is when two people are present ("the man's tie").`,
  },
  {
    key: "object",
    min: 10,
    title: "EVERY OBJECT, PART BY PART",
    body: `Each whole object, then its PARTS, then what it is MADE OF, then its
  CONDITION: a clipboard, then its clip, its board, its paper, the metal of the
  clip, the fact that a corner is bent. Small things count and are often the best
  words in the picture.`,
  },
  {
    key: "text",
    min: 2,
    title: "TEXT THAT IS ACTUALLY PRINTED IN THE PICTURE",
    body: `Words visible on paper, screens, badges, signs, labels and packaging are
  nameable things in their own right: "the word RESUME", "a name badge with a
  name on it", "a departures board". Only what is legible; never guess text you
  cannot read.`,
  },
  {
    key: "scene",
    min: 6,
    title: "THE SCENE ITSELF",
    body: `Spatial relations (what is behind, between, resting on, leaning against
  what), the LIGHT (its direction, its quality, a highlight, a shadow, a
  reflection), the setting and its surfaces, and ACTIONS IN PROGRESS: gesturing,
  listening, explaining, holding, waiting.`,
  },
  {
    key: "interpretive",
    min: 6,
    title: "WHAT THE PICTURE MEANS",
    body: `The tier a mastery learner is actually short of, and the one a list of
  nouns can never reach: body language, posture, eye contact or its absence, the
  CHARACTER of an expression (a polite smile, a strained smile, an intense stare,
  a furrowed brow), the mood between people, the tension or ease in the room,
  the FIRST IMPRESSION the scene gives, and what the situation IS (a job
  interview, a disagreement, a farewell). These are still things you can point
  at: box the face, the hands or the pair of people that carry the meaning.`,
  },
];

/** The sweep, as prompt text. */
function sweepText() {
  return SWEEP_TIERS.map(
    (t) => `${t.title} (at least ${t.min} entries where the picture supports them):\n  ${t.body}`,
  ).join("\n\n");
}

/** The floor a deep scan tops up to, rather than MIN_TARGETS. */
const DEEP_MIN_TARGETS = 16;

function maxTargetsFor(level, deep = false) {
  if (deep) return DEEP_TARGETS;
  return HIGH_BANDS.has(level) ? 16 : MAX_TARGETS;
}

/**
 * How many candidates the band pass should NAME, as opposed to how many the
 * round will serve.
 *
 * VERIFICATION IS LOSSY AND ALWAYS WAS. Measured across three scenes on the
 * v13 sweep, roughly half of every batch dies in the crop check, most of it to
 * "no such thing visible in this crop": a box the inventory drew loosely, which
 * is the price of asking one pass to both NAME ninety things and PLACE all of
 * them. Asking the band pass for exactly the round size therefore guarantees a
 * short round, which is what put four words on the interview scene.
 *
 * So it over-asks, and the surplus is trimmed after verification rather than
 * before. The cost is text tokens on a cheap pass; the alternative is a hidden
 * Lightning chip and a Riddle with nothing to say, which is what pool shortage
 * has actually cost this game every round since v10.
 */
const BAND_OVERASK = 2.2;

function bandDraftFor(level, deep = false) {
  return Math.min(INVENTORY_MAX, Math.ceil(maxTargetsFor(level, deep) * BAND_OVERASK));
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

/**
 * Labels whose instances a learner will reasonably point at ANY of.
 *
 * THE BUS. "Where is a passenger?" was asked of a bus full of passengers and
 * only the protagonist's box accepted, so a learner tapping a passenger was
 * told they were wrong about a passenger. The ruling is that in Find It any
 * true instance accepts; the difficulty is knowing whether we HAVE them all.
 *
 * These two classes are where the risk lives, because they are the labels a
 * photograph repeats: people, and the clothes people wear. A single box on one
 * of these is a claim we cannot support, so it is marked rather than trusted.
 */
const CROWD_WORDS = new Set(
  ("person people man men woman women boy girl child children kid kids baby " +
   "passenger passengers traveler travelers commuter commuters customer customers " +
   "shopper shoppers pedestrian pedestrians rider riders student students worker " +
   "hiker hikers guest guests visitor visitors " +
   "shirt tshirt t blouse jacket coat parka sweater jumper hoodie dress skirt " +
   "trousers pants jeans shorts shoe shoes boot boots sneaker sneakers hat cap " +
   "beanie scarf glove gloves bag backpack handbag purse mask glasses " +
   "seat seats chair chairs window windows door doors handrail rail pole")
    .split(/\s+/)
    .filter(Boolean),
);

/**
 * Can we vouch for having found EVERY instance of this label?
 *
 * "one" a thing there is only one of, or a label no photograph repeats.
 * "many" several were found and boxed, so any of them may be tapped.
 * "unknown" a crowd-class label with a single box: the picture very probably
 *   holds more and we did not find them, so Find It must not ask for it.
 */
function instanceConfidence(label, boxCount, lang, { counted = true, crowd = false, sure = true } = {}) {
  const words = new Set(fold(headNoun(label, lang)).split(" "));
  const crowdWord = [...words].some((w) => CROWD_WORDS.has(w));
  // The enumeration looked and said there are more of these than it can point
  // at. That is the strongest possible evidence and it outranks everything.
  if (crowd) return "unknown";
  if (boxCount > 1) return "many";
  // NOBODY COUNTED, so "one" is not a thing we know.
  //
  // The word list below is the whole reason this argument exists. CROWD_WORDS
  // names the two classes a bus playtest happened to expose, people and the
  // clothes they wear, and it cannot enumerate the nouns a photograph repeats:
  // "poster" is not in it, and neither is sign, book, plant, bottle or tile. So
  // a cached row holding ONE poster box in a classroom covered in posters read
  // as settled, and Find It asked "Where is a poster?" and accepted one of them.
  //
  // A single box is evidence of instances only when something actually went
  // looking for the others. On the fresh path the locate call's count check is
  // that something; on a cached row nothing was, until the heal started
  // enumerating. Where neither ran, the honest answer is that we do not know,
  // and Find It declines rather than asking a question it cannot score.
  if (!counted) return "unknown";
  // AND COUNTED IS NOT THE SAME AS CERTAIN. The enumeration is asked outright
  // whether it found them all, and a "no" is the most useful thing it can say:
  // Find It then declines the label instead of asking a question whose right
  // answers it will mark wrong. Erring toward "unknown" costs a target; erring
  // toward "one" costs the learner a correct tap.
  if (!sure) return "unknown";
  return crowdWord ? "unknown" : "one";
}

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
// How much of the thing's visible extent the box must actually contain. Below
// this the box is showing a PART of the thing, and a part is what "the box
// excludes the head" looks like from the outside.
const COVER_MIN = 0.75;

// What a box that has STOPPED IMPROVING may still be accepted at.
//
// FORENSICS ON A RICH OUTDOOR B2 SCENE THAT YIELDED THREE SERVABLE TARGETS.
// Every one of fourteen first-pass candidates failed, and every one failed on
// COVER, never on excess. The redraw then converged most of them, and the
// survivors clustered just under the cliff: "a face" reached 0.744, one point
// short; "a plaid shirt" reached 0.695 and was still climbing; "a gesture with
// the left hand" reached 0.684. Those are honest boxes thrown away for a
// rounding difference, and on a full-body outdoor scene there is a systematic
// reason for it: the model's "whole visible extent" of a face takes in hair and
// jawline that a tight face box rightly leaves out, so cover reads low on
// exactly the entries a person-rich photograph is made of.
//
// So the cliff stays for a FIRST look, where a low score means a bad box, and a
// box that has been redrawn and has settled is judged here instead. It is not a
// licence to keep anything: it applies only after the loop has done its work.
const COVER_SETTLED = 0.62;

// How much better a redraw has to be before it is worth taking. Below this the
// box is wandering rather than converging, and "a face" wandered from 0.744 to
// 0.472 while the loop kept the LAST box instead of the BEST one.
const COVER_PROGRESS = 0.02;

// And how much bigger than the thing the box may be.
//
// TIGHT, AND THE NUMBER IS MEASURED RATHER THAN CHOSEN. v12 used 3x on the
// reasoning that a bounding box around an irregular object honestly contains a
// lot of air. It does, but not that much: logging cover and excess for every
// candidate across three real scenes, the boxes that PASSED coverage came in at
// 1.24x and 1.24x, and nothing honest was anywhere near 3. What 3x bought was
// sprawl, which is what Mark saw on the rasters, and it bought it for nothing.
//
// This governs what may be STORED, which is a claim about where the object is.
// How forgiving a TAP is has moved out entirely, into acceptRects, where it
// belongs: those two numbers pull in opposite directions and one number doing
// both jobs is how honest boxes came to sprawl.
const EXCESS_MAX = 1.5;

// How many times a box may be redrawn before the target is given up on.
//
// One redraw was not enough and the miss was structural. The bounds come from a
// crop cut around the ORIGINAL box, so when that box is badly placed the crop
// holds only part of the real object and the bounds are clipped to what was
// visible. The redraw lands nearer, its own crop then sees more of the thing,
// and it is judged short AGAIN, so v12 dropped five of seven redraws on the
// interview scene and thinned the pool. Iterating converges: each crop is
// centred better than the last, and two extra asks are far cheaper than a lost
// target.
const REDRAW_TRIES = 4;

/**
 * Map a box given in CROP fractions back into picture fractions.
 *
 * The crop is padded, by 55 percent each side and 85 below, so crop space and
 * picture space are genuinely different and this is the only bridge between
 * them. Shares cropWindow with the cutter, so the two cannot drift.
 */
function boundsToPicture(box, bounds, dim) {
  const win = cropWindow(box, dim);
  if (!win || !bounds) return null;
  const out = {
    x: (win.x + bounds.x * win.w) / dim.w,
    y: (win.y + bounds.y * win.h) / dim.h,
    w: (bounds.w * win.w) / dim.w,
    h: (bounds.h * win.h) / dim.h,
  };
  // Deliberately NOT through unitBox. That gate decides what may be SERVED, and
  // it has a minimum side: a genuinely small object's bounds fall under it, and
  // sending a measurement through a serving gate turned the answer into null,
  // which coversTheThing reads as "unanswerable" and waves through. The exact
  // case it waved through is a tiny thing in a big box, which is the case the
  // excess test exists for. Measurement is measurement; whether the result is
  // servable is asked separately, at the point of redrawing.
  return [out.x, out.y, out.w, out.h].every(Number.isFinite) && out.w > 0 && out.h > 0 ? out : null;
}

/** Area of the overlap of two normalized boxes. */
function overlapArea(a, b) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * Does this box BOUND the thing, or merely touch it?
 *
 * THE UPGRADE FROM CENTRING. Asking whether the thing's centre landed in the
 * box caught a box drawn beside the thing and missed every box drawn across
 * part of it: a clipboard box that started below the clip still held the
 * clipboard's centre, and a person's box that started at the chin still held
 * most of the person. Both passed, and both were filed from a rendered scan.
 *
 * Coverage asks the two questions a bounding box is actually making a claim
 * about. Does the box CONTAIN the thing's visible extent, or is it showing a
 * part? And is it not much BIGGER than the thing, or is it mostly other things?
 *
 * @returns {{ok: boolean, why: string, cover: number, excess: number, found: object|null}}
 *          `found` is the thing's real place in picture fractions, which is
 *          what a failed box is redrawn to rather than dropped for.
 */
function coversTheThing(box, verdict, dim) {
  const found = boundsToPicture(box, verdict?.bounds, dim);
  // Unanswerable is not evidence against the box: an older cached judgement and
  // a model that skipped the field are the same shape, and dropping targets for
  // a question that was never put would empty rounds for no reason.
  if (!found || !dim?.w || !dim?.h) return { ok: true, why: "", cover: 1, excess: 1, found: null };

  const thing = found.w * found.h;
  if (!(thing > 0)) return { ok: true, why: "", cover: 1, excess: 1, found: null };

  const cover = overlapArea(box, found) / thing;
  const excess = (box.w * box.h) / thing;

  if (cover < COVER_MIN) {
    return { ok: false, why: "box covers only part of it", cover, excess, found };
  }
  // A thing running past the crop's edge has bounds that are a floor rather
  // than the truth, so its area is understated and the excess ratio would
  // convict an honest box for being bigger than the fragment it could see.
  if (!verdict.cut && excess > EXCESS_MAX) {
    return { ok: false, why: "box much bigger than the thing", cover, excess, found };
  }
  return { ok: true, why: "", cover, excess, found };
}

/**
 * The verdict for a box that has been redrawn as far as it will go.
 *
 * Serve the best look the loop managed if it cleared the settled bar, and drop
 * it otherwise. Split out so every exit from the convergence loop answers the
 * same way: three separate `return { shows: false }` lines is how a target that
 * had already found itself came to be thrown away.
 */
function settle(ti, ci, best, why) {
  if (best && best.cover >= COVER_SETTLED && best.excess <= EXCESS_MAX) {
    console.log(
      `[convo-image-targets] settled at cover ${(best.cover * 100).toFixed(0)}%, excess ${best.excess.toFixed(2)}x`,
    );
    return { ti, ci, shows: true, prominence: best.prominence, box: best.box, redrawn: true };
  }
  return { ti, ci, shows: false, why };
}

/**
 * Is the thing the model found actually INSIDE the box we asked about?
 *
 * THE HOLE THIS CLOSES. The crop is padded by 55 percent each side and 85
 * percent below, which is right for judging (a thing cut exactly at its own
 * bounds is hard to recognise) and is exactly how a displaced box passed. A box
 * drawn over the window between two people cuts a crop containing slivers of
 * both their jackets, so "is a suit jacket visible in this crop" is honestly
 * YES, and a box naming the window was kept as a box naming a jacket. Rendering
 * a scan's boxes showed three of eight in that state.
 *
 * So the model is asked WHERE, and the answer is mapped out of crop space and
 * back into the picture: the centre it reports has to land inside the box
 * itself, with a small tolerance so a box that hugs its object honestly is not
 * punished for the model rounding. A sliver at the edge now fails, which is the
 * centring requirement stated in pixels.
 *
 * @param {{x,y,w,h}} box normalized
 * @param {{x,y}} where the model's centre, in CROP fractions
 * @param {{w,h}} dim the picture's pixel size
 * @returns {boolean} true when it cannot be checked, because an unanswerable
 *          question is not evidence against the box
 */
function centreLandsInBox(box, verdict, dim) {
  const found = boundsToPicture(box, verdict?.bounds, dim);
  if (!found || !box || !dim?.w || !dim?.h) return true;
  const px = found.x + found.w / 2;
  const py = found.y + found.h / 2;
  // A tenth of the box, but never more than two percent of the FRAME. The
  // fraction alone was the wrong shape: on a box covering a third of the
  // picture it forgave three percent of the whole scene, which is enough for a
  // box over a man's tie to accept his hands two hand-widths away, measured on
  // a real scan. Small boxes keep their rounding allowance; large ones stop
  // buying reach with their size.
  const tx = Math.min(box.w * 0.1, 0.02);
  const ty = Math.min(box.h * 0.1, 0.02);
  return (
    px >= box.x - tx && px <= box.x + box.w + tx && py >= box.y - ty && py <= box.y + box.h + ty
  );
}

/**
 * The point to serve for a box: the model's heart when the box still holds it,
 * the box's centre otherwise. One rule, used everywhere a box is replaced.
 */
function heartFor(point, box) {
  const holds =
    point &&
    Number.isFinite(point.x) && Number.isFinite(point.y) &&
    point.x >= box.x && point.x <= box.x + box.w &&
    point.y >= box.y && point.y <= box.y + box.h;
  return holds
    ? { x: clampPoint(point.x), y: clampPoint(point.y) }
    : { x: clampPoint(box.x + box.w / 2), y: clampPoint(box.y + box.h / 2) };
}

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

// Words that make a label too hard for the everyday bands, whatever the OBJECT
// is. Mark's rule, adopted: a B1 target must be a word a B1 learner plausibly
// knows, and "a beige cardigan" is not, for a native speaker either.
//
// TWO CLASSES, because they fail the same test from two directions. An unusual
// COLOUR is a hard word attached to an easy thing: the sweater is plainly a
// sweater and "beige" is the part a B1 learner does not hold. A garment named as
// a TYPE is the same trade the other way round: everyone can see a cardigan, and
// "cardigan" rather than "sweater" is a B2 word for it.
//
// MATCHED ON ANY WORD OF THE LABEL, not on the head. That is the whole
// difference from BASIC_SETS below, and it is why this could not reuse inSet:
// the offending word in "a beige cardigan" is the modifier, and a head-word
// check reads that label as a cardigan and passes the colour without looking.
//
// THIS IS A RULE AND NOT A HINT, and the evidence is why. The same recalibration
// was written into LEVEL_GUIDE.en.B1 first, in the shape the clipboard/apron
// change used, and a fresh B1 scan of parents-1 under that prompt served "a
// beige cardigan" anyway. Prompt text moves the odds; ruleFailure is what makes
// a law hold, and it holds for CACHED rows too, because the cache read runs
// every stored target through it.
const HARD_WORDS = {
  en: [
    // Colours past the primary set a beginner is taught.
    "beige", "maroon", "olive", "mustard", "teal", "burgundy", "taupe", "ochre",
    "mauve", "khaki", "crimson", "turquoise", "lilac", "indigo", "magenta",
    "charcoal", "scarlet", "amber", "russet", "auburn",
    // Garments named as a type, where the everyday word names the same thing.
    "cardigan", "parka", "blazer", "poncho", "tunic", "anorak", "cagoule",
    "waistcoat", "gilet", "kimono", "kaftan", "dungarees", "bolero", "shawl",
    "cravat", "gaiters", "espadrilles", "loafers", "brogues",
  ],
  es: [
    "beis", "granate", "oliva", "mostaza", "turquesa", "borgona", "ocre",
    "malva", "caqui", "carmesi", "lila", "indigo", "magenta", "escarlata",
    "ambar", "bermellon",
    "rebeca", "cardigan", "parka", "blazer", "poncho", "tunica", "anorak",
    "chal", "quimono", "caftan", "alpargatas", "mocasines",
  ],
};

const HARD_SETS = {
  en: new Set(HARD_WORDS.en),
  es: new Set(HARD_WORDS.es),
};

// The bands this applies at. B2 and above are exactly where these words belong,
// so the rule stops at B1 rather than running everywhere.
const EVERYDAY_BANDS = new Set(["A1", "A2", "B1"]);

/**
 * Does any word of this label put it above the everyday bands?
 *
 * Every word, singular and plural, because the offender is as often a modifier
 * as a head: "a beige cardigan" fails twice and "a mustard scarf" fails on the
 * word in front of a noun a beginner owns.
 */
function tooHardFor(label, lang, level) {
  if (!EVERYDAY_BANDS.has(level)) return "";
  const set = HARD_SETS[lang] || HARD_SETS.en;
  for (const w of fold(label).split(" ")) {
    for (const form of wordForms(w)) if (form && set.has(form)) return form;
  }
  return "";
}

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

  // AND THE OTHER END OF THE SAME QUESTION. too_basic asks whether a word is too
  // easy for a high band; this asks whether it is too hard for an everyday one,
  // and until now nothing did. A B1 round could serve any word the model
  // produced, which is how "a beige cardigan" reached a B1 learner and how it
  // survived the prompt rule written to stop it.
  const hard = tooHardFor(target.label, lang, level);
  if (hard) return `too_hard:${hard}`;

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
NO: unusual COLOR words and garments named as a TYPE. "beige", "maroon", "olive",
    "mustard", "teal" and "burgundy" are B2 or above; so is "a cardigan",
    "a parka", "a blazer", "a poncho" or "a tunic". The same test decides both:
    the color is plainly visible and the object is plainly a sweater or a coat,
    but the WORD is not one a B1 learner holds. At B1 use a basic color and the
    everyday garment: "a brown sweater", "a green coat", "a blue shirt".
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
NO: unusual COLOR words and garments named as a TYPE. "beis", "granate",
    "verde oliva", "mostaza" and "turquesa" are B2 or above; so is "la rebeca",
    "la parka", "el blazer" or "el poncho". At B1 use a basic color and the
    everyday garment: "un sueter marron", "un abrigo verde".
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
  const out = { ok: true, cached: false, imageKey, lang, targets: [], vintage: vintageOf({}) };
  if (reason) out.reason = reason;
  return out;
}

/**
 * WHAT THE THING ON SCREEN IS MADE OF.
 *
 * Mark judges every fix by eye, against whatever the game happened to serve, and
 * a served round carried nothing at all about its own provenance: a row scanned
 * under the rules of three weeks ago and a row generated ten seconds ago came
 * down the wire identical. So a fix that worked and a cached row that predates
 * it were indistinguishable, and time has gone on arguing about which one he was
 * looking at.
 *
 * Small on purpose. It is not telemetry, it is a label: which pipeline wrote
 * this, how far it has been audited, when that last happened, and whether it
 * came out of the cache, was healed on the way through, or was made just now.
 * The debug overlay puts it on screen; nothing else reads it.
 *
 * `now` rides along so the reader does not have to know today numbers to see
 * that a row is behind them.
 *
 * @param {object} o
 * @param {number} [o.v]        the row shape it was written under
 * @param {number} [o.verified] how far it has been audited
 * @param {string} [o.at]       when it was written or last healed
 * @param {string} [o.source]   "fresh" | "cache" | "healed"
 * @param {string} [o.model]
 */
function vintageOf({ v, verified, at, source = "fresh", model } = {}) {
  return {
    now: { v: TARGETS_V, verified: VERIFIED_V },
    v: Number.isFinite(v) ? v : TARGETS_V,
    verified: Number.isFinite(verified) ? verified : VERIFIED_V,
    at: at || new Date().toISOString(),
    source,
    model: model || "",
  };
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

  // Where the thing is. The box says WHICH thing was meant; the point says where
  // its heart is, and both are wanted.
  //
  // The box centre used to win outright, on the reasoning that a point drawn a
  // little low reads as the desk behind the calculator. It is the wrong spot for
  // the one case where box centre and heart genuinely differ: a standing
  // person's box centre is around their hips. So the point is kept when it
  // lands inside the box and only overruled when it does not, which is exactly
  // the "drawn a little low" case the old rule was written for. A missing or
  // broken box falls back to the point, which is also what every row cached
  // before boxes existed does.
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
  const heart = box ? heartFor(raw.point, box) : null;
  const px = heart ? heart.x : unitCoord(raw.point?.x);
  const py = heart ? heart.y : unitCoord(raw.point?.y);
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
    // WHAT A RIDDLE MAY NOT CONTAIN IS THE ANSWER, which is the head NOUN and
    // the whole phrase, NOT every word of the label.
    //
    // The old rule forbade any word of the head over two letters, and it was
    // right while labels were bare nouns. Inventory-first generation made labels
    // describe themselves, and the rule then convicted every riddle for the
    // exactly the labels that most needed one: "a brown long-sleeve shirt"
    // forbade brown, long, sleeve and shirt, so no clue about a brown shirt
    // could survive, and the whole Riddle mode silently emptied on a fresh scan.
    //
    // An attribute the label happens to share is not a leak. "I spy something
    // brown and made of cotton" is a fair clue for a brown shirt: the learner
    // still has to produce SHIRT, which is the word being taught and the word
    // the grader compares on.
    const words = riddle.split(" ");
    const answer = headWord(label, lang);
    const leaks =
      findPhrase(words, head) >= 0 || (answer.length > 2 && findPhrase(words, answer) >= 0);
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
    if (out.length === bandDraftFor(level, deep)) break;
  }
  // Applied AFTER the head-word pass and BEFORE verification, so a duplicate
  // never costs a crop check, and never reaches the round or the recap.
  return dedupeSameReferent(out, level);
}

// ── The inventory pass ──────────────────────────────────────────────────────

// The one place American English is spelled out, shared by every prompt that
// NAMES something: the inventory writes the glosses, the band pass writes the
// labels, and enrich writes the clues, sentences and wrong answers. Lux teaches
// American English, and leaving that to the model's default served "a passenger
// queue" repeatedly on an airport scene where the word is "a line".
//
// This is about which WORD the game teaches. It does not narrow what a learner
// may SAY: the regional-note machinery below still accepts "a lift" for an
// elevator and tells them warmly which one they will usually hear.
const AMERICAN = `
AMERICAN ENGLISH, always. Where American and British English use different words
for the same thing, the American one is the answer: a line (not a queue), a
faucet, a trash can, an elevator, a flashlight, a sweater, pants, sneakers, a
cell phone, a parking lot, a sidewalk, a cart, the trunk, the hood, a cookie, an
apartment, a stroller, a diaper, a bathroom. American spelling too: color,
gray, traveler, jewelry, center, labeled.
`.trim();

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

THIS IS A SWEEP, NOT A GLANCE. Someone standing in front of this picture can
name a hundred things in it, and the ones they reach for last are the best words
in it. Work the checklist below in order and go all the way down each part of
it. Do not stop when you have "enough": there is no enough, there is only what
is honestly visible, and stopping early is the one way to fail this task.

${sweepText()}

Granularities, one per entry:
- "object": whole things. A kiosk, a suitcase, a lanyard, a hat.
- "part": parts of those things. A brim, a cuff, a strap, a screen bezel.
- "material": what things are made of, where it is visible. Leather, chrome.
- "surface": distinct surfaces worth naming. A tiled floor, a glass partition.
- "state": visible conditions. A line of people, a crease, a reflection, wear.
- "action": actions frozen in the frame. Pouring, weighing, boarding.
- "person": anatomy, features and expression. A furrowed brow, a knuckle.
- "text": words actually legible in the picture. The word RESUME on a page.
- "interpretive": what the scene means. Eye contact, a polite smile, tension.

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
  * IT MUST CONTAIN ALL OF THE THING YOU NAMED, not the part of it that catches
    your eye. A box for a PERSON runs from the TOP OF THEIR HEAD, hair included,
    down to whatever of them is visible: a box that starts at the chin is a box
    of a torso. A box for a garment reaches its hem and its cuffs. A box for a
    clipboard includes its clip. Trace the whole outline before you write the
    numbers, then check the box against it.
  * NEVER A PERSON'S BODY. A box over someone's chest, neck, face or arm is only
    acceptable when the thing you named IS what they are wearing or holding, and
    then the box goes around the garment or the item, not the person.
  * A BOX BOUNDS THE OBJECT, NOT THE OPENING IT REVEALS. A door is the panel,
    open or shut, and not the doorway it swings out of; a window is the pane and
    its frame, not the view through it; a gate is the gate. When the thing is
    open, the box follows where the panel actually IS, which on an open bus door
    is folded against the side of the bus and not across the entrance.
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
- "point": { "x": 0.00-1.00, "y": 0.00-1.00 } - THE HEART OF THE THING: the
  single spot a person would put a fingertip on to say "that one". This is
  where an arrow will land, so it must be ON the thing and unmistakably in the
  middle of it, never on an edge, a corner or a rim.
  * For a PERSON, the CHEST. Not the face, and not the middle of their bounding
    box, which for a standing figure is somewhere around the hips.
  * For a large object, its centre of mass: the middle of the screen, the
    middle of the counter top, the middle of the suitcase's face.
  * For a group or a line of things, the middle of the whole cluster.

Entries must be VISUALLY UNAMBIGUOUS. Before you keep one, look at what
surrounds it: if a NEARBY thing could plausibly be given the same gloss, the
question has two right answers. Either make the gloss specific to one of them or
list both in "boxes".

${AMERICAN}

Do NOT write sentences, questions, clues or wrong answers here. A later pass
does that, and only for the entries that survive checking. Naming the thing and
placing it is the whole job.

COUNT CHECK, entry by entry: if there are several of a thing, either list every
one in "boxes" or make the gloss specific to ONE of them.
Never pick one of several lookalikes silently.

SWEEP CHECK, before you answer. Count your own entries per tier against the
minimums above. If a tier is short, go back to the picture and look again at
what that tier covers rather than padding another tier: a scene with two people
in it has not run out of person entries at four. The only acceptable reason for
a short tier is that the picture genuinely does not contain it (no legible text,
nobody in frame).

Before you answer, re-read your own list once and drop anything whose box does not
contain the WHOLE of the thing it names, anything drawn over a person's body that
is not their clothing or held item, and any vast bare surface. Look hardest at
the top edge of every box: a box that begins part way down its object is the
commonest way this goes wrong.

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
  // THE ODD ONE OUT WITH NO BOX. A boxless entry cannot be crop-verified,
  // tightened, tapped or pointed at with an arrow: it is served on the model's
  // unchecked word alone, and a real scan served "a paper clip" that way, with
  // its point on a bare table edge and no clip anywhere near it.
  //
  // Dropped only when the SAME answer gave boxes for other entries, which is
  // the difference between a model that failed on one entry and a model (or a
  // row cached before boxes existed) working without them at all. The second is
  // a regime this pipeline still supports; the first is a mistake.
  const boxed = out.filter((e) => e.box);
  const trimmed = boxed.length && boxed.length < out.length ? boxed : out;
  if (trimmed.length < out.length) {
    console.log(
      `[convo-image-targets] inventory dropped ${out.length - trimmed.length} boxless: ` +
        out.filter((e) => !e.box).map((e) => e.gloss).join("; "),
    );
  }

  // rawCount is what the model OFFERED, kept beside what survived, because
  // "found nothing" and "found things that all failed validation" are opposite
  // failures and the handler reports them apart.
  return { entries: trimmed, rawCount: list.length };
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
  const cap = bandDraftFor(level, deep);

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

  // A deep draw exists for the rapid-fire mode, whose whole texture is breadth:
  // it burns three words a second and a band-typical handful is one lap. So it
  // is told to take everything the band can honestly hold, including the words
  // one band to either side, marked at their real difficulty.
  const deepDraw = deep
    ? `

THIS IS A DEEP DRAW, for a rapid-fire mode that burns through words. Return as
MANY entries as honestly serve this level, up to the cap, not a comfortable
handful. Include words one band below and one band above as well, marked
"easy" and "hard" respectively; a rapid mode wants breadth more than it wants a
perfectly tuned centre.`
    : "";

  return `
${lang === "en" ? AMERICAN : ""}
You are choosing WORDS for a language learner from the nameable INVENTORY of a
photograph. Someone has already looked at the picture and listed everything in
it; your job is which entries to teach at this level, and what to call them.
${band}${wordNotThing}${swap}${deepDraw}

ORDER MATTERS: the first entries you list are the ones a learner meets first,
and a short round may never reach the last. Rank them:

  1. TIED TO THE CONVERSATION. The scene description above says what this picture
     was made for. A word that belongs to that subject is worth more than an
     equally good word that does not: in an interview scene, the resume and the
     handshake before the window frame and the floor.
  2. CONCRETE BUT GENERAL. Solid nameable things and their parts, in no
     particular relation to the topic.
  3. INTERPRETIVE. What the scene means: an expression, a mood, body language,
     the situation itself. Last in the order and NOT last in value, because at
     the top bands it is the only tier that is genuinely hard.

${
  HIGH_BANDS.has(level)
    ? `AT THIS BAND, REACH FOR THE HARD TIERS. Parts, materials, textures, small
features and interpretive entries are what this level is for; whole ordinary
objects belong two bands down. Where B1 would be given "a face", ask for "a
furrowed brow"; where B1 gets "a jacket", ask for "a lapel" or "a herringbone
weave".`
    : `AT THIS BAND, STAY CONCRETE. Whole things and their obvious parts. Leave
the textures, the materials and the interpretive entries to the bands above:
a learner who cannot yet say "a jacket" is not helped by "a herringbone weave".`
}

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
    // AMERICAN English, said out loud rather than left to the model's default.
    // Lux teaches American English, and "English" alone got "a passenger queue"
    // served repeatedly on an airport scene where the word is "a line". It
    // rides on every prompt because langName is what every prompt names.
    langName: "American English",
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

Every string must be in ${p.langName}. ${lang === "en" ? AMERICAN : ""}
Return JSON only, no markdown.

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
  Two or three attributes at most, from what is actually visible: color first,
  then material, size or shape. ${p.riddleExample}
  It MUST NOT contain the NOUN being taught, or any word that names what the
  thing IS. "small and red" is a riddle; "a small red toolbox" is the answer.
  Some labels already describe themselves ("a brown long-sleeve shirt"): there,
  keep the noun out ("shirt") and the clue is fine even though it repeats an
  adjective the label also uses. Omit the field only if the thing has no
  attribute worth saying, which is rare: nearly everything has a color.

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

Question 3, only if yes: WHERE IS ALL OF IT in this crop?

Give "bounds" as { "x", "y", "w", "h" }: the box that contains the thing's WHOLE
visible extent within this crop, as fractions of the crop. x and y are its
top-left corner from the left and top edges, w and h its width and height.

  * ALL of it, not the part that catches your eye. A PERSON runs from the top of
    their head to whatever of them is visible, hair included. A garment runs to
    its hem and its cuffs. A clipboard includes its clip.
  * Only what is IN this crop. If the thing continues past an edge, stop at the
    edge and say so with "cut": true.
  * Be accurate rather than safe. These bounds are checked against the box the
    crop was cut for, and a box that does not cover them is REDRAWN to them, so
    lazy bounds move a marker onto the wrong thing.

Return JSON only:
{ "shows": true, "prominence": "main",
  "bounds": { "x": 0.0, "y": 0.0, "w": 0.0, "h": 0.0 }, "cut": false }
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
    const bounds = unitBox(parsed?.bounds);
    return {
      shows: parsed?.shows === true,
      why: String(parsed?.why || "").slice(0, 60),
      // Unrated but shown is treated as "part": good enough to score, not
      // asserted to be worth cropping.
      prominence: PROMINENCE.has(prom) ? prom : "part",
      // The thing's whole visible extent WITHIN THE CROP, for the coverage
      // check. Absent when the model did not answer, and absent is not a
      // failure: an older cached judgement and a model that skipped the field
      // are the same shape.
      bounds,
      // The thing runs past the crop's edge, so its bounds are a floor rather
      // than the truth and the excess test cannot be applied to them.
      cut: parsed?.cut === true,
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

/**
 * Are these two boxes the same thing drawn twice?
 *
 * CONTAINMENT, NOT IoU, and the difference is not academic. IoU divides by the
 * UNION, so the same laptop boxed generously once and tightly once scores about
 * 0.5 and reads as two laptops. Measured on this exact case: the row's own box
 * for the closed laptop on parents-1 and the enumeration's box for it came out
 * at IoU 0.51, under the 0.6 same-referent threshold, and the target was served
 * `instances: "many"` for a picture holding one laptop.
 *
 * That is the failure this whole finding is about, pointing the other way. An
 * under-count makes Find It ask a question only one tap can answer; an
 * over-count makes it accept a tap on something that is not the thing. Both are
 * the game being wrong about its own question.
 *
 * Dividing by the SMALLER area asks the right question: how much of the smaller
 * box is inside the larger one. Two genuinely separate posters on a wall share
 * no pixels at all and score 0; one object drawn twice scores near 1 whatever
 * the difference in generosity. IoU is kept as well, because two boxes can be
 * the same referent without either containing the other.
 */
function sameInstance(a, b) {
  if (!a || !b) return false;
  if (iou(a, b) >= SAME_REFERENT_IOU) return true;
  const w = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const h = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const smaller = Math.max(1e-6, Math.min(a.w * a.h, b.w * b.h));
  return (w * h) / smaller >= SAME_REFERENT_IOU;
}

/**
 * "How many of each of these are there, and where?" — one call, all labels.
 *
 * THIS IS THE PASS THE VERSION COMMENT PROMISED AND THE CODE DID NOT HAVE.
 * VERIFIED_V 3 said a v3 row had had "every LABEL re-examined for instances the
 * row never held". It had not: v8 deleted the enumeration call on the reasoning
 * that the LOCATE prompt now carries the count check, so instances arrive in
 * `boxes` before verification runs. That reasoning is exactly right for a FRESH
 * scan and exactly wrong for a CACHED one, which never went through today's
 * locate call at all. verifyTargets plans its candidates from the boxes the row
 * arrived with, so a heal could only ever lose instances, never find one.
 *
 * The cost of the gap is a question the game cannot answer: Mark was asked
 * "Where is a poster?" in a classroom covered in posters and one small poster
 * accepted, because the row held one poster box, instanceConfidence read
 * `boxCount === 1`, and Find It was told the label was settled.
 *
 * Deliberately NOT run on the fresh path. There it would be paying twice for one
 * answer, which is what v8 removed.
 *
 * @returns {Map<number, Array<{x,y,w,h}>>} label index -> every instance found
 */
async function enumerateInstances(openai, model, imageUrl, labels, langName) {
  const found = new Map();
  if (!labels.length) return found;
  try {
    const list = labels.map((l, i) => `${i}. ${l}`).join("\n");
    const resp = await timed("enumerate", () =>
      openai.chat.completions.create({
        model,
        temperature: 0,
        max_tokens: 1600,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `For EACH label below (${langName}), find EVERY separate instance of
it in this photograph and give one tight bounding box per instance.

${list}

COUNT HONESTLY. If the photograph holds seven chairs, return seven boxes for
"chair", not one. This is the whole question being asked: a game that says "where
is a poster" in a room full of posters and accepts only one of them is wrong
about its own question.

Each box must HUG its instance: x and y are the top-left corner as fractions of
the image from the left and top edges, w and h its width and height as fractions.
At most ${MAX_INSTANCES} boxes per label; if there are more than that, the label
describes a crowd rather than a thing, so return ${MAX_INSTANCES} and set
"crowd": true for it.
A label that is genuinely not in the photograph gets an empty "boxes" array.

AND SAY WHETHER YOU ARE SURE. For each label set "only" to true ONLY if you are
confident you have found every instance and there are no others anywhere in the
frame, including small, blurred, partly hidden or background ones. If there might
be another you did not box, set "only": false. Being unsure is a useful answer
here and guessing is not: the game asks the learner to point at the thing, and it
would rather not ask about a label than ask about one and mark a right answer
wrong.

Return JSON only:
{ "labels": [ { "i": 0, "crowd": false, "only": true, "boxes": [ { "x":0.0,"y":0.0,"w":0.0,"h":0.0 } ] } ] }`,
              },
              { type: "image_url", image_url: { url: imageUrl, detail: "high" } },
            ],
          },
        ],
      }),
    );
    const parsed = JSON.parse(resp?.choices?.[0]?.message?.content || "{}");
    for (const row of Array.isArray(parsed?.labels) ? parsed.labels : []) {
      const i = Number(row?.i);
      if (!Number.isInteger(i) || i < 0 || i >= labels.length) continue;
      const boxes = (Array.isArray(row?.boxes) ? row.boxes : [])
        .map((b) => unitBox(b))
        .filter(Boolean)
        .slice(0, MAX_INSTANCES);
      // A label the model calls a crowd is recorded even when its boxes are
      // useless: "there are more of these than I can point at" is the single
      // most useful thing it can say, and it is what Find It has to refuse on.
      found.set(i, { boxes, crowd: row?.crowd === true, only: row?.only === true });
    }
  } catch (e) {
    // NOT a failure of the targets. A row whose enumeration could not be run is
    // a row we still know nothing about, and the caller says so rather than
    // claiming the single box it holds is the whole story.
    console.warn("[convo-image-targets] enumerate failed:", e?.message || e);
    return found;
  }
  return found;
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
// ── Box tightening ──────────────────────────────────────────────────────────
//
// A box that passed verification still is not necessarily SNUG, and the arrow
// anchors on the box edge: a loose box parks the arrow beside the object, which
// on film reads as a near miss and makes the sprint a guess. So every accepted
// primary box gets one refinement: a padded crop around it, an ask for the snug
// bounds of the label WITHIN that crop, and the tightened box is kept only when
// it genuinely shrank AND its own crop still shows the thing. Every gate fails
// toward the box that already passed.

// How much context the refinement crop carries around the accepted box. Enough
// that the model can see where the object ends; little enough that a neighbour
// does not move in.
const TIGHTEN_PAD = 0.35;
// A tightened box must be at most this fraction of the old area to be worth
// keeping: below a real shrink, churn is all downside.
const TIGHTEN_KEEP_RATIO = 0.9;

/** The padded crop region around a box, clamped to the frame. */
function paddedBox(b) {
  const px = b.w * TIGHTEN_PAD;
  const py = b.h * TIGHTEN_PAD;
  const x = Math.max(0, b.x - px);
  const y = Math.max(0, b.y - py);
  return {
    x,
    y,
    w: Math.min(1 - x, b.w + px * 2),
    h: Math.min(1 - y, b.h + py * 2),
  };
}

/** Ask for the snug bounds of `label` within a crop. Fractions OF THE CROP. */
async function askSnug(openai, model, crop, label, langName) {
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
              text: `This is a crop from a larger photograph. Give the snug bounding box of
"${label}" (${langName}) WITHIN THIS CROP: x and y its top-left corner as
fractions of the crop from the left and top edges, w and h its width and height
as fractions of the crop. The box must HUG the thing: no margin, no neighbours.
If "${label}" is not visible in this crop, say so instead of guessing.
Return JSON only: { "box": { "x": 0.0, "y": 0.0, "w": 0.0, "h": 0.0 } }
or { "absent": true }`,
            },
            { type: "image_url", image_url: { url: crop, detail: "low" } },
          ],
        },
      ],
    });
    const parsed = JSON.parse(resp?.choices?.[0]?.message?.content || "{}");
    if (parsed?.absent === true) return null;
    return unitBox(parsed?.box);
  } catch (e) {
    console.warn("[convo-image-targets] snug ask failed:", e?.message || e);
    return null;
  }
}

/**
 * Tighten every accepted primary box, in the same pool the crop checks use.
 *
 * Returns the same targets, some with a snugger box, boxes[0] and point moved
 * with it. Secondaries are left alone: they exist so any instance scores, and
 * the arrow only ever anchors on the primary.
 */
async function tightenBoxes(openai, model, imageUrl, targets, lang, size) {
  const langName = PACK[lang].langName;
  const check = pickCheckModel();
  const jobs = targets.map((t, i) => async () => {
    const b = t.box;
    if (!b || t.boxOk === false) return null;
    const pad = paddedBox(b);
    if (pad.w <= 0 || pad.h <= 0) return null;
    const crop = await timed("tighten.cut", () => cropRegion(imageUrl, pad, size));
    if (!crop) return null;
    const snug = await timed("tighten.ask", () => askSnug(openai, check, crop, t.label, langName));
    if (!snug) return null;
    // Crop fractions back to image fractions.
    const cand = unitBox({
      x: pad.x + snug.x * pad.w,
      y: pad.y + snug.y * pad.h,
      w: snug.w * pad.w,
      h: snug.h * pad.h,
    });
    if (!cand) return null;
    const oldArea = b.w * b.h;
    const newArea = cand.w * cand.h;
    if (!(newArea > 0)) return null;
    // Two reasons to take the new box, and the second is v11's.
    //
    // SHRANK: it hugs the thing better, which is what this pass was built for.
    // RECENTRED: the snug box's centre is not inside the OLD box at all, which
    // means the model has just told us the thing is somewhere else. That is a
    // displaced box being repaired rather than dropped, and repairing is much
    // the better outcome: the alternative empties a round over a box the
    // pipeline could have fixed from an answer it already paid for.
    const shrank = newArea <= oldArea * TIGHTEN_KEEP_RATIO;
    const nx = cand.x + cand.w / 2;
    const ny = cand.y + cand.h / 2;
    const recentred = nx < b.x || nx > b.x + b.w || ny < b.y || ny > b.y + b.h;
    if (!shrank && !recentred) return null;
    // The tightened crop must still show the thing, on the same judge the box
    // originally passed. A snug box of the WRONG thing is worse than a loose
    // box of the right one.
    const recut = await timed("tighten.cut", () => cropRegion(imageUrl, cand, size));
    if (!recut) return null;
    const again = await timed("tighten.ask", () => askCrop(openai, check, recut, t.label, langName));
    if (!again.shows) return null;
    // The recheck answers about a PADDED crop like every other check, so it
    // needs the same centring test, or the candidate is accepted on a sliver
    // exactly as the original box was.
    if (!coversTheThing(cand, again, size).ok) return null;
    // And a RECENTRE is a much bigger claim than a shrink: it says the thing is
    // somewhere else entirely. Measured on a real scan, a loose recentre moved
    // a correct box off a man in a suit and onto the window behind him. So it
    // must be the crop's main subject, not merely present in it.
    if (recentred && again.prominence !== "main") return null;
    console.log(
      `[convo-image-targets] ${recentred ? "RECENTRED" : "tightened"} "${t.label}": area ${(oldArea * 100).toFixed(1)}% -> ${(newArea * 100).toFixed(1)}% of frame` +
        (recentred ? ` (centre moved outside the old box)` : ` (${Math.round((1 - newArea / oldArea) * 100)}% smaller)`),
    );
    return { i, box: cand, prominence: again.prominence };
  });
  const results = await pooled(jobs, VERIFY_CONCURRENCY);
  let tightened = 0;
  for (const r of results) {
    if (!r) continue;
    const t = targets[r.i];
    const boxes = Array.isArray(t.boxes) && t.boxes.length ? [...t.boxes] : [t.box];
    boxes[0] = r.box;
    t.box = r.box;
    if (Array.isArray(t.boxes)) t.boxes = boxes;
    t.point = heartFor(t.point, r.box);
    tightened++;
  }
  if (tightened) {
    console.log(`[convo-image-targets] tighten pass: ${tightened}/${targets.length} boxes snugged`);
  }
  return targets;
}

async function verifyTargets(openai, model, imageUrl, targets, lang, { enumerate = false } = {}) {
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
  //
  //    EXCEPT ON THE HEAL PATH, where that reasoning inverts. A cached row never
  //    went through today's locate call, so its boxes are whatever the pipeline
  //    of the day happened to record, and planning from them alone means the
  //    heal can only ever LOSE an instance. It could not find the second poster
  //    if the picture were papered with them, which is the filed bug.
  const counted = new Map();
  if (enumerate && targets.length) {
    const seen = await enumerateInstances(
      openai,
      check,
      imageUrl,
      targets.map((t) => t.label),
      langName,
    );
    for (const [i, row] of seen) counted.set(i, row);
    console.log(
      `[convo-image-targets] enumerated ${counted.size}/${targets.length} labels for instances`,
    );
  }

  const plan = targets.map((t, ti) => {
    const original = Array.isArray(t.boxes) && t.boxes.length ? t.boxes : t.box ? [t.box] : [];
    const seen = counted.get(ti);
    // The row's own boxes FIRST, so a box that has already survived a crop check
    // keeps its place at the head of the list, and only genuinely new instances
    // are added behind it. Same-referent duplicates are dropped on IoU, the same
    // test dedupeSameReferent uses, so pointing at the same chair twice does not
    // turn one chair into "many".
    const merged = [...original];
    for (const box of seen?.boxes || []) {
      if (merged.some((b) => sameInstance(b, box))) continue;
      merged.push(box);
    }
    return {
      t,
      counted: !!seen,
      crowd: seen?.crowd === true,
      only: seen?.only === true,
      cands: merged.slice(0, MAX_INSTANCES).map((box) => ({ box, visibility: "partial" })),
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

        // COVERAGE, not merely presence, and CONVERGED rather than judged once.
        // The box has to BOUND the thing's visible extent without much excess;
        // "somewhere in the padded crop" was how a box drawn beside the thing
        // survived, and "holds its centre" was how a box drawn across PART of it
        // survived. When it fails, the bounds the model just gave ARE the
        // thing's place, so the box is redrawn to them and asked again: each
        // crop is centred better than the last, so a box that started badly
        // walks onto its object instead of being thrown away.
        let box = c.box;
        let ask = a;
        let last = null;
        let rescued = false;
        // THE BEST BOX SEEN, not the most recent. The loop used to carry only
        // the latest candidate, so a target that reached 0.744 on its second
        // look and 0.472 on its third was given up on holding the third. That
        // is a straight bug and the forensics caught it twice in one scan.
        let best = null;
        for (let attempt = 0; attempt < REDRAW_TRIES; attempt++) {
          if (!ask.shows) {
            // "NOT VISIBLE HERE" IS USUALLY A CLAIM ABOUT THE BOX, not the
            // photograph, and on a small feature it is almost always the box.
            //
            // The v13 sweep asks one pass to name ninety things AND place all of
            // them, and the places it draws least carefully are the small ones:
            // an eye, a nose, lips, an ear, a wedding ring, a cuff. Measured on
            // the interview scene, nine of fifteen candidates died here and the
            // reasons were "no wedding ring visible", "nose is cut off", "lips
            // not visible in this crop", for a picture that plainly contains a
            // ring, a nose and lips. Dropping those is throwing away exactly the
            // words this round was built to reach.
            //
            // So a target gets ONE look at the whole photograph before it is
            // given up on, through the same relocalize the rescue pass has used
            // since v6, and then rejoins the convergence loop like any other
            // box. Once per target, so a label that really is absent costs one
            // extra call and not a spiral.
            if (rescued) return { ti, ci, shows: false, why: ask.why || last?.why };
            rescued = true;
            const found = await timed("relocalize", () =>
              relocalize(openai, check, imageUrl, p.t.label, langName),
            );
            if (!found) return { ti, ci, shows: false, why: ask.why || last?.why };
            console.log(`[convo-image-targets] relocalized "${p.t.label}": ${ask.why}`);
            box = found;
            const wider = await timed("crop.cut", () => cropRegion(imageUrl, box, size));
            if (!wider) return { ti, ci, shows: false, why: ask.why };
            ask = await timed("crop.ask", () => askCrop(openai, check, wider, p.t.label, langName));
            continue;
          }
          const cov = coversTheThing(box, ask, size);
          if (process.env.ISPY_COVER_LOG) {
            console.log(`[cover] ${p.t.label}	try=${attempt}	cover=${cov.cover.toFixed(3)}	excess=${cov.excess.toFixed(2)}	ok=${cov.ok}`);
          }
          if (cov.ok) {
            return box === c.box
              ? { ti, ci, shows: true, prominence: ask.prominence }
              : { ti, ci, shows: true, prominence: ask.prominence, box, redrawn: true };
          }
          // WHEN COVER IS HIGH, THE BOUNDS WE WERE JUST GIVEN ARE THE ANSWER.
          //
          // Found in the second forensic run: the loop converges by GROWING the
          // box until it holds the whole thing, and then overshoots. "a knit
          // hat" ended at cover 1.00 with excess 2.21, "a puffer jacket" at
          // cover 1.00 with excess 1.85. Cover 1.00 means our box contains all
          // of the thing, and `found` is where the model says the thing
          // actually is, so `found` is a correct TIGHT box and we already have
          // it. Remembering it costs nothing and rescues exactly the targets
          // that ran out of tries while oscillating.
          const tight = cov.cover >= COVER_MIN ? unitBox(cov.found) : null;
          if (tight) {
            best = { cover: cov.cover, excess: 1, box: tight, prominence: ask.prominence };
          } else if (!best || cov.cover > best.cover + COVER_PROGRESS) {
            best = { cover: cov.cover, excess: cov.excess, box, prominence: ask.prominence };
          }
          last = cov;
          // The measurement is one question; whether it is SERVABLE is another.
          // A redraw faces the same box gate a model's own box does, and one
          // that cannot pass it is a failure rather than a licence to keep the
          // box that just failed.
          const next = unitBox(cov.found);
          // Converged on a box it will not leave, so more asks would only cost
          // money. iou is already here for referent dedup and says exactly this.
          if (!next || iou(next, box) > 0.97) {
            return settle(ti, ci, best, cov.why);
          }
          console.log(
            `[convo-image-targets] redraw ${attempt + 1} "${p.t.label}": ${cov.why} ` +
              `(cover ${(cov.cover * 100).toFixed(0)}%, excess ${cov.excess.toFixed(2)}x)`,
          );
          box = next;
          const recrop = await timed("crop.cut", () => cropRegion(imageUrl, box, size));
          if (!recrop) return { ti, ci, shows: false, why: cov.why };
          ask = await timed("crop.ask", () => askCrop(openai, check, recrop, p.t.label, langName));
        }
        return settle(ti, ci, best, last?.why || "box never settled on the thing");
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
    // A redrawn candidate carries its NEW box: the one the model pointed at when
    // it was told the old one covered only part of the thing.
    if (v.shows) byTarget[v.ti].push({ ...cand, ...(v.box ? { box: v.box } : null), prominence: v.prominence });
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
      if (!a.shows || !coversTheThing(again, a, size).ok) return null;
      return { ti, box: again, visibility: a.prominence || "partial" };
    }),
    VERIFY_CONCURRENCY,
  );
  for (const r of rescues) if (r) byTarget[r.ti].push({ box: r.box, visibility: r.visibility });

  const checked = plan.map((p, ti) => {
    const t = p.t;
    // A target that arrived with nothing to look at keeps its shape exactly, so
    // a row cached before boxes existed comes back as it went in. It gains one
    // fact on the heal path: nobody has counted it, so its instance claim (if it
    // even has one, from a pipeline that predates the question) is not evidence.
    if (!p.cands.length && !byTarget[ti].length) {
      return enumerate ? { ...t, instances: "unknown" } : t;
    }
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
    // AND DEDUPED AGAIN, HERE, WHERE THE BOXES ARE FINAL.
    //
    // The merge before the crop pool cannot be the last word, because the REDRAW
    // loop moves boxes after it: two candidates that were far enough apart to
    // look like two instances are each walked onto the object they belong to,
    // and on parents-1 that turned one closed laptop into "many" with the row's
    // own box and a redrawn copy of it sitting on top of each other. Converging
    // is what the redraw is FOR; noticing that it converged is this line.
    const boxes = [];
    for (const k of kept) {
      if (boxes.some((b) => sameInstance(b, k.box))) continue;
      boxes.push(k.box);
    }
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
      // Mapped from `boxes` rather than from `kept`, or the two arrays fall out
      // of step the moment the dedupe above drops one.
      vis: boxes.map((b) => (kept.find((k) => k.box === b) || {}).visibility || "partial"),
      // Whether ANY instance is worth cutting out and showing. False excludes
      // this target from the crop-based modes for this picture; it stays a
      // perfectly good name and find target, because a box that is right is
      // still right even when the view of it is poor.
      cropOk: CROP_GATE.has(kept[0].prominence),
      // Whether every instance of this label is accounted for. Find It refuses
      // "unknown", because asking "where is a passenger" on a bus and accepting
      // only one of them is the game being wrong about its own question.
      //
      // `counted` is the fact that decides it on a cached row: without an
      // enumeration behind it, one box is one box and says nothing at all about
      // how many there are.
      instances: instanceConfidence(t.label, boxes.length, lang, {
        counted: enumerate ? p.counted : true,
        // Whether the pass that counted was SURE it had found them all. A single
        // box is not evidence of singularity on its own: asked of Mark's
        // classroom, the enumeration returned one poster for a wall carrying
        // several, and a count of one taken as proof is the original bug in a
        // newer coat. Under enumeration, "one" now requires the model to have
        // said so.
        sure: enumerate ? p.only : true,
        crowd: p.crowd,
      }),
      // The point follows the box it belongs to, unless the model's own HEART
      // still lands inside that box, in which case it is the better answer: a
      // person's heart is their chest and their box's middle is their hips.
      // This line ran before the tighten pass, so replacing it there was not
      // enough; the heart was already gone by the time tightening looked.
      point: heartFor(t.point, first),
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
  const kept = checked.filter((t) => t.boxOk !== false);
  // Stage D: one refinement pass on the survivors, so the arrow anchors on the
  // thing rather than beside it. Inside verifyTargets so every caller, the
  // wave, the tail, the deepen and the cached-row heal, inherits it.
  return withPhase("tighten", () => tightenBoxes(openai, model, imageUrl, kept, lang, size));
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
          // model and updated_at are read for the VINTAGE STAMP, not for any
          // decision here: what Mark eyes judge has to be able to name its own
          // age, and a row that cannot say when it was written cannot.
          .select("targets, v, verified, model, updated_at")
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
            return res.status(200).json({
              ok: true, cached: true, imageKey, lang, targets: kept,
              vintage: vintageOf({ v: data.v, verified: VERIFIED_V, source: "healed", model: data.model }),
            });
          }
        }
        if (servable && data.verified !== VERIFIED_V && imageUrl) {
          const openaiForCheck = await tryOpenAI();
          if (openaiForCheck) {
            const model = pickModel();
            // GEOMETRY AND INSTANCES. `enumerate` is the half a heal never had:
            // without it this pass judges only the boxes the row already carried,
            // so it could confirm one poster and never discover the other eleven.
            // See enumerateInstances.
            let checked = await verifyTargets(openaiForCheck, model, imageUrl, kept, lang, {
              enumerate: true,
            });
            // Held to the same floor as a fresh scan. Re-examination drops
            // targets exactly the way generation does, so a row that heals from
            // five down to four is thin for the same reason and gets the same
            // one extra ask.
            checked = await topUpIfThin(openaiForCheck, model, imageUrl, {
              sb, imageKey, description, lang, level, targets: checked, exclude, prefer, avoid, misses, deep,
            });
            // AND ENRICHMENT, the third of the three and the one that was
            // silently exempt. Cloze, choices, aliases, the usage note and the
            // riddle all rode through a heal untouched, so a row written before
            // riddles existed healed into a perfectly audited row with no clues
            // in it and left the Riddle chip dark forever.
            //
            // The top-up additions were worse than untouched: sanitizeLocated
            // returns a bare target, the fresh path enriches those immediately
            // afterwards and this path did not, so a heal could WRITE targets
            // with no cloze and no choices and stamp them current.
            //
            // Fails toward what the row already had. Enrichment drops a target it
            // cannot write for, so a bad run could gut a good row; if it comes
            // back short, the old material stands and the row keeps its geometry
            // and instance fixes anyway.
            const enriched = await enrichTargets(openaiForCheck, model, imageUrl, checked, {
              lang, level, seed: imageKey,
            });
            const rewritten = new Map(enriched.map((t) => [fold(t.label), t]));
            checked = checked
              // PER TARGET, not all-or-nothing. Enrichment DROPS a target it
              // cannot write for, which is right on a fresh scan where the
              // alternative is shipping a broken target, and wrong here: this
              // target already has a cloze and choices that worked, and losing
              // it costs the learner a word to pay for a model's silence.
              .map((t) => rewritten.get(fold(t.label)) || t)
              // Except when it has nothing either way. A top-up addition arrives
              // bare from sanitizeLocated, so an addition the enrich declined is
              // genuinely unplayable rather than merely un-refreshed, and every
              // mode reads these fields.
              .filter((t) => typeof t.cloze === "string" && Array.isArray(t.choices) && t.choices.length);
            if (enriched.length < checked.length) {
              console.log(
                `[convo-image-targets] heal enrich rewrote ${enriched.length}/${checked.length}; ` +
                  `the rest kept their own material (key=${imageKey} level=${level || "-"})`,
              );
            }
            if (checked.length >= MIN_SERVED_TARGETS || checked.length === kept.length) {
              await writeRow(sb, { imageKey, lang, level, targets: checked, model });
              return res.status(200).json({
                ok: true, cached: true, imageKey, lang, targets: checked,
                vintage: vintageOf({ v: data.v, verified: VERIFIED_V, source: "healed", model }),
              });
            }
            // Verification gutted the row. Fall through and regenerate: the
            // boxes were wrong, so re-serving them would be re-serving the bug.
            console.log(
              `[convo-image-targets] crop check left ${checked.length}/${kept.length}, regenerating ` +
                `(key=${imageKey} level=${level || "-"})`,
            );
          }
        } else if (servable && !(deep && kept.length < DEEP_MIN_TARGETS)) {
          return res.status(200).json({
            ok: true, cached: true, imageKey, lang, targets: kept,
            vintage: vintageOf({
              v: data.v, verified: data.verified, at: data.updated_at,
              source: "cache", model: data.model,
            }),
          });
        }
        if (imageUrl) {
          console.log(
            `[convo-image-targets] regenerating: ${kept.length}/${data.targets.length} cached ` +
              `targets survived current rules (key=${imageKey} level=${level || "-"})`
          );
        } else if (kept.length) {
          // A key-only probe has no bytes to regenerate from. A thin round beats
          // pretending the picture has nothing in it.
          return res.status(200).json({
            ok: true, cached: true, imageKey, lang, targets: kept,
            vintage: vintageOf({
              v: data.v, verified: data.verified, at: data.updated_at,
              source: "cache", model: data.model,
            }),
          });
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
      vintage: vintageOf({ model: MODEL }),
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
  // The over-ask is trimmed HERE, after verification has taken its half, which
  // is the whole point of over-asking: cut before this and the surplus would be
  // discarded while it was still needed.
  if (targets.length > maxTargetsFor(level, deep)) {
    console.log(
      `[convo-image-targets] over-ask kept ${maxTargetsFor(level, deep)} of ${targets.length} verified`,
    );
    targets = targets.slice(0, maxTargetsFor(level, deep));
  }

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
  return sendOnce(res, { ok: true, cached: false, imageKey, lang, targets, ...shortInfo, vintage: vintageOf({ model: MODEL }) });
}
