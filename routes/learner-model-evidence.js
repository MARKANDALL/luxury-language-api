// routes/learner-model-evidence.js
// One-line: the Richness Pass drill-in — the events behind one category of the
// speaking portrait, so a learner who reads "Ser/Estar, 3 times, still recurring"
// can open it and see the three actual sentences instead of taking it on trust.
//
// Read-only, exactly like routes/learner-model.js: it NEVER writes a
// speech_events row and it NEVER calls a model. Same CORS-by-router + internal
// ADMIN_TOKEN gate, same lazy/optional Supabase, same never-500 posture.
//
// WHY A SEPARATE ROUTE AND NOT MORE OF THE learner-model RESPONSE.
// Measured, not guessed. Cap 10 events per category, 18 categories in the es
// taxonomy (lang/session-analyst/es.js), and MAX_STR = 400 per learner-facing
// string in the writer (session-analyst.js:93):
//   worst case   18 x 10 x (3 x 400 + ~180 bytes of keys)  ~= 243 KB
//   realistic    18 x 10 x (~260 chars UTF-8 + ~180 bytes) ~=  81 KB
// against the ~100 KB line the brief set. Realistic is already at it and the
// ceiling is 2.4x over.
//
// The second reason is the one that actually settles it. The learner-model
// response is fetched on EVERY Progress page load and republished on luxBus,
// where the All Data coach picks it up as `learnerModelFull` and feeds it into a
// prompt (features/coach/all-data-coach.js:112). Folding the evidence in would
// make every page load and every coach question carry ten times the payload to
// deliver content that lives behind an expand most readers never open. House law
// is "never overwhelming, always expandable"; this route is that law at the
// network layer. It is fetched when a row is opened, and not before.
//
// Contract:
//   POST { uid, pack, category }
//     -> { ok: true, pack, category, label, cap, returned, total, truncated,
//          events: [{ utterance, suggestion, explanation, severity,
//                     provenance, surface, scenarioKey, createdAt }] }
//   Most recent first. An unknown category, an empty learner, or a missing
//   Supabase all return the same valid empty shape at HTTP 200 — an empty
//   evidence trail is an answer, not an error.

export const config = {
  api: {
    bodyParser: true,
    externalResolver: true,
  },
};

import { UNCATEGORIZED, loadLabelMap } from "./learner-model.js";

// The cap the brief set, and the one the payload reports back so the panel can
// say "the 10 most recent" honestly instead of implying it has shown everything.
const EVIDENCE_CAP = 10;

// Strengths (channel='strength') carry a null category, and so does an item the
// analyst left uncategorised. Without this filter, opening the "(uncategorized)"
// row would serve the learner their own praise as though it were evidence of a
// mistake. Same split learner-model.js makes on the way in.
const ITEM_CHANNELS = ["grammar", "word_choice"];

// The empty-but-valid answer. Never a 500 (house law: the portrait's surfaces
// degrade, they do not break).
function emptyEvidence(category, label) {
  return {
    category,
    label: label || category || null,
    cap: EVIDENCE_CAP,
    returned: 0,
    total: 0,
    truncated: false,
    events: [],
  };
}

// One stored row -> one occurrence the panel can render. camelCase on the way
// out to match the rest of the learner-model surface; the DB columns are snake.
function toEvent(r) {
  return {
    utterance: r?.utterance || null,
    suggestion: r?.suggestion || null,
    explanation: r?.explanation || null,
    severity: r?.severity || null,
    // Null for rows written before the frontend sent one. The panel says
    // nothing at all rather than guessing a source — see the frontend's
    // sourceLabel(), which returns "" for an unknown provenance.
    provenance: r?.provenance || null,
    surface: r?.surface || null,
    scenarioKey: r?.scenario_key || null,
    createdAt: r?.created_at || null,
  };
}

export default async function handler(req, res) {
  // 1) CORS / method (the router also handles CORS + the admin gate).
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  // Best-effort pack for EVERY exit below, parsed defensively so this line can
  // never throw. Mirrors learner-model.js.
  const pack =
    ((req.body && req.body.pack) || "en").toString().trim() === "es" ? "es" : "en";

  // 2) ADMIN_TOKEN gate (belt-and-suspenders with the router). Kept before the
  // guard below so a rejected call is a real 401, never a masked empty trail.
  const token =
    (req.headers["x-admin-token"] || "").toString().trim() ||
    (req.query?.token || "").toString().trim();
  const expected = (process.env.ADMIN_TOKEN || "").toString().trim();
  if (!expected || token !== expected) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  // The category is echoed on every exit, so parse it before the try.
  const category = ((req.body && req.body.category) || "").toString().trim().slice(0, 80);

  // 3) Top-level guard. Same law as learner-model.js: ANY unexpected throw
  // degrades to the empty shape at HTTP 200, logged WITH route context.
  try {
    const uid = ((req.body && req.body.uid) || "").toString().trim().slice(0, 80);

    if (!uid || !category) {
      return res.status(200).json({ ok: true, pack, ...emptyEvidence(category, null) });
    }

    let sb = null;
    try {
      const { getSupabaseAdmin } = await import("../lib/supabase.js");
      sb = getSupabaseAdmin();
    } catch (e) {
      console.warn("[learner-model-evidence] supabase unavailable", e?.message || e);
      sb = null;
    }
    if (!sb) {
      return res.status(200).json({ ok: true, pack, ...emptyEvidence(category, null) });
    }

    // The human name for this category, resolved the same way the portrait
    // resolves it, so the drill-in never disagrees with the row that opened it.
    const labels = await loadLabelMap(pack);
    const label = labels.get(category) || category;

    // count:"exact" gives the honest total alongside the capped page, which is
    // what lets the panel say "10 of 23" instead of implying 10 is all there is.
    let q = sb
      .from("speech_events")
      .select(
        "utterance, suggestion, explanation, severity, provenance, surface, scenario_key, created_at",
        { count: "exact" }
      )
      .eq("uid", uid)
      .eq("pack", pack)
      .in("channel", ITEM_CHANNELS);

    // The portrait buckets a null category under UNCATEGORIZED; opening that row
    // has to ask for the nulls back. Every other code is a literal match.
    q = category === UNCATEGORIZED ? q.is("category", null) : q.eq("category", category);

    const { data, error, count } = await q
      .order("created_at", { ascending: false })
      .limit(EVIDENCE_CAP);

    if (error) {
      console.warn("[learner-model-evidence] read failed", error?.message || error);
      return res.status(200).json({ ok: true, pack, ...emptyEvidence(category, label) });
    }

    const events = (Array.isArray(data) ? data : []).map(toEvent);
    // A PostgREST client that does not report a count still gives an honest
    // answer: total falls back to what we actually have.
    const total = Number.isFinite(count) && count !== null ? count : events.length;

    return res.status(200).json({
      ok: true,
      pack,
      category,
      label,
      cap: EVIDENCE_CAP,
      returned: events.length,
      total,
      truncated: total > events.length,
      events,
    });
  } catch (e) {
    console.error(
      "[learner-model-evidence] unhandled error; returning empty shape",
      e?.stack || e?.message || e
    );
    if (!res.headersSent) {
      return res.status(200).json({ ok: true, pack, ...emptyEvidence(category, null) });
    }
  }
}
