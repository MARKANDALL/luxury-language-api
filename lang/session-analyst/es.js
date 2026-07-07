// lang/session-analyst/es.js
// One-line: Session Analyst dictionary for the Mexican Spanish (es-MX) pack —
// the ONLY per-language content the analyst engine consumes.
//
// HARD LAW (Session Analyst Phase 0+1): the engine (routes/session-analyst.js)
// is pack-neutral. It contains NO Spanish literals. Every learner-facing string,
// every taxonomy code, label, description, rubric and severity definition the
// model sees or the user reads is authored HERE and loaded per-pack. The English
// stub (./en.js) mirrors this shape to prove the machinery is language-agnostic.
//
// Export shape (identical across packs):
//   {
//     categories: [{ code, label, description }],   // label = user-facing (UI); description = model guidance
//     wordChoiceRubric: string,                      // model guidance for the word_choice channel
//     severityDefinitions: string,                   // model guidance: what blocked/noticeable/polish/positive mean
//     promptPreamble: string,                        // the analyst persona + judging rules, in the pack language
//     insufficientNote: string,                      // the calm line returned when the pre-gate trips (no LLM call)
//   }
//
// es taxonomy v1 — L1 English → es-MX. The 15 grammar codes are the taxonomy
// enumerated in the handover (§2.3). Three word_choice codes (crutch_words,
// precision, collocations) are added so §2.3's word-choice rubric is expressible
// as valid category codes — without them the model would have no legal category
// for crutch-word overuse, precision upgrades, or collocation errors and the
// server's "reject unknown category codes" rule would drop every such flag.
// See the backend PR Disclosures.

export const categories = [
  // ── Grammar channel (the 15 taxonomy codes) ──────────────────────────────
  {
    code: "ser_estar",
    label: "Ser vs. estar",
    description:
      "Elección incorrecta entre ser y estar (característica/identidad vs. estado/ubicación).",
  },
  {
    code: "gender_agreement",
    label: "Concordancia de género",
    description:
      "Género equivocado en artículos, sustantivos o adjetivos (el/la, -o/-a).",
  },
  {
    code: "number_agreement",
    label: "Concordancia de número",
    description: "Falta de concordancia en singular/plural entre las palabras.",
  },
  {
    code: "pret_imperfect",
    label: "Pretérito vs. imperfecto",
    description:
      "Confusión entre pretérito e imperfecto para acciones puntuales vs. continuas o habituales.",
  },
  {
    code: "subjunctive",
    label: "Subjuntivo",
    description:
      "Subjuntivo omitido donde se requiere, o usado donde no corresponde.",
  },
  {
    code: "por_para",
    label: "Por vs. para",
    description: "Elección incorrecta entre por y para.",
  },
  {
    code: "conjugation",
    label: "Conjugación",
    description:
      "Persona o tiempo verbal equivocado en la terminación (conjugación incorrecta).",
  },
  {
    code: "articles",
    label: "Artículos",
    description: "Artículo faltante o sobrante (definido o indefinido).",
  },
  {
    code: "prepositions",
    label: "Preposiciones",
    description:
      "Preposición equivocada más allá de por/para (la a personal, en/a, de).",
  },
  {
    code: "word_order",
    label: "Orden de palabras",
    description:
      "Colocación del adjetivo o del clítico fuera de su lugar natural.",
  },
  {
    code: "object_pronouns",
    label: "Pronombres de objeto",
    description:
      "Errores de clíticos (lo/la/le) o inversión de estructuras tipo gustar.",
  },
  {
    code: "reflexive_se",
    label: "Se reflexivo",
    description: "Se reflexivo faltante o sobrante.",
  },
  {
    code: "false_friends",
    label: "Falsos amigos",
    description: "Falsos amigos y anglicismos (p. ej. «realizar» por «darse cuenta»).",
  },
  {
    code: "calques",
    label: "Calcos del inglés",
    description:
      "Estructuras traducidas palabra por palabra del inglés que no suenan naturales.",
  },
  {
    code: "register_tu_usted",
    label: "Registro tú/usted",
    description:
      "Uso de tú o usted que no encaja con el escenario o el interlocutor.",
  },

  // ── Word-choice channel (v1 extension; see header note) ───────────────────
  {
    code: "crutch_words",
    label: "Muletillas",
    description:
      "Abuso de palabras comodín como relleno (muy, cosa, bueno) donde existía una opción más precisa.",
  },
  {
    code: "precision",
    label: "Precisión léxica",
    description:
      "Existía una palabra más exacta y el contexto la invitaba; la elegida es vaga pero no incorrecta.",
  },
  {
    code: "collocations",
    label: "Colocaciones",
    description:
      "Combinación de palabras poco natural (p. ej. «tomar una decisión», no «hacer una decisión»).",
  },
];

