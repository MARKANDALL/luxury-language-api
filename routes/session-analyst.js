// routes/session-analyst.js
// One-line: The Session Analyst — Lux's first non-pronunciation feedback
// instrument. Once per completed guided conversation it reviews the user's own
// turns for grammar accuracy and word choice, stores structured events, and
// returns a small report for the end-of-session modal.
//
// HARD LAWS (Session Analyst Phase 0+1) enforced here:
//   1. Pack-neutral machinery. This file contains NO language literals. Every
//      learner-facing string, taxonomy code, label, rubric and severity
//      definition comes from lang/session-analyst/<pack>.js.
//   2. Mercy is structural.
//        a. Local pre-gate: under SPONTANEOUS_WORD_GATE spontaneous words -> NO
//           LLM call, store nothing, evidence:"insufficient".
//        b. Turns with asrConfidence < ASR_CONFIDENCE_MIN are excluded from
//           judgment entirely (not counted toward the gate, not judgeable).
//        c. Zero flags is a valid, expected output.
//   3. Provenance-aware. chip_read turns produce NO flags and NO credit;
//      chip_modified turns are judged only on what changed; both enforced by
//      the "judgeable" set server-side, not just by the prompt. dictated and
//      composed turns are the learner's OWN words with nothing on screen that
//      supplied them, so they gate and judge exactly as spontaneous does.
//   4. Store all, surface few. All valid events go to speech_events; the route
//      returns everything (sorted most-severe first) and the UI shows <=3+1.
//   5. One LLM call per session (a single repair retry is allowed ONLY when the
//      model returns unparseable/invalid JSON). On a second failure: fail silent
//      (no rows, error status) — no UI section beats a broken one.
//   6. Idempotent per session. The same session may now be submitted more than
//      once (exit capture, then an explicit End Session). A later pass
//      supersedes an earlier one ONLY if it carries strictly more turns;
//      otherwise it is a no-op that replays the stored report without an LLM
//      call and without writing a duplicate speech_events row. Enforced
//      server-side in lib/session-analysis-store.js, never by the client.
//
// Cloned from the routes/coach-ask.js + routes/word-info.js skeleton: same CORS
// + admin-token gate, same json_object + jsonrepair parsing, same lazy/graceful
// Supabase. Deep-analysis model tier (LUX_AI_DEEP_MODEL -> gpt-4.1), NOT the
// per-tap gpt-4.1-mini tier.
//
// Contract: see the backend PR description (§2.2). Table: speech_events (§2.4).

import {
  readPass,
  commitPass,
  finalizePass,
  clearSupersededEvents,
  normalizeCapturedVia,
} from "../lib/session-analysis-store.js";

export const config = {
  api: {
    bodyParser: true,
    externalResolver: true,
  },
};

// ── Config constants (pack-neutral) ────────────────────────────────────────
const ASR_CONFIDENCE_MIN = 0.85; // hard law 2b
const SPONTANEOUS_WORD_GATE = 12; // hard law 2a
const VALID_PACKS = new Set(["es", "en"]);
const CEFR_VALUES = new Set(["A1", "A2", "B1", "B2", "C1", "C2"]);
// Every provenance the frontend may send.
//   spontaneous   - free speech, no chip on screen explained it
//   chip_read     - the learner read a suggestion chip verbatim
//   chip_modified - the learner started from a chip and edited it
//   dictated      - the learner dictated the words (either dictation mode)
//   composed      - the learner TYPED the text themselves (a custom passage)
const PROVENANCE_VALUES = new Set([
  "spontaneous",
  "chip_read",
  "chip_modified",
  "dictated",
  "composed",
]);

// The learner's OWN production, with nothing on screen that supplied the words.
// These three are interchangeable for both the gate and judgeability: dictating
// a sentence or typing it is no less the learner's own language than saying it,
// and treating them differently would silently withhold feedback on it.
//
// This set is why adding the two new values changes NOTHING for existing
// payloads: before this, dictated turns arrived tagged "spontaneous" and were
// gated and judged exactly as this set now gates and judges them.
const OWN_PRODUCTION = new Set(["spontaneous", "dictated", "composed"]);
const ITEM_CHANNELS = new Set(["grammar", "word_choice"]);
const ITEM_SEVERITIES = new Set(["blocked", "noticeable", "polish"]);
const SEVERITY_RANK = { blocked: 0, noticeable: 1, polish: 2 };

