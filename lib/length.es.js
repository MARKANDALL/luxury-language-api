// Spanish (es-MX) length presets for routes/convo-turn.js.
//
// The frontend is the source of truth for Spanish authoring. Thresholds here
// will be ~20% looser than English because Spanish runs longer on average.
// Until the final authored values land, every entry below is a TODO and the
// runtime falls back to the English defaults in routes/convo-turn.js so
// Spanish turns still function (just with English-sized caps and prompts).

// TODO(es-pack-content): replace each null with the final Spanish instruction
// block (same 5-pillar shape as the English LENGTH_INSTRUCTIONS).
export const LENGTH_INSTRUCTIONS_ES = {
  terse:    null,
  short:    null,
  medium:   null,
  long:     null,
  extended: null,
};

// TODO(es-pack-content): replace each null with Spanish numeric thresholds
// (e.g. { maxSentences: 1, maxWords: 8 }), loosened ~20% versus English.
export const LENGTH_OUTLIER_OPENING_ES = {
  terse:  null,
  short:  null,
  medium: null,
  long:   null,
};

export const LENGTH_OUTLIER_NORMAL_ES = {
  terse:  null,
  short:  null,
  medium: null,
  long:   null,
};

// TODO(es-pack-content): e.g. { maxSentences: 6, maxWords: 162 } once decided.
export const LENGTH_OUTLIER_EXTENDED_ES = null;

// TODO(es-pack-content): only fill if a Spanish CEFR block needs different
// length-relevant numbers (e.g. "under 8 words"). Otherwise leave null and
// the English LEVEL_INSTRUCTIONS will be used.
export const LEVEL_INSTRUCTIONS_ES = {
  A1: null,
  A2: null,
  B1: null,
  B2: null,
  C1: null,
  C2: null,
};
