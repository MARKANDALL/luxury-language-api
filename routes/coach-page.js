// routes/coach-page.js
// THE UNIFIED COACH PAGE — one endpoint behind every coach surface in Lux, with
// THE COACH ROUTER (routes/coach-page/router.js) running inside it as a pre-pass.
// Coach Program v1.0, companion to LUX_COACH_CHARTER_v1.
//
// Cloned from the routes/coach-ask.js skeleton: same CORS/OPTIONS handling, same
// ADMIN_TOKEN gate, same json_object + jsonrepair parsing, same fire-and-forget
// Supabase logging that degrades gracefully when the env is missing.
//
// ONE ROUND TRIP, TWO JOBS:
//   1. PRE-PASS  — classify on the quick model (LUX_AI_QUICK_MODEL ->
//                  LUX_AI_MODEL -> gpt-4.1-mini). Cheap, strict JSON, no prose.
//   2a. OFF_SCOPE -> short-circuit with a canned redirect. The expensive call
//                  never happens. This IS protection layer 2, the cost gate.
//   2b. anything else -> the main call, with the lane attached.
// The classifier is a function, NOT a second endpoint: the client sends one
// request and gets one answer.
//
// Contract:
//   POST {
//     pageId,                     // charter key: practiceSkills, picker, guidedChat, ...
//     anchor: { type, text } | null,
//     message,                    // typed text or the chip's ask
//     context: {} | absent,       // the charter row's contextSlice (see below)
//     learner: { level, l1, flags: [] },
//     logTail: [],                // last ~5 coach_log rows, all pages
//     lang,                       // "en" | "es" — the UI language (redirect language)
//     answerIn,                   // "target" | "l1" | "both" (Law 8), optional
//     conversionUsed,             // has this session already spent the Law 6 conversion?
//     persona,                    // tutor | drill | linguist (coach voice)
//     uid, sessionId              // optional, for coach_log
//   }
//   -> {
//     ok: true,
//     answer,                     // the coach's reply, or the canned off-scope redirect
//     lane, in_scope, confidence, advisory,
//     route: null | { target, question, deepLink },   // ROUTE_TO_PAGE only
//     offScope: null | { kind: "conversion" | "plain" },
//     classifier: { raw_lane, demoted, ok, error }    // what the router actually said
//   }
//
// LAW 5 (ROUTE_TO_PAGE never skips the local answer): a routed message STILL
// gets a real answer here. The router only supplies the destination and the
// question; the UI renders the route chip on top of the local answer.
//
// LOW CONFIDENCE IS NOT A REFUSAL: under 0.5 the lane is advisory and the main
// call proceeds as LANGUAGE_GENERAL — including for an unsure OFF_SCOPE. The
// cost gate only fires on a confident off-scope verdict.
//
// Analytics: every classification is written to coach_log (fire and forget), so
// we can later learn which chips earn clicks and which lanes actually fire. The
// write happens BEFORE the main call, so a failed answer still leaves a record.
// Table: migrations/0004_coach_log.sql.
//
// THE CONTEXT THE PAGE HANDS US, AND THE DIET THE LANE PUTS IT ON. Every coach
// row sends a `context` slice (ui/coach-charter.js names the keys per row;
// ui/coach-row-logic.js prunes what a page cannot fill truthfully and omits the
// field entirely when nothing survives). The lane the classifier just chose
// decides which of those keys are worth paying for: PATTERNS gets the aggregates
// and the learner model, EXPLAIN gets the immediate page state, NAV_HELP and
// CREATOR_INFO get the knowledge doc instead, LANGUAGE_GENERAL gets neither.
// routes/coach-page/context.js owns that policy and the bounding; this route
// only wires it in and logs what survived.
//
// GROUNDING. Two failures seen in the wild, in one session: the coach invented a
// feature that does not exist AND denied one that does. The answering prompt now
// carries hard rules against both, and the context note tells it when a list it
// is holding was trimmed — so "I only see eight scenarios" can never become
// "Lux only has eight scenarios".
//
// NOT IN THIS ROUTE: usage limits (protection layer 4 — after N OFF_SCOPE hits
// in one session, skip classification entirely and return the plain redirect).
// Not needed pre-launch.

