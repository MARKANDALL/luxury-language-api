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
//     learner: { level, l1, flags: [] },
//     logTail: [],                // last ~5 coach_log rows, all pages
//     lang,                       // "en" | "es" — the UI language (redirect language)
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
// NOT IN THIS ROUTE: usage limits (protection layer 4 — after N OFF_SCOPE hits
// in one session, skip classification entirely and return the plain redirect).
// Not needed pre-launch.

import {
  PAGES,
  classify,
  offScopeReply,
  routeDeepLink,
} from "./coach-page/router.js";

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

// The map of Lux the answering model is allowed to describe, built from the same
// registry the router validates route_target against. Given to the lanes that
// talk about the app so the coach points at real screens instead of inventing them.
const LUX_MAP = Object.entries(PAGES)
  .map(([key, blurb]) => `- ${key}: ${blurb}`)
  .join("\n");

// ── The main call, one task per lane ────────────────────────────────────────
// The lane the router chose selects the task; everything else in the scaffold is
// shared. OFF_SCOPE never appears here — it short-circuits before the main call.
// (Prompt copy is the charter's to refine; the lane keys and the wiring are not.)
const LANE_TASKS = {
  EXPLAIN: {
    maxTokens: 320,
    temp: 0.4,
    task:
      "TASK — EXPLAIN: The learner is asking about what they selected or about something in front of them on this page. Answer THAT, directly, using the anchor as the subject. Lead with the answer in one line, then at most two lines of why it matters or what to do about it. Do not restate the anchor back at them, and do not wander off the page.",
  },
  NAV_HELP: {
    maxTokens: 300,
    temp: 0.3,
    task:
      "TASK — NAV HELP: The learner wants to know how Lux works, where something lives, or what a feature does. Say plainly where to go and what they will find there, using ONLY the pages listed in LUX above. If you are not certain a feature exists, say so in one line and point at the nearest page that does exist — never invent a screen, button, or menu.",
  },
  PATTERNS: {
    maxTokens: 320,
    temp: 0.4,
    task:
      "TASK — PATTERNS: The learner is asking about their own history, habits, progress, or recurring errors. Answer from the pattern flags and recent activity you were given. Name the pattern concretely and give ONE thing to do about it next. If what you were given is too thin to see a trend, say that honestly in one line and point them at where the full history lives — never invent a statistic, a streak, or a trend.",
  },
  CREATOR_INFO: {
    maxTokens: 300,
    temp: 0.6,
    task:
      "TASK — CREATOR INFO: The learner is asking about Mark, the teacher who built Lux, or about why Lux is built the way it is. Answer warmly and briefly, from the design philosophy: Lux is built by a language teacher for learners, it explains rather than scores, and it is meant to be the one place for every language question. Speak to the WHY. If you do not know a specific fact about Mark, say so plainly in one line instead of inventing biography.",
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

  // 8) The main call, with the lane attached.
  const chosen = LANE_TASKS[verdict.lane] || LANE_TASKS.LANGUAGE_GENERAL;
  const L1NAME = L1_NAMES[learner.l1.toLowerCase()] || learner.l1;
  const targetLangName = lang === "es" ? "Spanish" : "English";
  const registerNote =
    lang === "es"
      ? `Write in Spanish using the informal "tú" register (never "usted").`
      : `Write in English.`;

  // The Lux map goes only to the lanes that talk about the app; the language
  // lanes do not need it and should not be tempted to name screens.
  const showsLuxMap = verdict.lane === "NAV_HELP" || verdict.lane === "ROUTE_TO_PAGE";
  const luxBlock = showsLuxMap
    ? `\nLUX (the only pages you may name):\n${LUX_MAP}\n`
    : "";
  const routeNote =
    routed && routed.target
      ? `\nThe app will offer this learner a link to the "${routed.target}" page for: "${routed.question}". Do not mention the link itself.\n`
      : "";

  const system = `
You are the Lux AI Coach, talking to a ${targetLangName} learner at CEFR level ${learner.level}.

${PERSONA_NOTES[persona]}

You are on the "${pageId || "unknown"}" page of Lux. You get: where the learner is, what
they selected (the anchor, when there is one), what they asked, who they are, and
the last few coach exchanges.
${luxBlock}${routeNote}
Rules:
- ${registerNote}
- Use NO words harder than the learner's ${learner.level} level.
- Lead with the answer. No preamble, no restating the question, no filler.
- Speak TO the learner ("you"/"tú"). Short beats complete.
- Never invent facts about the learner, about Lux, or about the language. If you
  do not know, say so in one short line.

${chosen.task}

Output MUST be valid JSON only, with exactly this key:
{ "answer": "<your reply>" }
`.trim();

  const user = {
    pageId,
    anchor,
    message,
    learner,
    recent: logTail,
    lane: verdict.lane,
  };

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