// Bounds — never trust the model's counts; clamp what reaches the DB.
const MAX_TURNS = 200;
const MAX_TURN_TEXT = 2000;
const MAX_ITEMS = 50;
const MAX_STRENGTHS = 20;
const MAX_STR = 400; // per learner-facing string field
const MAX_AFN = 3;

// Count the words a user genuinely produced. Unicode-aware so Spanish accents
// count as one word ("Sí" -> 1, "por favor" -> 2). Punctuation is not a word.
function wordCount(text) {
  return (String(text || "").match(/[\p{L}\p{N}]+/gu) || []).length;
}

function clampStr(v, max = MAX_STR) {
  return String(v ?? "").trim().slice(0, max);
}

// Parse the model's JSON (with jsonrepair fallback) into the report shape, or
// return null when it is unparseable or structurally invalid (-> repair retry).
function parseReport(raw, jsonrepair) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    try {
      parsed = JSON.parse(jsonrepair(String(raw || "")));
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const evidence = String(parsed.evidence || "").trim().toLowerCase();
  if (evidence !== "sufficient" && evidence !== "insufficient") return null;
  return {
    evidence,
    evidenceNote: clampStr(parsed.evidenceNote),
    items: Array.isArray(parsed.items) ? parsed.items : [],
    strengths: Array.isArray(parsed.strengths) ? parsed.strengths : [],
    afnCandidates: Array.isArray(parsed.afnCandidates) ? parsed.afnCandidates : [],
  };
}

