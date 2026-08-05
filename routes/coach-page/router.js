// routes/coach-page/router.js
// THE COACH ROUTER — the Lux AI Coach's traffic controller (Coach Program v1.0,
// companion to LUX_COACH_CHARTER_v1). This is the January four-lane intent
// classifier, finished.
//
// One cheap pass, two jobs: SCOPE GATE and TRAFFIC CONTROL.
//   - scope gate:     an OFF_SCOPE verdict short-circuits before the expensive
//                     main call. That IS protection layer 2, the cost gate.
//   - traffic control: every other verdict names the lane the main call answers
//                     in, and (for ROUTE_TO_PAGE) the page that should really
//                     take the question, plus the question to carry there.
//
// It is a PRE-PASS FUNCTION, not an endpoint: routes/coach-page.js calls
// `classify()` on the quick model, then either short-circuits or proceeds to the
// main call with the lane attached — one client round trip, two model calls at
// most, and only one when the answer is a canned off-scope redirect.
//
// This module is deliberately dependency-free: the caller passes in an `openai`
// client, a `jsonrepair` function and the model id (the house
// LUX_AI_QUICK_MODEL -> LUX_AI_MODEL -> gpt-4.1-mini chain lives in the route),
// so the classifier can be unit-tested with no network and no env.
//
// DEVIATION FROM THE SPEC, DELIBERATE AND SMALL: the charter's system prompt is
// reproduced verbatim as SYSTEM_PROMPT_BASE, and `buildSystemPrompt()` appends
// ONE extra block — the PAGES registry. Rule 3 ("route only when the destination
// truly has tools or data this page lacks") is not executable unless the model
// knows which destinations exist, and `route_target` is validated against that
// same registry on the way out, so a hallucinated target can never reach the UI
// as a dead deep link. The page one-liners are placeholders in the charter's
// voice; the charter owns their final copy. Everything else — lanes, rules,
// examples, output shape — is the spec, unedited.

// ── The seven lanes ─────────────────────────────────────────────────────────
export const LANES = Object.freeze([
  "EXPLAIN",
  "NAV_HELP",
  "PATTERNS",
  "CREATOR_INFO",
  "LANGUAGE_GENERAL",
  "ROUTE_TO_PAGE",
  "OFF_SCOPE",
]);
export const LANE_SET = new Set(LANES);

// The in-scope lane everything falls back to. Rule 4: ties go to the learner, so
// the fallback is always an in-scope lane and never OFF_SCOPE.
export const DEFAULT_LANE = "LANGUAGE_GENERAL";

// ── The page registry (charter keys) ────────────────────────────────────────
// The valid `route_target` values, and the destinations shown to the classifier.
// Add a page here and it becomes routable in the same edit — the prompt block
// and the output validation both read this one constant.
//
// EACH PAGE NOW CARRIES A HUMAN NAME, and that is not decoration. A coach once
// told a learner to "go to guidedChat" — a charter key, an internal identifier,
// a thing that appears nowhere in the app the learner is looking at. The key is
// the classifier's vocabulary and the route chip's vocabulary; it is never the
// learner's. So the registry holds both: the key the machinery routes on, and
// the name a person is allowed to hear, in en and es-MX (Law 10).
export const PAGES = Object.freeze({
  practiceSkills: Object.freeze({
    name: Object.freeze({ en: "Practice Skills", "es-MX": "Práctica de pronunciación" }),
    blurb: "record a phrase and get pronunciation scores, per-sound detail, and drills",
  }),
  picker: Object.freeze({
    name: Object.freeze({ en: "Conversation Picker", "es-MX": "Selector de conversaciones" }),
    blurb: "choose a conversation scenario, character, and language pack",
  }),
  guidedChat: Object.freeze({
    name: Object.freeze({ en: "Guided Chat", "es-MX": "Conversación guiada" }),
    blurb: "the guided AI conversation itself — chat bubbles, replies, and in-line feedback",
  }),
  myWords: Object.freeze({
    name: Object.freeze({ en: "My Words", "es-MX": "Mis palabras" }),
    blurb: "the learner's saved words and word cards",
  }),
  allData: Object.freeze({
    name: Object.freeze({ en: "All Data", "es-MX": "Todos los datos" }),
    blurb: "the full progress dashboard — history, charts, and change over time",
  }),
  journey: Object.freeze({
    name: Object.freeze({ en: "The Journey", "es-MX": "El recorrido" }),
    blurb: "the guided tour of how speech and the mouth work",
  }),
});
export const PAGE_SET = new Set(Object.keys(PAGES));

// The UI language ("en" | "es") to the locale the names are written in. es-MX
// with tuteo is the house Spanish everywhere else in Lux; the coach is no
// exception.
export const PAGE_NAME_LOCALES = Object.freeze({ en: "en", es: "es-MX" });

