// lang/session-analyst/en.js
// One-line: Session Analyst dictionary STUB for the English pack — a deliberately
// small (3-category) dictionary whose only job is to prove the engine
// (routes/session-analyst.js) is pack-neutral: the route must run end-to-end
// under pack:"en" using this file, with zero English literals in the engine.
//
// This is a v1 stub, NOT a finished English taxonomy. Authoring the full English
// dictionary is explicitly out of scope for Session Analyst Phase 0+1 (§6).
// It mirrors the export shape of ./es.js exactly.

export const categories = [
  {
    code: "subject_verb_agreement",
    label: "Subject–verb agreement",
    description: "The verb does not agree with its subject in person or number.",
  },
  {
    code: "articles",
    label: "Articles",
    description: "A missing, extra, or wrong article (a/an/the).",
  },
  {
    code: "collocations",
    label: "Collocations",
    description:
      "An unnatural word pairing (e.g. \"make a decision\", not \"do a decision\").",
  },
];

export const wordChoiceRubric = `
word_choice channel — judge word CHOICE, not grammar:
- collocations: an unnatural word pairing where a set phrase was expected.
word_choice items are "polish" severity unless meaning was obscured.
`.trim();

export const severityDefinitions = `
Severity:
- blocked: a native listener would misunderstand or need a repair.
- noticeable: understood, but clearly non-native and worth fixing.
- polish: fine, and a more sophisticated option exists.
- positive: used for strengths rows only, never for errors.
`.trim();

export const promptPreamble = `
You are a careful, warm English tutor analyst. You review the turns ONE user
said during a guided conversation and judge grammar and word choice.

Judging rules (mandatory):
- Judge ONLY the provided turns. Never invent errors. If everything is clean,
  say so: zero errors is a valid, expected result.
- "chip_read" turns produce NO flags and NO credit — ignore them entirely.
- "chip_modified" turns: judge only what the user changed or added.
- "spontaneous" turns: judge the whole turn.
- Log genuine strengths only; do not inflate.
- If the turns are short transactional responses, evidence is "insufficient".
- Explanations are learner-facing, one sentence.
`.trim();

export const insufficientNote =
  "This session did not have enough free speech to evaluate grammar and vocabulary. Longer spontaneous answers give better feedback.";

export default {
  categories,
  wordChoiceRubric,
  severityDefinitions,
  promptPreamble,
  insufficientNote,
};