import {
  classify,
  luxMap,
  offScopeReply,
  pageName,
  routeDeepLink,
} from "./coach-page/router.js";
import { laneWantsKnowledge, selectContext } from "./coach-page/context.js";
import { knowledgeBlock, knowledgeDoc } from "./coach-page/knowledge.js";

export const config = {
  api: {
    bodyParser: true,
    externalResolver: true,
  },
};

const CEFR_VALUES = new Set(["A1", "A2", "B1", "B2", "C1", "C2"]);

// Coach persona voices, identical to routes/coach-ask.js — the same learner
// hears the same coach everywhere.
const PERSONA_NOTES = {
  tutor:
    "Voice: a warm, patient tutor. Encouraging and gentle; celebrate small wins.",
  drill:
    "Voice: a no-nonsense drill sergeant — punchy, direct, high-energy, tough love. " +
    "Short imperative commands. Motivating, NEVER insulting or demeaning.",
  linguist:
    "Voice: a precise language expert. Calm and exact; name the sound or grammar " +
    "point plainly, but still in plain words at the learner's level.",
};

const L1_NAMES = {
  es: "Spanish",
  en: "English",
  pt: "Portuguese",
  fr: "French",
  de: "German",
  it: "Italian",
  zh: "Chinese",
};

// The explanation language, per Law 8: "target language, L1, or both (the
// answerIn pattern already shipped in REF)". The coach rows send `lang` today
// and nothing else, so "target" is the default and today's behavior is unchanged
// — but the field is read when it arrives, because the pattern is the charter's
// and the frontend payload is not ours to change.
const ANSWER_IN_VALUES = new Set(["target", "l1", "both"]);

// ── The main call, one task per lane ────────────────────────────────────────
// The lane the router chose selects the task; everything else in the scaffold is
// shared. OFF_SCOPE never appears here — it short-circuits before the main call.
// (Prompt copy is the charter's to refine; the lane keys and the wiring are not.)
const LANE_TASKS = {
  EXPLAIN: {
    maxTokens: 320,
    temp: 0.4,
    task:
      "TASK — EXPLAIN: The learner is asking about what they selected or about something in front of them on this page. Answer THAT, directly, using the anchor as the subject and the `context` object as the page around it — the passage, the take, the scene, the settings, the scenarios on the deck are all real values you were handed, so read them instead of guessing at them. Lead with the answer in one line, then at most two lines of why it matters or what to do about it. Do not restate the anchor back at them, and do not wander off the page.",
  },
  NAV_HELP: {
    maxTokens: 300,
    temp: 0.3,
    task:
      "TASK — NAV HELP: The learner wants to know how Lux works, where something lives, or what a feature does. Say plainly where to go and what they will find there, using ONLY the pages listed in LUX above and whatever the LUX KNOWLEDGE block gives you. If you are not certain a feature exists, say so in one line and point at the nearest page that does exist — never invent a screen, button, or menu, and never tell them Lux cannot do something just because you were not told that it can.",
  },
  PATTERNS: {
    maxTokens: 320,
    temp: 0.4,
    task:
      "TASK — PATTERNS: The learner is asking about their own history, habits, progress, or recurring errors. Answer from the `context` object — the history aggregates, the learner model, the streaks and the per-type totals are already computed and handed to you, with the real sounds and the real numbers in them. Cite what is there; do not re-derive it and do not round it into a story it does not support. Name the pattern concretely and give ONE thing to do about it next. If what you were given is too thin to see a trend, say that honestly in one line — never invent a statistic, a streak, or a trend.",
  },
  CREATOR_INFO: {
    maxTokens: 300,
    temp: 0.6,
    task:
      "TASK — CREATOR INFO: The learner is asking about Mark, the teacher who built Lux, or about why Lux is built the way it is. Answer warmly and briefly, from the LUX KNOWLEDGE block when it has something and from the design philosophy otherwise: Lux is built by a language teacher for learners, it explains rather than scores, and it is meant to be the one place for every language question. Speak to the WHY. If you do not know a specific fact about Mark, say so plainly in one line instead of inventing biography.",
  },
  LANGUAGE_GENERAL: {
    maxTokens: 340,
    temp: 0.5,
    task:
      "TASK — LANGUAGE: Answer the learner's language, communication, pronunciation, or culture question directly and well. Culture, history, travel, and professional situations are all fair game when they serve language or communication — Lux wants to be the one place for every language question, so answer like it. Lead with the answer, keep it to a few short lines, and give one concrete example the learner could actually say.",
  },
  ROUTE_TO_PAGE: {
    maxTokens: 260,
    temp: 0.4,
    task:
      "TASK — SHORT ANSWER BEFORE THE HANDOFF: A different page has the real data or tools for this question, and the learner will be offered a link to it. Answer here ANYWAY — never send them away empty-handed. Give the best short answer you can from what you have (2-3 lines), then one line naming what the other page will add. Do not describe the link or tell them to click anything; the app shows it.",
  },
};