// Tolerant read: an entry may still be a bare blurb string (that is what the
// registry was before names landed), and a caller may hold a page key that no
// longer exists.
const pageEntry = (pageId) => {
  const row = PAGES[String(pageId || "")];
  if (!row) return null;
  return typeof row === "string" ? { name: null, blurb: row } : row;
};

/**
 * The name a learner may hear for a page, or "" when there is none. An empty
 * string is the honest answer for an unknown page and the callers treat it as
 * "do not name this page at all" — better a nameless page than a leaked key.
 *
 * @param {string} pageId charter key
 * @param {string} lang   "en" | "es"
 */
export function pageName(pageId, lang = "en") {
  const entry = pageEntry(pageId);
  if (!entry?.name) return "";
  const locale = PAGE_NAME_LOCALES[lang === "es" ? "es" : "en"];
  return entry.name[locale] || entry.name.en || "";
}

/** The one-line description of a page, or "". */
export function pageBlurb(pageId) {
  return pageEntry(pageId)?.blurb || "";
}

/**
 * THE MAP THE ANSWERING MODEL SEES. Human names only — no charter keys, no
 * hrefs, no file names — so there is nothing in front of it to copy that a
 * learner would not recognize. (The classifier's map, built by
 * buildSystemPrompt below, is the opposite: it is keys, because keys are what
 * route_target is validated against.)
 *
 * @param {string} lang "en" | "es"
 */
export function luxMap(lang = "en") {
  return Object.keys(PAGES)
    .map((key) => {
      const name = pageName(key, lang);
      return name ? `- ${name}: ${pageBlurb(key)}` : "";
    })
    .filter(Boolean)
    .join("\n");
}

// Under this, the lane is advisory only (see normalizeClassification). The
// Khanmigo lesson: over-tightening hurts more than the occasional tangent.
export const CONFIDENCE_FLOOR = 0.5;

// Cheap, deterministic, and small — this pass classifies, it never writes prose.
export const ROUTER_TEMPERATURE = 0;
export const ROUTER_MAX_TOKENS = 160;
export const ROUTER_TIMEOUT_MS = 8000;

// ── OFF_SCOPE redirects (canned, never hit the big model) ───────────────────
// First off-scope ask of the session gets the CONVERSION (Law 6): refuse the
// question, offer the language version of it. Every one after that gets the
// PLAIN redirect. The client tracks whether the conversion was already spent
// this session; the server just picks by the boolean in the payload.
export const OFF_SCOPE_REPLIES = Object.freeze({
  conversion: Object.freeze({
    en: "I can't help with that one, but I can show you how to say it in the language you're learning. Want that instead?",
    es: "Con eso no te puedo ayudar, pero sí te puedo enseñar a decirlo en el idioma que estás aprendiendo. ¿Le entramos?",
  }),
  plain: Object.freeze({
    en: "I'm here for language, speaking, and everything in Lux. Ask me anything in that world.",
    es: "Estoy aquí para el idioma, el habla y todo lo que hay en Lux. Pregúntame lo que sea de ese mundo.",
  }),
});

/**
 * Pick the canned off-scope reply. Never calls a model.
 * @returns {{ kind: "conversion"|"plain", text: string }}
 */
export function offScopeReply({ lang = "en", conversionUsed = false } = {}) {
  const kind = conversionUsed ? "plain" : "conversion";
  const l = lang === "es" ? "es" : "en";
  return { kind, text: OFF_SCOPE_REPLIES[kind][l] };
}