export default async function handler(req, res) {
  // 1) CORS / method (router also gates; kept for defense-in-depth + parity)
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  // 2) ADMIN_TOKEN gate (cost-control), same as every other route
  const token =
    (req.headers["x-admin-token"] || "").toString().trim() ||
    (req.query?.token || "").toString().trim();
  const expected = (process.env.ADMIN_TOKEN || "").toString().trim();
  if (!expected || token !== expected) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  // 3) Validate payload
  const body = req.body || {};
  const uid = (body.uid || "").toString().trim().slice(0, 80);
  const sessionId = (body.sessionId || body.session_id || "").toString().trim().slice(0, 120);
  const surface = (body.surface || "guided").toString().trim().slice(0, 40) || "guided";
  // The scenario's STABLE id (never its pack-localized title). Additive and
  // optional: a client that does not send one writes null, exactly as every row
  // before migration 0007 did. See migrations/0007_speech_events_scenario_key.sql.
  const scenarioKey =
    (body.scenarioKey || body.scenario_key || "").toString().trim().slice(0, 80) || null;
  // How this pass was triggered. 'explicit' = End Session / Save, 'exit' = a
  // pagehide / visibilitychange hook, 'switch' = the learner moved to another
  // scenario in the same page load. A caller that sends nothing is 'explicit',
  // which is exactly what every pre-existing caller is.
  const capturedVia = normalizeCapturedVia(body.capturedVia || body.captured_via);
  // The client trimmed the payload to fit the fetch keepalive body cap, so the
  // analysis is honest but partial. Recorded, never acted on.
  const truncated = body.truncated === true;
  const packRaw = (body.pack || "en").toString().trim().toLowerCase();
  const pack = VALID_PACKS.has(packRaw) ? packRaw : "en";
  const levelRaw = (body.level || "B1").toString().trim().toUpperCase();
  const level = CEFR_VALUES.has(levelRaw) ? levelRaw : "B1";

  if (!uid) {
    return res.status(400).json({ ok: false, error: "bad_request", detail: "uid required" });
  }
  if (!Array.isArray(body.turns) || body.turns.length === 0) {
    return res.status(400).json({ ok: false, error: "bad_request", detail: "turns required" });
  }

  // Normalize turns: sanitize, bound, and index by turn index for later lookups.
  const turns = body.turns.slice(0, MAX_TURNS).map((t, i) => {
    const index = Number.isInteger(t?.index) ? t.index : i + 1;
    const provRaw = String(t?.provenance || "spontaneous").trim();
    const provenance = PROVENANCE_VALUES.has(provRaw) ? provRaw : "spontaneous";
    let asrConfidence = Number(t?.asrConfidence);
    if (!Number.isFinite(asrConfidence)) asrConfidence = 1;
    asrConfidence = Math.max(0, Math.min(1, asrConfidence));
    return {
      index,
      text: String(t?.text || "").trim().slice(0, MAX_TURN_TEXT),
      provenance,
      asrConfidence,
    };
  });
  const turnByIndex = new Map(turns.map((t) => [t.index, t]));

  // Judgeable turns (hard laws 2b + 3): spontaneous or chip_modified, and above
  // the ASR-confidence floor. chip_read and low-confidence turns can never carry
  // a flag or a strength, no matter what the model returns.
  const judgeableIndices = new Set(
    turns
      .filter(
        (t) =>
          (OWN_PRODUCTION.has(t.provenance) || t.provenance === "chip_modified") &&
          t.asrConfidence >= ASR_CONFIDENCE_MIN
      )
      .map((t) => t.index)
  );

  // 3b) IDEMPOTENCY SCAFFOLD (hard law 6). turnCount is the whole supersede rule:
  // the number of user turns THIS pass carries, after bounding. A session with
  // no id cannot be deduped, so it takes the pre-idempotency path untouched.
  const turnCount = turns.length;
  const sessionKey = sessionId
    ? { uid, sessionId, surface, scenarioKey }
    : null;

  // One lazily-built Supabase client for both the idempotency reads and the
  // event insert. Lazy + graceful exactly as before: a missing env, or a table
  // that has not been migrated yet, degrades to today's behaviour.
  let _sb;
  async function getSb() {
    if (_sb !== undefined) return _sb;
    try {
      const { getSupabaseAdmin } = await import("../lib/supabase.js");
      _sb = getSupabaseAdmin() || null;
    } catch (e) {
      console.warn("[session-analyst] storage skipped", e?.message || e);
      _sb = null;
    }
    return _sb;
  }

  // The pass already recorded for this session, if any. Read BEFORE any model
  // call so a duplicate costs one SELECT rather than an LLM round trip.
  const priorPass = sessionKey ? await readPass(await getSb(), sessionKey) : null;

  // Record this pass and return the body, or replay a winning pass's stored
  // body when a concurrent equal-or-longer pass beat us to the key.
  // `writeRows` runs ONLY when this pass owns the key.
  async function settle(payloadBody, { evidence, storedEvents = 0, writeRows = null }) {
    if (!sessionKey) {
      // No session id: nothing to dedupe against. Old path, unchanged.
      if (writeRows) await writeRows();
      return payloadBody;
    }
    const sb = await getSb();
    const { won, existing } = await commitPass(
      sb,
      sessionKey,
      {
        pack,
        captured_via: capturedVia,
        turn_count: turnCount,
        truncated,
        evidence,
        stored_events: storedEvents,
        report: payloadBody,
      },
      priorPass != null
    );
    if (!won) {
      // Another pass owns the key. Never write rows behind it. Replay its
      // report when it has one; otherwise hand back our own body unstored, so
      // the caller still renders something real.
      if (existing?.report) {
        return { ...existing.report, meta: { ...(existing.report.meta || {}), deduped: true } };
      }
      return { ...payloadBody, meta: { ...(payloadBody.meta || {}), deduped: true } };
    }
    if (writeRows) await writeRows();
    return payloadBody;
  }

  // `report` must be present: a record whose report is null is a pass that
  // claimed the key and then failed before finishing, and must not suppress a
  // real analysis.
  if (priorPass && priorPass.report && priorPass.turn_count >= turnCount) {
    // A pass carrying at least as many turns already landed. No LLM, no rows,
    // no duplicate: replay what it returned so the UI renders identically.
    const replay = priorPass.report;
    return res.status(200).json({
      ...replay,
      meta: {
        ...(replay.meta || {}),
        deduped: true,
        capturedVia: priorPass.captured_via || null,
        priorTurnCount: priorPass.turn_count,
      },
    });
  }

  // 4) Load the per-pack dictionary — the ONLY language content. Never inject the
  // pack string into the path unsanitized (VALID_PACKS whitelist above).
  let dict;
  try {
    const mod = await import(`../lang/session-analyst/${pack}.js`);
    dict = mod.default || mod;
  } catch (e) {
    console.error("[session-analyst] dictionary load failed", pack, e?.message || e);
    return res.status(500).json({ ok: false, error: "dictionary_unavailable" });
  }
  const validCategoryCodes = new Set((dict.categories || []).map((c) => c.code));

  // 5) LOCAL PRE-GATE (hard law 2a). Count only genuinely spontaneous words,
  // above the confidence floor. chip_read/chip_modified do NOT count: the chip
  // text is not in the payload, so a modified turn's spontaneous portion cannot
  // be isolated on the backend (see PR Disclosures). Under the gate: NO LLM call,
  // NO rows written, insufficient.
  const spontaneousWords = turns
    .filter((t) => OWN_PRODUCTION.has(t.provenance) && t.asrConfidence >= ASR_CONFIDENCE_MIN)
    .reduce((n, t) => n + wordCount(t.text), 0);

  if (spontaneousWords < SPONTANEOUS_WORD_GATE) {
    // NOT recorded. Hard law 2a is "store nothing" under the gate, and that
    // includes the idempotency record: a below-gate pass costs no LLM call and
    // writes no speech_events row, so there is nothing to protect against a
    // repeat. Re-running the gate is pure local arithmetic.
    return res.status(200).json({
      ok: true,
      evidence: "insufficient",
      evidenceNote: dict.insufficientNote || "",
      items: [],
      strengths: [],
      afnCandidates: [],
      meta: {
        pack,
        spontaneousWords,
        gate: SPONTANEOUS_WORD_GATE,
        llmCalled: false,
        stored: 0,
        capturedVia,
        turnCount,
        truncated,
      },
    });
  }

  // 6) Build the prompt. Engine scaffolding is English (not learner-facing);
  // ALL language/taxonomy content comes from the dictionary.
  const categoryLines = (dict.categories || [])
    .map((c) => `- ${c.code}: ${c.label} — ${c.description}`)
    .join("\n");
  const codeList = (dict.categories || []).map((c) => c.code).join(", ");

  const system = [
    dict.promptPreamble,
    `Taxonomy (category codes you may use):\n${categoryLines}`,
    dict.wordChoiceRubric,
    dict.severityDefinitions,
    `
Each turn is tagged with "provenance" and a boolean "judgeable". You may ONLY
produce items or strengths for turns whose "judgeable" is true. Never flag a
turn whose "judgeable" is false.

Output STRICT JSON ONLY, exactly this shape (no prose, no markdown):
{
  "evidence": "sufficient" | "insufficient",
  "evidenceNote": "one short sentence, in the analyst's language",
  "items": [
    {
      "channel": "grammar" | "word_choice",
      "category": "<one of: ${codeList}>",
      "severity": "blocked" | "noticeable" | "polish",
      "turnIndex": <integer, a judgeable turn>,
      "utterance": "<exact words the user said>",
      "suggestion": "<the natural alternative>",
      "explanation": "<one sentence, learner-facing, in the analyst's language>"
    }
  ],
  "strengths": [
    { "turnIndex": <integer, a judgeable turn>, "utterance": "<exact words>", "note": "<one sentence>" }
  ],
  "afnCandidates": ["<up to 3 category codes>"]
}
"category" MUST be one of the listed codes. "items" and "strengths" may be empty
— zero flags is a valid, expected result. Do not invent errors.`.trim(),
  ].join("\n\n");

  const userPayload = {
    level,
    surface,
    turns: turns.map((t) => ({
      index: t.index,
      text: t.text,
      provenance: t.provenance,
      judgeable: judgeableIndices.has(t.index),
    })),
  };

  // 7) Imports & init (mirrors coach-ask / word-info)
  let OpenAI, jsonrepair;
  try {
    const modAI = await import("openai");
    const modRepair = await import("jsonrepair");
    OpenAI = modAI.OpenAI;
    jsonrepair = modRepair.jsonrepair;
  } catch (e) {
    console.error("[session-analyst] import error", e);
    return res.status(500).json({ ok: false, error: "Server Init Error" });
  }
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const MODEL =
    (process.env.LUX_AI_DEEP_MODEL || "").toString().trim() || "gpt-4.1";

  async function callModel(messages) {
    const resp = await openai.chat.completions.create({
      model: MODEL,
      temperature: 0.2,
      max_tokens: 2000,
      response_format: { type: "json_object" },
      messages,
    });
    return resp?.choices?.[0]?.message?.content || "{}";
  }

  // 8) ONE call, with a single JSON-repair retry (hard law 5).
  const baseMessages = [
    { role: "system", content: system },
    { role: "user", content: JSON.stringify(userPayload) },
  ];
  let report = null;
  let retried = false;
  try {
    const raw1 = await callModel(baseMessages);
    report = parseReport(raw1, jsonrepair);
    if (!report) {
      retried = true;
      const raw2 = await callModel([
        ...baseMessages,
        { role: "assistant", content: raw1 },
        {
          role: "user",
          content:
            "Your previous message was not valid JSON matching the required contract. Reply with ONLY the corrected JSON object — no prose, no code fences.",
        },
      ]);
      report = parseReport(raw2, jsonrepair);
    }
  } catch (e) {
    console.error("[session-analyst] model call failed", e?.message || e);
    return res.status(502).json({ ok: false, error: "analysis_unavailable" });
  }

  // Second failure -> fail silent: store nothing, no UI section.
  if (!report) {
    return res.status(502).json({ ok: false, error: "analysis_unavailable" });
  }

  // Model-declared insufficient (e.g. short transactional turns past the gate):
  // return the note, store nothing.
  if (report.evidence === "insufficient") {
    const modelInsufficient = {
      ok: true,
      evidence: "insufficient",
      evidenceNote: report.evidenceNote || dict.insufficientNote || "",
      items: [],
      strengths: [],
      afnCandidates: [],
      meta: {
        pack,
        spontaneousWords,
        gate: SPONTANEOUS_WORD_GATE,
        llmCalled: true,
        retried,
        stored: 0,
        capturedVia,
        turnCount,
        truncated,
      },
    };
    return res.status(200).json(await settle(modelInsufficient, { evidence: "insufficient" }));
  }

  // 9) Server-side validation. Never trust the model: drop unknown categories,
  // non-judgeable turnIndexes (enforces chip_read no-credit + low-conf exclusion),
  // clamp fields and counts, coerce severity.
  const items = report.items
    .filter((it) => it && typeof it === "object")
    .map((it) => {
      const channel = String(it.channel || "").trim();
      const category = String(it.category || "").trim();
      let severity = String(it.severity || "").trim().toLowerCase();
      if (!ITEM_SEVERITIES.has(severity)) {
        // Word-choice defaults to polish (rubric); grammar to noticeable.
        severity = channel === "word_choice" ? "polish" : "noticeable";
      }
      const turnIndex = Number(it.turnIndex);
      return {
        channel,
        category,
        severity,
        turnIndex,
        utterance: clampStr(it.utterance),
        suggestion: clampStr(it.suggestion),
        explanation: clampStr(it.explanation),
      };
    })
    .filter(
      (it) =>
        ITEM_CHANNELS.has(it.channel) &&
        validCategoryCodes.has(it.category) &&
        Number.isInteger(it.turnIndex) &&
        judgeableIndices.has(it.turnIndex)
    )
    .sort(
      (a, b) =>
        (SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]) ||
        (a.turnIndex - b.turnIndex)
    )
    .slice(0, MAX_ITEMS);

  const strengths = report.strengths
    .filter((s) => s && typeof s === "object")
    .map((s) => ({
      turnIndex: Number(s.turnIndex),
      utterance: clampStr(s.utterance),
      note: clampStr(s.note),
    }))
    .filter((s) => Number.isInteger(s.turnIndex) && judgeableIndices.has(s.turnIndex))
    .slice(0, MAX_STRENGTHS);

  const afnCandidates = Array.from(
    new Set(
      report.afnCandidates
        .map((c) => String(c || "").trim())
        .filter((c) => validCategoryCodes.has(c))
    )
  ).slice(0, MAX_AFN);

  // 10) Store all events (hard law 4). Grammar/word_choice items + strengths
  // (channel:"strength", severity:"positive"). asr_confidence + provenance come
  // from the turn the flag points at. Lazy + graceful: a missing Supabase env
  // never breaks the report.
  let stored = 0;
  let storedAfn = 0;
  const rows = [
    ...items.map((it) => {
      const t = turnByIndex.get(it.turnIndex);
      return {
        uid,
        session_id: sessionId || null,
        surface,
        scenario_key: scenarioKey,
        turn_index: it.turnIndex,
        pack,
        channel: it.channel,
        category: it.category,
        severity: it.severity,
        utterance: it.utterance || null,
        suggestion: it.suggestion || null,
        explanation: it.explanation || null,
        asr_confidence: t ? t.asrConfidence : null,
        provenance: t ? t.provenance : null,
      };
    }),
    ...strengths.map((s) => {
      const t = turnByIndex.get(s.turnIndex);
      return {
        uid,
        session_id: sessionId || null,
        surface,
        scenario_key: scenarioKey,
        turn_index: s.turnIndex,
        pack,
        channel: "strength",
        category: null,
        severity: "positive",
        utterance: s.utterance || null,
        suggestion: null,
        explanation: s.note || null,
        asr_confidence: t ? t.asrConfidence : null,
        provenance: t ? t.provenance : null,
      };
    }),
  ];

  // AFN nominations: the analyst's own "work on these next" list, up to three
  // validated category codes, order preserved as rank. Stored in their own
  // additive table because speech_events.channel carries a CHECK constraint
  // that a new channel value would violate (migrations/0009).
  const afnRows = afnCandidates.map((category, i) => ({
    uid,
    session_id: sessionId || null,
    surface,
    scenario_key: scenarioKey,
    pack,
    category,
    rank: i + 1,
  }));

  async function insertAfn(sb) {
    if (!afnRows.length || !sb) return 0;
    try {
      const { error } = await sb.from("speech_afn_candidates").insert(afnRows);
      if (error) {
        // Never fatal: a missing table (not yet migrated) must not cost the
        // learner their report or their speech_events rows.
        console.warn("[session-analyst] afn insert failed", error?.message || error);
        return 0;
      }
      return afnRows.length;
    } catch (e) {
      console.warn("[session-analyst] afn storage skipped", e?.message || e);
      return 0;
    }
  }

  async function insertRows(sb) {
    if (!rows.length || !sb) return 0;
    try {
      // Awaited (not fire-and-forget): the row must land before the serverless
      // function can freeze after the response.
      const { error } = await sb.from("speech_events").insert(rows);
      if (error) {
        console.warn("[session-analyst] insert failed", error?.message || error);
        return 0;
      }
      return rows.length;
    } catch (e) {
      // env not configured / import failed: return the report anyway.
      console.warn("[session-analyst] storage skipped", e?.message || e);
      return 0;
    }
  }

  // 11) Return the report + metadata. UI surfaces <=3 items + 1 strength; the
  // API returns everything it stored, most-severe first.
  const buildBody = (extraMeta = {}) => ({
    ok: true,
    evidence: "sufficient",
    evidenceNote: report.evidenceNote || "",
    items,
    strengths,
    afnCandidates,
    meta: {
      pack,
      spontaneousWords,
      gate: SPONTANEOUS_WORD_GATE,
      llmCalled: true,
      retried,
      model: MODEL,
      stored,
      storedAfn,
      capturedVia,
      turnCount,
      truncated,
      ...extraMeta,
    },
  });

  // No session id: nothing to dedupe against, so this is exactly the old path.
  if (!sessionKey) {
    const sbNoKey = await getSb();
    stored = await insertRows(sbNoKey);
    storedAfn = await insertAfn(sbNoKey);
    return res.status(200).json(buildBody());
  }

  // Claim the key BEFORE writing any row, so a pass that loses the race can
  // never leave duplicate speech_events behind. The report is filled in after
  // the insert, once meta.stored is a real number (finalizePass).
  const sb = await getSb();
  const { won, existing } = await commitPass(
    sb,
    sessionKey,
    {
      pack,
      captured_via: capturedVia,
      turn_count: turnCount,
      truncated,
      evidence: "sufficient",
      stored_events: 0,
      report: null,
    },
    priorPass != null
  );

  if (!won) {
    if (existing?.report) {
      return res.status(200).json({
        ...existing.report,
        meta: { ...(existing.report.meta || {}), deduped: true },
      });
    }
    return res.status(200).json(buildBody({ deduped: true, stored: 0 }));
  }

  // We own the key. If a shorter pass wrote rows for this session earlier, they
  // are now superseded: drop them first so the learner is not counted twice.
  if (priorPass) await clearSupersededEvents(sb, sessionKey);
  stored = await insertRows(sb);
  storedAfn = await insertAfn(sb);

  const finalBody = buildBody();
  await finalizePass(sb, sessionKey, { stored_events: stored, report: finalBody });
  return res.status(200).json(finalBody);
}