// Answering tier: the expensive call the OFF_SCOPE gate protects. The router
// itself stays on the quick chain (see below).
function mainModel() {
  return (
    (process.env.LUX_AI_MODEL || "").toString().trim() ||
    (process.env.LUX_AI_DEEP_MODEL || "").toString().trim() ||
    "gpt-4.1"
  );
}

// The router's chain, exactly as specified: quick first, main as the fallback.
function routerModel() {
  return (
    (process.env.LUX_AI_QUICK_MODEL || "").toString().trim() ||
    (process.env.LUX_AI_MODEL || "").toString().trim() ||
    "gpt-4.1-mini"
  );
}

const cap = (v, n) => (v == null ? "" : String(v)).trim().slice(0, n);

/**
 * LAW 8 — the explanation language is the learner's choice. `lang` is the pack:
 * the language the learner is studying and the language the UI speaks. `l1` is
 * the language they already have. `answerIn` picks between them.
 *
 * Falls back to the target language whenever the L1 cannot serve: no L1 chosen
 * ("universal"), an L1 we have no name for, or an L1 that IS the target. Never
 * returns an empty instruction — the coach always knows what to write in.
 *
 * @returns {{ note: string, targetName: string, l1Name: string, resolved: string }}
 */
export function explanationLanguage({ answerIn = "target", lang = "en", l1 = "" } = {}) {
  const targetName = lang === "es" ? "Spanish" : "English";
  const code = String(l1 || "").trim().toLowerCase();
  const named = L1_NAMES[code] || (code && code !== "universal" ? String(l1).trim() : "");
  const l1Name = named && named.toLowerCase() !== targetName.toLowerCase() ? named : "";

  // es-MX with tuteo is the house Spanish everywhere in Lux, whether Spanish is
  // the language being learned or the language being explained in.
  const tuteo = ` Use the informal "tú" register (never "usted").`;
  const spanishNote = (name) => (name === "Spanish" ? tuteo : "");

  if (answerIn === "l1" && l1Name) {
    return {
      resolved: "l1",
      targetName,
      l1Name,
      note: `Write your whole answer in ${l1Name} — the learner chose to have things explained in their first language.${spanishNote(l1Name)}`,
    };
  }
  if (answerIn === "both" && l1Name) {
    return {
      resolved: "both",
      targetName,
      l1Name,
      note: `Write the answer in ${targetName} first, then the same point in ONE short line in ${l1Name}.${spanishNote(targetName)}${spanishNote(l1Name)}`,
    };
  }
  return {
    resolved: "target",
    targetName,
    l1Name,
    note: `Write in ${targetName}.${spanishNote(targetName)}`,
  };
}

// The last ~5 coach_log rows the client carries between pages. Tolerant of both
// the camelCase the client uses and the snake_case the table returns.
function normalizeLogTail(rows) {
  if (!Array.isArray(rows)) return [];
  return rows
    .slice(-5)
    .map((r) => {
      const row = {
        pageId: cap(r?.pageId ?? r?.page_id, 40),
        lane: cap(r?.lane, 40),
        message: cap(r?.message, 240),
      };
      const answer = cap(r?.answer, 200);
      if (answer) row.answer = answer;
      return row;
    })
    .filter((r) => r.message || r.lane);
}

