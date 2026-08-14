// lib/emotion.js
// Emotion driver, stage 1 — a per-turn, machine-readable signal of what the
// character is visibly showing, carried ALONGSIDE the dialogue and never inside
// it. The character model picks the name and the strength; this module owns the
// allowed vocabulary, the prompt block that asks for it, and the parse-time
// validation that guarantees a well-formed field on every reply object so the
// frontend never has to guess.
//
// Mirrors lib/hearing.js: constants + pure functions, no I/O, unit-testable.

/** The complete allowed vocabulary. Fixed lowercase machine tokens — these are
 *  never translated, never localized, never extended by the model. */
export const EMOTION_NAMES = [
  "neutral",
  "friendly",
  "delighted",
  "attentive",
  "curious",
  "surprised",
  "confused",
  "concerned",
  "playful",
  "impatient",
  "cold",
  "angry",
  "emotional",
];

const ALLOWED = new Set(EMOTION_NAMES);

/** Fresh neutral signal. A factory, not a shared frozen object, so a consumer
 *  mutating one reply's emotion can never bleed into another's. */
export function neutralEmotion() {
  return { name: "neutral", level: null };
}

/**
 * Validate whatever the model returned in `json.emotion` into the guaranteed
 * shape `{ name, level }`.
 *
 * Anything that is not an allowed name at a legal strength collapses to
 * neutral — unknown/missing/misspelled name, missing level on a non-neutral
 * name, level outside 1..3, non-integer level, wrong type, absent field.
 * neutral itself never carries a level.
 *
 * @param {unknown} raw
 * @returns {{name: string, level: 1|2|3|null}}
 */
export function normalizeEmotion(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return neutralEmotion();

  const name = String(raw.name ?? "").trim().toLowerCase();
  if (!ALLOWED.has(name)) return neutralEmotion();
  if (name === "neutral") return neutralEmotion();

  // Numbers, and numeric strings because models emit "2" as often as 2. Nothing
  // else — an array or a boolean must not coerce its way into a valid level.
  const level =
    typeof raw.level === "number" ? raw.level
    : typeof raw.level === "string" ? Number(raw.level.trim())
    : NaN;
  if (!Number.isInteger(level) || level < 1 || level > 3) return neutralEmotion();

  return { name, level };
}

/** The `emotion` key as it appears in the route's OUTPUT schema line. Built from
 *  EMOTION_NAMES so the prompt and the validator can never drift apart. */
export const EMOTION_OUTPUT_SCHEMA =
  `"emotion":{"name":"${EMOTION_NAMES.join("|")}","level":1|2|3|null}`;

/* ── Prompt block: asked of the character model on every turn ──
   Injected into buildSystemPrompt just above the OUTPUT line. The character is
   given a thing to feel, not a taxonomy to classify — and a hard ban on letting
   any of it reach the spoken line. */
export const EMOTION_BLOCK = `EMOTION SIGNAL (machine-readable data — never spoken):
Along with your dialogue you MUST return an "emotion" object describing what your character is visibly showing on THIS turn.

- Choose the emotion your character would genuinely show in reaction to the learner's last utterance and to what is happening in the scene. Not what the scene ought to feel like — what actually registers on your character's face right now.
- The active tone settings bias this choice; they do not dictate it. A cold character can still be surprised. A friendly one can still go concerned.
- Default to neutral. Most turns are neutral — nothing in particular registered, and that is the honest answer.
- "level" is how strongly it shows: 1 = barely readable, 2 = clearly readable, 3 = unmistakable. Reserve 3 for genuinely strong moments; it should be rare.
- neutral carries NO level. When "name" is "neutral", "level" MUST be null.
- Allowed names — exactly these, no others, no synonyms, no invented names:
  ${EMOTION_NAMES.join(", ")}
- These are fixed machine tokens. Always write the name in lowercase English exactly as listed, even when the conversation is in another language. Never translate it.
- ABSOLUTE — this is data, never speech: never name, label, spell out, or read aloud the emotion or its level anywhere in "assistant", "narration", "imageDirection", or "suggested_replies". No "(curious)", no "emotion: concerned", no "Level 2", no prefix or aside of any kind. Your dialogue must read exactly as it would have if this field did not exist. Narration and imageDirection go on describing the scene exactly as instructed above — they simply never expose this field's value as a label.`;
