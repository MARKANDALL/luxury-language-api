// routes/coach-page/context.js
// THE CONTEXT DIET — what the answering model is actually allowed to see.
//
// The frontend has been sending a `context` field on every coach-page request
// since the charter rows shipped (ui/coach-row-logic.js buildCoachAsk, which
// prunes the keys a page cannot fill truthfully and omits the field entirely
// when nothing survives). The server ignored it. That is why the All Data coach
// invented "your most stubborn sound is /t/" while holding the aggregates that
// name the real one, why the picker could not compare two scenarios it had been
// handed, and why the guided-chat coach could not comment on turns it could see.
//
// This module is the missing half: it decides WHICH of those keys reach the
// expensive call, and it bounds them so a 26-scenario catalog cannot eat the
// context window.
//
// THREE RULES, IN ORDER
//
//   1. THE LANE CHOOSES THE DIET. The classifier already ran, so we know what
//      kind of question this is before we pay for the answer. A PATTERNS ask
//      needs the aggregates and the learner model and nothing about the passage
//      in the box; an EXPLAIN ask needs the page state and nothing about last
//      month; NAV_HELP and CREATOR_INFO need the knowledge doc and no page state
//      at all; LANGUAGE_GENERAL needs neither — the learner profile it already
//      gets is the whole of its grounding. Cost down, focus up.
//
//   2. BOUND EVERYTHING, DETERMINISTICALLY. Same input, same bytes out — always.
//      Arrays are cut from the front, strings from the front, keys in the
//      declared diet order. Nothing is sorted by size, sampled, or shuffled, so
//      a truncation is reproducible from the request alone.
//
//   3. SAY WHAT WAS CUT. `note` is a one-line, learner-invisible summary of the
//      trimming, and it rides to the model beside the context. It exists for the
//      grounding rules: a coach told "showing 8 of 26 scenarios" cannot honestly
//      conclude the other 18 do not exist, and the answering prompt says so.
//      Silence is not evidence of absence.
//
// KEYS COME FROM THE CHARTER, NOT FROM GUESSWORK. CONTEXT_SLICES below is a
// transcription of the `contextSlice` array on every row of the frontend's
// ui/coach-charter.js, plus the extra keys the row builders actually send
// (practiceSkills adds partCount and passageKey). A key that is not in a diet
// list is simply never forwarded — an unknown key from a future row is dropped
// rather than smuggled through, and stats.skipped counts it so a new row that
// forgets to update this file is visible in the logs instead of silent.

// ── The charter's slices, per row (documentation + the source of the unions) ──
// Kept as data rather than prose so a future row can be added in one edit and
// the drift between this file and ui/coach-charter.js stays greppable.
export const CONTEXT_SLICES = Object.freeze({
  __global: Object.freeze(["bibleGlobal", "biblePageSection", "learnerSnapshot"]),
  practiceSkills: Object.freeze([
    "referenceText",
    "partIndex",
    "partCount",
    "passageKey",
    "scrutinyValue",
    "firstLang",
    "learnerFlagsForPassagePhonemes",
    "azureResultLatest",
  ]),
  picker: Object.freeze(["scenarioCatalog", "scenarioHistory", "knobValues", "learnerLevel"]),
  guidedChat: Object.freeze([
    "lastThreeTurns",
    "characterCard",
    "scenario",
    "knobValues",
    "earResultLatest",
  ]),
  streaming: Object.freeze([
    "sessionTranscript",
    "turnFlags",
    "timingData",
    "spontaneousVsPracticedDeltas",
  ]),
  allData: Object.freeze([
    "historyAggregates",
    "learnerModelFull",
    "streaks",
    "perTypeAccumulatives",
  ]),
  myWords: Object.freeze(["savedItems", "perWordHistory", "overuseAvoidanceFlags"]),
  journey: Object.freeze(["chapterId", "firstLang", "learnerStageMapping"]),
});

// ── The two families a lane can eat ─────────────────────────────────────────
// ORDER IS PRIORITY. The budget is spent front to back, so the key that most
// defines the question comes first and the nice-to-have comes last: when the
// budget runs out it is the tail that is dropped, every time, predictably.

/**
 * IMMEDIATE PAGE STATE — what is on the learner's screen right now. This is
 * EXPLAIN's diet (and, smaller, ROUTE_TO_PAGE's): the anchor says WHICH thing
 * they are asking about, and these keys are the room it is standing in.
 */
export const PAGE_STATE_KEYS = Object.freeze([
  // practiceSkills — the passage and the take against it
  "referenceText",
  "azureResultLatest",
  "partIndex",
  "partCount",
  "passageKey",
  "scrutinyValue",
  "learnerFlagsForPassagePhonemes",
  // guidedChat — the scene and the exchange inside it
  "lastThreeTurns",
  "characterCard",
  "scenario",
  "earResultLatest",
  // picker — the deck and the dials
  "knobValues",
  "scenarioCatalog",
  "scenarioHistory",
  // journey — where in the road the learner is reading
  "chapterId",
  "learnerStageMapping",
  // myWords / streaming — the surface's own material
  "savedItems",
  "sessionTranscript",
  "turnFlags",
  "timingData",
  // row 0 and the small scalars every row may carry
  "learnerLevel",
  "firstLang",
  "learnerSnapshot",
  "biblePageSection",
]);