// The same tail, with every charter key swapped for the name a learner may hear.
// The classifier keeps the keys (they are its vocabulary); the answering model
// never sees one, so it cannot echo one back. A page with no human name is
// simply unnamed rather than named with its key.
function logTailForAnswer(rows, lang) {
  return rows.map((r) => {
    const out = { lane: r.lane, message: r.message };
    const name = pageName(r.pageId, lang);
    if (name) out.page = name;
    if (r.answer) out.answer = r.answer;
    return out;
  });
}

// Fire-and-forget classification log. Never blocks the answer, never throws, and
// degrades to a no-op when Supabase env is missing (same posture as the word_taps
// insert in coach-ask). Column names must match migrations/0004_coach_log.sql
// exactly — PostgREST rejects the whole row on an unknown column.
async function logClassification(row) {
  try {
    const { getSupabaseAdmin } = await import("../lib/supabase.js");
    const sb = getSupabaseAdmin();
    if (!sb) return;
    sb.from("coach_log")
      .insert(row)
      .then(() => {})
      .catch((e) => console.warn("[coach-page] coach_log insert failed", e?.message || e));
  } catch {
    // env not configured; run without logging
  }
}

export default async function handler(req, res) {
  // 1) CORS
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  // 2) ADMIN_TOKEN gate (cost-control), same as coach-ask
  const token =
    (req.headers["x-admin-token"] || "").toString().trim() ||
    (req.query?.token || "").toString().trim();
  const expected = (process.env.ADMIN_TOKEN || "").toString().trim();
  if (!expected || token !== expected) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  // 3) Validate input
  const body = req.body || {};
  const pageId = cap(body.pageId, 40);
  const message = cap(body.message, 1000);
  const lang = cap(body.lang || body.pack, 8).toLowerCase() === "es" ? "es" : "en";
  const conversionUsed = body.conversionUsed === true;
  const uid = cap(body.uid, 80);
  const sessionId = cap(body.sessionId ?? body.session_id, 80);

  const anchorIn = body.anchor && typeof body.anchor === "object" ? body.anchor : null;
  const anchor =
    anchorIn && (anchorIn.type || anchorIn.text)
      ? { type: cap(anchorIn.type, 40), text: cap(anchorIn.text, 600) }
      : null;

  const levelRaw = cap(body.learner?.level, 8).toUpperCase();
  const learner = {
    level: CEFR_VALUES.has(levelRaw) ? levelRaw : "B1",
    l1: cap(body.learner?.l1, 24) || "universal",
    flags: Array.isArray(body.learner?.flags)
      ? body.learner.flags.map((f) => cap(f, 60)).filter(Boolean).slice(0, 8)
      : [],
  };

  const logTail = normalizeLogTail(body.logTail);

  // The charter row's contextSlice, exactly as the page sent it. NOT shaped here:
  // the lane decides what is worth reading, and the lane is not known until the
  // pre-pass has run. Anything that is not a plain object is no context at all.
  const contextIn =
    body.context && typeof body.context === "object" && !Array.isArray(body.context)
      ? body.context
      : null;

  const answerInRaw = cap(body.answerIn, 12).toLowerCase();
  const answerIn = ANSWER_IN_VALUES.has(answerInRaw) ? answerInRaw : "target";

  const personaRaw = cap(body.persona ?? body.style, 24).toLowerCase();
  const persona = PERSONA_NOTES[personaRaw] ? personaRaw : "tutor";

  if (!message) {
    return res.status(400).json({ ok: false, error: "bad_request", detail: "message required" });
  }

  // 4) Imports & init (mirrors coach-ask)
  let OpenAI, jsonrepair;
  try {
    const modAI = await import("openai");
    const modRepair = await import("jsonrepair");
    OpenAI = modAI.OpenAI;
    jsonrepair = modRepair.jsonrepair;
  } catch (e) {
    console.error("[coach-page] import error", e);
    return res.status(500).json({ ok: false, error: "Server Init Error" });
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // 5) THE PRE-PASS. One cheap call. Fails open: a broken classifier yields
  //    confidence 0, which is advisory, which lands on LANGUAGE_GENERAL.
  const verdict = await classify(
    { pageId, anchor, message, learner, recent: logTail },
    { openai, model: routerModel(), jsonrepair }
  );

  const routed =
    verdict.lane === "ROUTE_TO_PAGE"
      ? {
          target: verdict.route_target,
          question: verdict.route_question,
          deepLink: routeDeepLink({ route_question: verdict.route_question, pageId }),
        }
      : null;

  // 6) Log the classification — every one, before the answer is attempted.
  logClassification({
    uid: uid || null,
    session_id: sessionId || null,
    page_id: pageId || null,
    anchor_type: anchor?.type || null,
    lane: verdict.lane,
    raw_lane: verdict.raw_lane || null,
    in_scope: verdict.in_scope,
    confidence: verdict.confidence,
    advisory: verdict.advisory,
    route_target: verdict.route_target || null,
    route_question: verdict.route_question || null,
    message,
    lang,
    off_scope_reply: verdict.lane === "OFF_SCOPE" ? (conversionUsed ? "plain" : "conversion") : null,
  });

  const classifier = {
    raw_lane: verdict.raw_lane,
    demoted: verdict.demoted,
    ok: verdict.ok,
    error: verdict.error,
  };

  // 7) THE COST GATE. A confident OFF_SCOPE never reaches the big model: the
  //    canned redirect is returned as-is. First off-scope ask of the session
  //    gets the conversion (Law 6); every one after that gets the plain redirect.
  //    NOTE: an anchored message is NOT force-marked in-scope here. Rule 2 says
  //    the anchor beats everything "unless the message clearly ignores it" —
  //    judging that is the classifier's job, and hard-blocking OFF_SCOPE on any
  //    anchor would hand anyone a permanent bypass of the cost gate.
  if (verdict.lane === "OFF_SCOPE") {
    const reply = offScopeReply({ lang, conversionUsed });
    return res.status(200).json({
      ok: true,
      answer: reply.text,
      lane: "OFF_SCOPE",
      in_scope: false,
      confidence: verdict.confidence,
      advisory: verdict.advisory,
      route: null,
      offScope: { kind: reply.kind },
      classifier,
    });
  }

  // 8) THE DIET. The lane is known, so what the expensive call is allowed to see
  //    is known too: aggregates for PATTERNS, page state for EXPLAIN, the
  //    knowledge doc for NAV_HELP and CREATOR_INFO, nothing at all for
  //    LANGUAGE_GENERAL. routes/coach-page/context.js bounds whatever survives.
  const picked = selectContext({ lane: verdict.lane, context: contextIn });
  const doc = laneWantsKnowledge(verdict.lane) ? await knowledgeDoc() : null;

  // Tuning telemetry, deliberately console-only. coach_log's columns ARE the
  // insert payload in this file (migrations/0004), and PostgREST rejects the
  // whole row on an unknown column — adding fields here would silently drop
  // every classification on any deployment that had not run a new migration.
  // A log line costs nothing and cannot break the analytics we already have.
  console.log(
    "[coach-page] context",
    JSON.stringify({
      page_id: pageId || null,
      lane: verdict.lane,
      present: picked.stats.present,
      offered: picked.stats.offered,
      kept: picked.stats.kept,
      dropped: picked.stats.dropped,
      off_diet: picked.stats.skipped,
      chars: picked.stats.chars,
      budget: picked.stats.budget,
      truncated: picked.stats.truncated,
      knowledge_chars: doc ? doc.chars : null,
    })
  );

  // 9) The main call, with the lane attached.
  const chosen = LANE_TASKS[verdict.lane] || LANE_TASKS.LANGUAGE_GENERAL;
  const answerLang = explanationLanguage({ answerIn, lang, l1: learner.l1 });

  // The Lux map goes to every lane that might mention the app; LANGUAGE_GENERAL
  // is the one lane with no business naming a screen, so it does not get it —
  // and is told plainly not to name one.
  const showsLuxMap = verdict.lane !== "LANGUAGE_GENERAL";
  const luxBlock = showsLuxMap
    ? `\nLUX (the only pages you may name — and the only names you may use for them):\n${luxMap(lang)}\n`
    : "";
  const namingRule = showsLuxMap
    ? "Name a page only as it is written in LUX above."
    : "Do not name a Lux page in this answer at all.";

  const knowledge = doc ? knowledgeBlock(doc) : "";

  const contextBlock = picked.context
    ? `\nPAGE CONTEXT: the \`context\` object in the user message is real data from this learner's own screen and history, handed to you by the app. Read it and answer FROM it — never guess at a number, a sound, a name, or a setting that is sitting right there.${
        picked.note
          ? " `contextNote` says what had to be trimmed to fit: a trimmed or missing key is unknown to you, not absent from Lux."
          : ""
      }\n`
    : "";

  const routeName = routed?.target ? pageName(routed.target, lang) : "";
  const routeNote = routed?.target
    ? `\nThe app will offer this learner a link${
        routeName ? ` to ${routeName}` : " to another page"
      } for: "${routed.question}". Do not mention the link itself.\n`
    : "";

  const humanPage = pageName(pageId, lang);
  const whereLine = humanPage ? `on the ${humanPage} page of Lux` : "on a page of Lux";

  const system = `
You are the Lux AI Coach, talking to a ${answerLang.targetName} learner at CEFR level ${learner.level}.

${PERSONA_NOTES[persona]}

You are ${whereLine}. You get: where the learner is, what they selected (the anchor,
when there is one), what they asked, who they are, the last few coach exchanges, and
— when the question needs it — a \`context\` object of real data from their screen
and their history.
${luxBlock}${knowledge}${contextBlock}${routeNote}
Rules:
- ${answerLang.note}
- Use NO words harder than the learner's ${learner.level} level.
- Lead with the answer. No preamble, no restating the question, no filler.
- Speak TO the learner ("you"/"tú"). Short beats complete.

GROUNDING — these bind harder than anything else here:
- State a fact about Lux ONLY if it appears in the context you were given or in the
  LUX blocks above. Otherwise say you are not sure.
- Never promise, describe, or imply a feature that is not in what you were given.
- Never tell the learner that Lux CANNOT do something unless you were told so here.
  Not being mentioned is not the same as not existing.
- "I don't know that one" is always a better answer than a confident invention. The
  same goes for the learner and for the language: no invented score, streak, sound,
  word, or setting.
- HUMAN NAMES ONLY. Never write an internal name in your answer — a camelCase or
  snake_case identifier, a route or file name, a URL, or anything else that reads
  like code rather than like a sentence. ${namingRule}

${chosen.task}

Output MUST be valid JSON only, with exactly this key:
{ "answer": "<your reply>" }
`.trim();

  const user = {
    anchor,
    message,
    learner,
    recent: logTailForAnswer(logTail, lang),
    lane: verdict.lane,
  };
  // The page rides as its human name, never its charter key: the answering model
  // cannot echo back an identifier it was never shown.
  if (humanPage) user.page = humanPage;
  if (picked.context) user.context = picked.context;
  if (picked.note) user.contextNote = picked.note;

  try {
    const resp = await openai.chat.completions.create({
      model: mainModel(),
      temperature: chosen.temp,
      max_tokens: chosen.maxTokens,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(user) },
      ],
    });

    const raw = resp?.choices?.[0]?.message?.content || "{}";
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = JSON.parse(jsonrepair(raw));
    }

    const answer = cap(parsed.answer, 1200);
    if (!answer) {
      return res.status(502).json({ ok: false, error: "empty_answer", lane: verdict.lane });
    }

    return res.status(200).json({
      ok: true,
      answer,
      lane: verdict.lane,
      in_scope: true,
      confidence: verdict.confidence,
      advisory: verdict.advisory,
      route: routed,
      offScope: null,
      classifier,
    });
  } catch (e) {
    console.error("[coach-page] main call failed", e);
    return res.status(502).json({ ok: false, error: "model_failed", lane: verdict.lane });
  }
}