// ── The system prompt (verbatim from the charter) ───────────────────────────
export const SYSTEM_PROMPT_BASE = `
You are the traffic controller for the Lux AI Coach. You never answer the user.
You classify each message and return strict JSON, nothing else.

YOU RECEIVE
- pageId: where the user is in Lux
- anchor: what they selected or asked from (type and text), or null
- message: what they typed or the chip they clicked
- learner: level, first language, top pattern flags
- recent: the last few coach exchanges across all pages

LANES
- EXPLAIN: the message is about the anchor or something visible on this page
  (an attempt, a selection, a chart cell, a setting, a scenario).
- NAV_HELP: how Lux works, where a tool lives, what a feature does.
- PATTERNS: the learner's own history, habits, progress, recurring errors.
- CREATOR_INFO: about Mark, or about why Lux is built the way it is.
- LANGUAGE_GENERAL: any language, communication, pronunciation, or culture
  question with no page anchor. This lane is broad on purpose: Lux wants to
  be the one place for every language question.
- ROUTE_TO_PAGE: in scope, but a different page has the data or tools to
  answer it properly. Set route_target and route_question.
- OFF_SCOPE: no reasonable connection to language, communication,
  culture that serves language, or Lux itself.

RULES
1. Culture, history, travel, professional situations, and real-world
   knowledge are IN SCOPE when they serve language or communication.
   "How do people greet each other in Mexico" is in scope.
   "What is the weather in Kenya" is not.
2. Anchor beats everything. With an anchor present, prefer EXPLAIN unless
   the message clearly ignores it.
3. Route only when the destination truly has tools or data this page lacks.
   When routing, write route_question as the question the destination coach
   should answer, in the user's own words.
4. When torn between OFF_SCOPE and any in-scope lane, choose the in-scope
   lane. Ties go to the learner.
5. Return JSON only:
   {"lane": "...", "in_scope": true, "route_target": "", "route_question": "", "confidence": 0.0}
   route_target and route_question stay empty unless lane is ROUTE_TO_PAGE.

EXAMPLES
pageId practiceSkills · anchor phoneme "/r/" · "why is this one red"
→ {"lane":"EXPLAIN","in_scope":true,"route_target":"","route_question":"","confidence":0.97}

pageId picker · no anchor · "¿'vamos a por ello' es normal fuera de España?"
→ {"lane":"LANGUAGE_GENERAL","in_scope":true,"route_target":"","route_question":"","confidence":0.95}

pageId picker · no anchor · "what's the weather in Kenya right now"
→ {"lane":"OFF_SCOPE","in_scope":false,"route_target":"","route_question":"","confidence":0.98}

pageId myWords · no anchor · "how has my r sound changed over the last month"
→ {"lane":"ROUTE_TO_PAGE","in_scope":true,"route_target":"allData","route_question":"How has my /r/ sound changed over the last month?","confidence":0.9}

pageId journey · no anchor · "who made this app and why"
→ {"lane":"CREATOR_INFO","in_scope":true,"route_target":"","route_question":"","confidence":0.93}

pageId allData · no anchor · "where's the minimal pairs practice"
→ {"lane":"NAV_HELP","in_scope":true,"route_target":"","route_question":"","confidence":0.92}

pageId guidedChat · anchor bubble "No manches, ¿en serio?" · "why did she say it like that"
→ {"lane":"EXPLAIN","in_scope":true,"route_target":"","route_question":"","confidence":0.96}

pageId practiceSkills · no anchor · "do I always mess up the th sound"
→ {"lane":"PATTERNS","in_scope":true,"route_target":"","route_question":"","confidence":0.94}

pageId guidedChat · no anchor · "how much do people tip at restaurants in Mexico"
→ {"lane":"LANGUAGE_GENERAL","in_scope":true,"route_target":"","route_question":"","confidence":0.85}
`.trim();

/**
 * The charter prompt plus the PAGES block (see the deviation note at the top).
 */
export function buildSystemPrompt(pages = PAGES) {
  const lines = Object.entries(pages)
    .map(([key, row]) => `- ${key}: ${typeof row === "string" ? row : row?.blurb || ""}`)
    .join("\n");
  return `${SYSTEM_PROMPT_BASE}

PAGES (the only valid route_target values)
${lines}`;
}

// Built once per process — the prompt is a constant, and this runs on every ask.
let _defaultSystemPrompt = null;
function defaultSystemPrompt() {
  if (!_defaultSystemPrompt) _defaultSystemPrompt = buildSystemPrompt();
  return _defaultSystemPrompt;
}

// ── Input shaping ───────────────────────────────────────────────────────────
const cap = (v, n) => (v == null ? "" : String(v)).trim().slice(0, n);

/**
 * The user message the classifier sees. Mirrors the "YOU RECEIVE" block key for
 * key — `logTail` (the last ~5 coach_log rows, all pages) is carried as `recent`
 * because that is what the prompt calls it.
 */
export function buildRouterUser({ pageId, anchor, message, learner, recent } = {}) {
  return {
    pageId: cap(pageId, 40),
    anchor: anchor && (anchor.type || anchor.text)
      ? { type: cap(anchor.type, 40), text: cap(anchor.text, 600) }
      : null,
    message: cap(message, 1000),
    learner: {
      level: cap(learner?.level, 8),
      l1: cap(learner?.l1, 24),
      flags: Array.isArray(learner?.flags)
        ? learner.flags.map((f) => cap(f, 60)).filter(Boolean).slice(0, 8)
        : [],
    },
    recent: Array.isArray(recent) ? recent.slice(0, 5) : [],
  };
}