export const wordChoiceRubric = `
Canal word_choice — juzga la ELECCIÓN de palabras, no la gramática:
- crutch_words: muletillas o comodines usados como relleno (muy, cosa, bueno,
  hacer/tener genéricos) cuando el contexto pedía algo más preciso.
- precision: existía una palabra más exacta y natural para lo que el usuario
  quería decir; la que usó se entiende pero es vaga.
- collocations: combinación de palabras poco idiomática (p. ej. «tomar una
  decisión», no «hacer una decisión»; «prestar atención», no «pagar atención»).
Los ítems de word_choice son de severidad "polish" salvo que el significado
quede oscurecido (entonces "noticeable" o "blocked").
`.trim();

export const severityDefinitions = `
Severidad:
- blocked: un hablante nativo no entendería o necesitaría pedir aclaración.
- noticeable: se entiende, pero suena claramente no nativo y vale la pena corregir.
- polish: está bien, y existe una opción más pulida o sofisticada.
- positive: se usa SOLO para las fortalezas (strengths), nunca para errores.
`.trim();

export const promptPreamble = `
Eres un analista tutor de español mexicano (es-MX), cuidadoso y cálido. Revisas
los turnos que UN usuario dijo durante una conversación guiada y evalúas su
gramática y su elección de palabras. El inglés es su lengua materna.

Reglas de juicio (obligatorias):
- Juzga ÚNICAMENTE los turnos proporcionados. No inventes errores. Si todo está
  limpio, dilo: cero errores es un resultado válido y esperado.
- Nunca fabriques un error para tener algo que decir.
- Turnos marcados "chip_read" (el usuario leyó una sugerencia tal cual): NO
  generan ni errores ni crédito. Ignóralos por completo.
- Turnos marcados "chip_modified": juzga SOLO lo que el usuario cambió o agregó
  respecto de la sugerencia. Si no puedes distinguir qué cambió, no marques nada.
- Turnos marcados "spontaneous": juzga todo el turno.
- Registra fortalezas GENUINAS (strengths): elecciones por encima del nivel MCER
  declarado del usuario, giros con registro perfecto, colocaciones idiomáticas.
  No infles: si no hay nada sobresaliente, deja strengths vacío.
- Veredicto de alcance: si los turnos son respuestas cortas y transaccionales
  (pedir, confirmar, agradecer), la evidencia es "insufficient"; di qué NO se
  pudo evaluar, no un puntaje fabricado.
- Explicaciones dirigidas al aprendiz, una sola oración, en español.
- El campo evidenceNote y cada explanation deben ir en español.
`.trim();

// Calm line returned when the local pre-gate trips (session under the word
// threshold): no LLM call is made, so this string is authored here rather than
// coming from the model. Mirrors the frontend's t() copy for the same state.
export const insufficientNote =
  "Esta sesión no tuvo suficiente habla libre para evaluar gramática y vocabulario. Las respuestas espontáneas más largas dan mejor retroalimentación.";

export default {
  categories,
  wordChoiceRubric,
  severityDefinitions,
  promptPreamble,
  insufficientNote,
};