/**
 * THE LEARNER'S OWN HISTORY — aggregates and the learner model. This is
 * PATTERNS' diet, and only PATTERNS': "do I always mess up the th sound" is
 * answered from what the history says, never from the passage in the box.
 */
export const LEARNER_HISTORY_KEYS = Object.freeze([
  "historyAggregates",
  "learnerModelFull",
  "streaks",
  "perTypeAccumulatives",
  "perWordHistory",
  "overuseAvoidanceFlags",
  "spontaneousVsPracticedDeltas",
  "scenarioHistory",
  "learnerSnapshot",
]);

// ── The diet, per lane ──────────────────────────────────────────────────────
// `keys`      the whitelist, in priority order (see above).
// `maxChars`  the serialized ceiling for this lane's whole context block.
// `knowledge` whether this lane also gets the knowledge doc (routes/coach-page/
//             knowledge.js owns the reading; this flag owns the policy).
//
// The two budgets are not equal on purpose. PATTERNS is the lane whose entire
// job is reading numbers it was handed, so it gets the most room. EXPLAIN is
// answering about ONE thing on screen and the anchor already carries it, so it
// gets less. ROUTE_TO_PAGE is a two-line holding answer before a handoff (Law 5)
// and gets least of all — the destination page is where the depth lives.
export const LANE_DIET = Object.freeze({
  EXPLAIN: Object.freeze({ keys: PAGE_STATE_KEYS, maxChars: 3000, knowledge: false }),
  PATTERNS: Object.freeze({ keys: LEARNER_HISTORY_KEYS, maxChars: 4000, knowledge: false }),
  NAV_HELP: Object.freeze({ keys: Object.freeze([]), maxChars: 0, knowledge: true }),
  CREATOR_INFO: Object.freeze({ keys: Object.freeze([]), maxChars: 0, knowledge: true }),
  LANGUAGE_GENERAL: Object.freeze({ keys: Object.freeze([]), maxChars: 0, knowledge: false }),
  ROUTE_TO_PAGE: Object.freeze({ keys: PAGE_STATE_KEYS, maxChars: 1500, knowledge: false }),
});

// The diet an unknown lane eats. Same posture as the router's DEFAULT_LANE: a
// lane we do not recognize is treated as the broad language lane, which means
// no page context and no doc — the learner profile and nothing else.
export const DEFAULT_DIET = LANE_DIET.LANGUAGE_GENERAL;

/**
 * THE SHRINK LADDER. Each key is shaped at the widest rung that fits the
 * remaining budget; a key that will not fit even at the tightest rung is dropped
 * whole rather than half-serialized. Every rung is strictly smaller than the one
 * above it in every dimension, so the walk terminates and the result for a given
 * input is a single, reproducible choice of rung.
 */
export const SHRINK_LADDER = Object.freeze([
  Object.freeze({ maxItems: 8, maxStringChars: 400, maxKeys: 24, maxDepth: 4 }),
  Object.freeze({ maxItems: 4, maxStringChars: 240, maxKeys: 16, maxDepth: 4 }),
  Object.freeze({ maxItems: 2, maxStringChars: 160, maxKeys: 12, maxDepth: 3 }),
  Object.freeze({ maxItems: 1, maxStringChars: 100, maxKeys: 8, maxDepth: 2 }),
]);

// How many cut-notes ride along. The note is a hint to the model, not an audit
// log; six lines is plenty and the rest is honestly summarized as "…".
const MAX_NOTE_PARTS = 6;

const isPlainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Bound one value to a rung of the ladder.
 *
 * Nulls are KEPT rather than pruned: in the aggregates a null means "not enough
 * history to say", which is exactly the thing the coach must not turn into a
 * zero. The frontend already dropped the keys it could not fill; what is left is
 * meaningful, including its holes.
 *
 * @param {*} value       whatever the client sent under this key
 * @param {object} rung   one entry of SHRINK_LADDER
 * @param {number} depth  current nesting depth
 * @param {string} path   dotted path, used only for the cut notes
 * @param {string[]} cuts out-param: human-readable notes about what was trimmed
 */