// ── Output shaping ──────────────────────────────────────────────────────────
function clamp01(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

/**
 * Turn whatever the model returned into the lane the main call can act on.
 *
 * Two kinds of correction happen here, and they are kept separate on purpose:
 *
 *  DEMOTION — the verdict was structurally unusable: an unknown lane, or a
 *  ROUTE_TO_PAGE with no target / an unknown target / a target that is the page
 *  the learner is already on (routing to yourself is not routing). The lane
 *  falls back to the LOCAL lane, which honours Rule 2: with an anchor present,
 *  that is EXPLAIN; otherwise LANGUAGE_GENERAL.
 *
 *  ADVISORY — the verdict was well-formed but under CONFIDENCE_FLOOR. The
 *  charter is literal about this one: "treat the lane as advisory and let the
 *  main call proceed as LANGUAGE_GENERAL". Low confidence is NOT a refusal, so
 *  an unsure OFF_SCOPE does not short-circuit — the learner gets a real answer.
 *
 * `raw_lane` survives both so coach_log records what the classifier actually
 * said, not just what we did with it.
 *
 * @returns {{lane:string,in_scope:boolean,route_target:string,route_question:string,
 *            confidence:number,advisory:boolean,raw_lane:string,demoted:string}}
 */
export function normalizeClassification(raw, { pageId = "", hasAnchor = false, message = "" } = {}) {
  const rawLane = cap(raw?.lane, 40).toUpperCase();
  const localLane = hasAnchor ? "EXPLAIN" : DEFAULT_LANE;

  let lane = LANE_SET.has(rawLane) ? rawLane : localLane;
  let demoted = LANE_SET.has(rawLane) ? "" : "unknown_lane";

  const confidence = clamp01(raw?.confidence);
  let route_target = cap(raw?.route_target, 40);
  let route_question = cap(raw?.route_question, 400);

  if (lane === "ROUTE_TO_PAGE") {
    if (!route_target) demoted = "missing_target";
    else if (!PAGE_SET.has(route_target)) demoted = "unknown_target";
    else if (route_target === cap(pageId, 40)) demoted = "self_route";
    if (demoted) lane = localLane;
  }

  // Under the floor the lane is advisory: proceed as LANGUAGE_GENERAL, drop any
  // route, and never refuse.
  const advisory = confidence < CONFIDENCE_FLOOR;
  if (advisory) lane = DEFAULT_LANE;

  if (lane !== "ROUTE_TO_PAGE") {
    route_target = "";
    route_question = "";
  } else if (!route_question) {
    // Rule 3 wants the question in the user's own words; if the model routed
    // without writing one, the destination coach still needs something to
    // answer, so fall back to the learner's own message.
    route_question = cap(message, 400);
  }

  return {
    lane,
    in_scope: lane !== "OFF_SCOPE",
    route_target,
    route_question,
    confidence,
    advisory,
    raw_lane: rawLane || "",
    demoted,
  };
}

/**
 * The deep link the UI puts behind the route chip. The router only supplies the
 * destination and the question; the destination page owns its own URL.
 */
export function routeDeepLink({ route_question, pageId } = {}) {
  return `?coachq=${encodeURIComponent(route_question || "")}&from=${encodeURIComponent(pageId || "")}`;
}

/**
 * THE PRE-PASS. One cheap call, strict JSON out, and a fail-open guarantee: if
 * the quick model errors, times out, or returns something unparseable, the
 * learner still gets an answer — confidence 0 makes the verdict advisory, which
 * lands on LANGUAGE_GENERAL. A gate that breaks must break open; the router is
 * a cost control, not a wall.
 *
 * @param {object} input  { pageId, anchor, message, learner, recent }
 * @param {object} deps   { openai, model, jsonrepair, timeoutMs, systemPrompt }
 */
export async function classify(input, deps) {
  const { openai, model, jsonrepair, timeoutMs = ROUTER_TIMEOUT_MS, systemPrompt } = deps || {};
  const user = buildRouterUser(input);
  const hasAnchor = !!user.anchor;
  const ctx = { pageId: user.pageId, hasAnchor, message: user.message };

  let raw = "";
  try {
    const resp = await openai.chat.completions.create(
      {
        model,
        temperature: ROUTER_TEMPERATURE,
        max_tokens: ROUTER_MAX_TOKENS,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt || defaultSystemPrompt() },
          { role: "user", content: JSON.stringify(user) },
        ],
      },
      { timeout: timeoutMs }
    );
    raw = resp?.choices?.[0]?.message?.content || "";
  } catch (e) {
    console.warn("[coach-router] classify call failed", e?.message || e);
    return { ...normalizeClassification({}, ctx), ok: false, error: "router_call_failed" };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw || "{}");
  } catch {
    try {
      parsed = JSON.parse(jsonrepair(raw));
    } catch (e) {
      console.warn("[coach-router] classify parse failed", e?.message || e);
      return { ...normalizeClassification({}, ctx), ok: false, error: "router_parse_failed" };
    }
  }

  return { ...normalizeClassification(parsed, ctx), ok: true, error: "" };
}

export default classify;
