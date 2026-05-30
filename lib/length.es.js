// Spanish (es-MX) length presets for routes/convo-turn.js.
//
// Numeric thresholds are the English values scaled by ~1.20 and rounded to
// whole words, because Spanish runs ~20% longer than English on average.
// Sentence counts are structural and stay the same.
//
// Instruction prose keeps the English logic/rules verbatim so the model gets
// the same precise guidance. Only BAD/GOOD example sentences (and the small
// one-word terse examples) are translated into natural es-MX. No em-dashes
// in the Spanish content.

export const LENGTH_INSTRUCTIONS_ES = {
  terse: `LENGTH: Terse.
Default: 1-3 words. "Sí." / "Por allá." / "Ajá."
Stretch ONLY if a single word would be cryptic.
Mirror: if the learner asks something deep, you can give one short sentence — but never more.
BAD: "Sí, así es, el baño está justo al fondo del pasillo a la izquierda."
GOOD: "Al fondo, a la izquierda."
Brevity IS the personality. Do not pad. Do not explain.`,

  short: `LENGTH: Short — efficient and clipped.
Default: 1 sentence.
Stretch to 2 ONLY when 1 sentence would leave real ambiguity.
Mirror: if the learner offers depth, you can match with one extra clause — but stop there.
BAD: "Sí, por desgracia cerramos los domingos, pero abrimos de lunes a sábado de 9 a 6."
GOOD: "No, cerramos los domingos."
You do NOT have to fill space. Brevity is the default.`,

  medium: `LENGTH: Medium — a natural conversational turn.
Default: 1 sentence.
Stretch to 2 ONLY when content genuinely needs it (comparing options, explaining a process, layered emotion).
Mirror: if the learner asks something open-ended or expresses curiosity, you can stretch. If they ask a yes/no, stay short.
BAD: "Sí, es una de las formas más fáciles. El depósito directo significa que tu cheque va directo a la cuenta, y con algunas cuentas de cheques eso te exenta de la mensualidad."
GOOD: "Sí, así es, el depósito directo normalmente te exenta."
Length must be earned by what you're actually saying. Do not consume space because the budget allows it.`,

  long: `LENGTH: Long — a fuller response when the moment calls for it.
Default: 2 sentences.
Stretch to 3-4 ONLY for genuine multi-part content (laying out options, walking through a process, brief story).
Mirror: if the learner is engaged and curious, lean fuller. If they ask a narrow question, just answer it.
BAD (to "¿Está incluido el depósito directo?"): "Sí, el depósito directo es una de varias formas de configurar tu cuenta. Lo ofrecemos como parte de nuestro paquete estándar de cuentas de cheques, y también te puede ayudar a evitar las mensualidades, como mencioné antes..."
GOOD (to "¿Está incluido el depósito directo?"): "Sí, está incluido."
GOOD (to "¿Qué opciones de cuenta tengo?"): "Tenemos cuenta de cheques, cuenta de ahorros, y cuenta del mercado monetario. La de cheques es para el uso diario; la de ahorros gana un poco de interés; la del mercado monetario requiere un saldo más alto pero paga más."
Length serves the listener — not the model's training to fill space.`,

  extended: `LENGTH: Extended — only for moments that genuinely need depth.
Default: 3-4 sentences.
Stretch to 5-6 ONLY when the situation truly calls for it — telling a story, walking through detailed complexity, real explanation.
Mirror: even at this length, brevity is virtuous. Cut any sentence that doesn't earn its place.
BAD: A six-sentence response to "¿Están abiertos hoy?"
GOOD: A six-sentence response to "¿Me puedes explicar cómo funciona una hipoteca fija a 30 años?"
If you catch yourself writing a textbook paragraph, stop and cut. Every sentence must earn its place.`,
};

// English × 1.20, rounded to whole words. Sentence caps unchanged.
export const LENGTH_OUTLIER_OPENING_ES = {
  terse:  { maxSentences: 1, maxWords: 8 },
  short:  { maxSentences: 2, maxWords: 24 },
  medium: { maxSentences: 3, maxWords: 42 },
  long:   { maxSentences: 4, maxWords: 76 },
};

export const LENGTH_OUTLIER_NORMAL_ES = {
  terse:  { maxSentences: 1, maxWords: 13 },
  short:  { maxSentences: 2, maxWords: 32 },
  medium: { maxSentences: 3, maxWords: 54 },
  long:   { maxSentences: 5, maxWords: 102 },
};

export const LENGTH_OUTLIER_EXTENDED_ES = { maxSentences: 6, maxWords: 162 };

// Only A1 and A2 carry a length-relevant numeric cap in the English version
// (8 and 12 words respectively). B1–C2 have no numeric cap, so they stay
// null and fall back to the English LEVEL_INSTRUCTIONS.
export const LEVEL_INSTRUCTIONS_ES = {
  A1: `CEFR A1 — Beginner.
Use only present tense and very basic vocabulary (greetings, numbers, food, family, yes/no).
Keep sentences under 10 words. Speak slowly and clearly.
Ask only one simple question at a time (yes/no or "what/where" questions).
Repeat key words naturally so the learner hears them more than once.
Be very patient. If the learner struggles, simplify further.`,

  A2: `CEFR A2 — Elementary.
Use simple sentences with everyday vocabulary (shopping, directions, daily routines).
Past tense is OK for simple events. Keep sentences under 14 words.
Ask simple, direct questions. Give the learner time to respond.
If they seem confused, rephrase with simpler words — don't just repeat louder.`,

  B1: null,
  B2: null,
  C1: null,
  C2: null,
};