export function shapeValue(value, rung, depth = 0, path = "", cuts = []) {
  if (value === null || value === undefined) return null;

  const t = typeof value;
  if (t === "string") {
    if (value.length <= rung.maxStringChars) return value;
    // Only a top-level string earns a note. Clipping the prose inside a nested
    // record is routine and would crowd the note out with noise; losing a whole
    // key, or half a list, is what the model actually needs to be told about.
    if (depth === 0) cuts.push(`${path}: text shortened`);
    return `${value.slice(0, rung.maxStringChars)}…`;
  }
  if (t === "number") return Number.isFinite(value) ? value : null;
  if (t === "boolean") return value;
  if (t !== "object") return null; // functions/symbols cannot arrive over JSON

  if (depth >= rung.maxDepth) {
    cuts.push(`${path || "context"}: deeper detail omitted`);
    return "…";
  }

  if (Array.isArray(value)) {
    if (value.length > rung.maxItems) {
      cuts.push(`${path}: showing ${rung.maxItems} of ${value.length}`);
    }
    return value
      .slice(0, rung.maxItems)
      .map((v, i) => shapeValue(v, rung, depth + 1, `${path}[${i}]`, cuts));
  }

  const entries = Object.entries(value);
  if (entries.length > rung.maxKeys) {
    cuts.push(`${path}: showing ${rung.maxKeys} of ${entries.length} fields`);
  }
  const out = {};
  for (const [k, v] of entries.slice(0, rung.maxKeys)) {
    out[k] = shapeValue(v, rung, depth + 1, path ? `${path}.${k}` : k, cuts);
  }
  return out;
}

// The serialized cost of adding one key to the block: the value, the quoted key,
// the colon and the separators. Measured rather than estimated, and deliberately
// one byte per key HIGH, so that the sum of the measures is always at least the
// length of the final JSON.stringify — the budget is a real ceiling, not an
// approximate one.
function measure(key, shaped) {
  let body;
  try {
    body = JSON.stringify(shaped);
  } catch {
    return Infinity; // circular / unserializable: treat as unaffordable, drop it
  }
  return (body == null ? 4 : body.length) + key.length + 5;
}

// Drops first, always. A key that vanished entirely is the note the coach most
// needs — it is the difference between "I only see eight" and "there are only
// eight" — so it can never be crowded out by the routine trims behind it.
function buildNote(drops, cuts) {
  const seen = [];
  for (const c of [...drops, ...cuts]) if (c && !seen.includes(c)) seen.push(c);
  if (!seen.length) return "";
  const head = seen.slice(0, MAX_NOTE_PARTS).join("; ");
  return seen.length > MAX_NOTE_PARTS ? `${head}; …` : head;
}

/**
 * THE ONE ENTRY POINT. Turn the client's `context` into the block the answering
 * call may see, for this lane, within this lane's budget.
 *
 * @param {object}  args
 * @param {string}  args.lane     the EFFECTIVE lane (after demotion / the floor)
 * @param {object}  args.context  the client's context slice, or null/absent
 * @returns {{
 *   context: object|null,
 *   note: string,
 *   stats: {
 *     present: boolean, offered: number, kept: string[], dropped: string[],
 *     skipped: number, chars: number, budget: number, truncated: boolean
 *   }
 * }}
 */
export function selectContext({ lane, context } = {}) {
  const diet = LANE_DIET[lane] || DEFAULT_DIET;
  const src = isPlainObject(context) ? context : null;
  const offeredKeys = src ? Object.keys(src) : [];

  const stats = {
    present: offeredKeys.length > 0,
    offered: offeredKeys.length,
    kept: [],
    dropped: [],
    skipped: 0,
    chars: 0,
    budget: diet.maxChars,
    truncated: false,
  };

  // Lanes on a zero budget (NAV_HELP, CREATOR_INFO, LANGUAGE_GENERAL) never even
  // look: whatever the page sent, none of it reaches the expensive call.
  if (!stats.present || !diet.keys.length || diet.maxChars <= 0) {
    stats.skipped = offeredKeys.length;
    return { context: null, note: "", stats };
  }

  const allowed = new Set(diet.keys);
  stats.skipped = offeredKeys.filter((k) => !allowed.has(k)).length;

  const out = {};
  const cuts = [];
  const drops = [];
  let remaining = diet.maxChars;

  for (const key of diet.keys) {
    if (!Object.prototype.hasOwnProperty.call(src, key)) continue;

    let placed = false;
    for (let rungIndex = 0; rungIndex < SHRINK_LADDER.length; rungIndex++) {
      const keyCuts = [];
      const shaped = shapeValue(src[key], SHRINK_LADDER[rungIndex], 0, key, keyCuts);
      const size = measure(key, shaped);
      if (size > remaining) continue;

      out[key] = shaped;
      remaining -= size;
      cuts.push(...keyCuts);
      if (rungIndex > 0 || keyCuts.length) stats.truncated = true;
      stats.kept.push(key);
      placed = true;
      break;
    }

    if (!placed) {
      stats.dropped.push(key);
      drops.push(`${key}: omitted (too large)`);
      stats.truncated = true;
    }
  }

  stats.chars = diet.maxChars - remaining;
  const kept = stats.kept.length ? out : null;
  return { context: kept, note: kept ? buildNote(drops, cuts) : "", stats };
}

/** Does this lane get the knowledge doc? Policy lives here; the read does not. */
export function laneWantsKnowledge(lane) {
  return !!(LANE_DIET[lane] || DEFAULT_DIET).knowledge;
}

export default selectContext;
