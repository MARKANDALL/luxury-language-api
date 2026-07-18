// routes/learner-model.js
// One-line: Speech Intelligence Phase 4a — the Learner Model read route. Turns the
// accumulated speech_events into a longitudinal portrait ("los patrones"): recurring
// patterns per category, a four-state trend, the crutch-word list, derived AFN, and
// strengths. Read-only; the WRITE side is routes/session-analyst.js (do NOT edit it).
//
// Cloned from the routes/word-history.js skeleton: same CORS-by-router + internal
// ADMIN_TOKEN gate, same lazy/optional Supabase (degrades to an empty-but-valid
// shape when the env is missing). Read-only: it NEVER writes a speech_events row,
// and — unlike session-analyst — it NEVER calls a model. Pure DB read + arithmetic.
//
// House laws honored (see the handover §1):
//   - Pack-neutral engine: no learner-facing Spanish/English literals live here.
//     Category labels come from lang/session-analyst/<pack>.js (read-only, whitelisted
//     pack); the AFN `reason` is a generic, pack-agnostic fallback — the frontend
//     phrases the real chip from the `n`+`trend` fields via t() (handover §5.2).
//   - Lazy + graceful Supabase: import getSupabaseAdmin inside the handler; if absent,
//     return the empty shape (never throw, never 500 on an empty learner).
//   - Admin-token gate internally AND router ADMIN_ONLY (belt-and-suspenders).
//   - Bound every read: the row scan is capped at MAX_ROWS.
//
// Contract:
//   POST { uid, pack }  ->  { ok: true, pack, model: { totals, categories[], crutchWords[], afn[], strengths } }
//   (see the handover §5.1 for the full response shape; empty learners / no Supabase
//    return the all-zero model at HTTP 200 — the panel's "start talking" state.)

export const config = {
  api: {
    bodyParser: true,
    externalResolver: true,
  },
};

// ── Bounds & tunables (readable + commented; exact values are ours to tune) ──
const MAX_ROWS = 4000;            // hard cap on the per-uid row scan (never trust the client)
const RECENT_SESSIONS = 5;        // trend window: the N most recent distinct sessions are "recent"
const MAX_CRUTCH = 8;             // keep the top ~8 crutch words
const MAX_AFN = 3;                // areas-for-next-focus: at most 3
const MAX_STRENGTHS_RECENT = 3;   // newest ~3 strengths surfaced
// "improving" = the recent per-session rate has fallen to <= 60% of the prior rate.
const IMPROVING_RATIO = 0.6;

const ITEM_CHANNELS = new Set(["grammar", "word_choice"]); // "items"; strengths are separate
const SEVERITIES = ["blocked", "noticeable", "polish"];    // item severities (positive = strengths)

// The empty model — also the graceful answer when Supabase is absent, the caller
// has no uid yet, or the learner has zero rows. Never a 500; an empty portrait is
// the correct answer, not an error.
function emptyModel() {
  return {
    totals: { sessions: 0, events: 0, firstSeen: null, lastSeen: null },
    categories: [],
    crutchWords: [],
    afn: [],
    strengths: { n: 0, recent: [] },
  };
}

// Resolve code -> label from the pack dictionary the same way the writer loads it.
// The pack is whitelisted against {'es','en'} BEFORE we get here, so the import path
// is never an unsanitized interpolation. Missing dictionary/code -> fall back to the
// raw code at the call site.
async function loadLabelMap(pack) {
  const map = new Map();
  try {
    const mod = await import(`../lang/session-analyst/${pack}.js`);
    const cats = Array.isArray(mod.categories)
      ? mod.categories
      : Array.isArray(mod.default?.categories)
        ? mod.default.categories
        : [];
    for (const c of cats) {
      if (c && c.code) map.set(c.code, c.label || c.code);
    }
  } catch (e) {
    console.warn("[learner-model] pack dictionary load failed", e?.message || e);
  }
  return map;
}

// Normalize a crutch utterance for tallying: trim, collapse inner whitespace, lowercase.
function normTerm(s) {
  return String(s || "").trim().replace(/\s+/g, " ").toLowerCase();
}

// Whole days between an ISO timestamp and `nowMs` (never negative).
function daysSince(iso, nowMs) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((nowMs - t) / 86400000));
}

// Newest-first comparator over created_at ISO strings (Postgres serializes this
// column uniformly, so a lexical compare orders it correctly — same posture as
// word-history.js sorting created_at as strings).
function byCreatedDesc(a, b) {
  const ta = a?.created_at || "";
  const tb = b?.created_at || "";
  return ta < tb ? 1 : ta > tb ? -1 : 0;
}

// The four-state trend from a category's recent-vs-prior split.
//  - emerging   : no prior rows (first-ever occurrence is inside the recent window)
//  - resolved   : prior rows exist, ZERO in the recent window
//  - improving  : present in both, recent per-session rate meaningfully below prior
//  - persistent : present in both at a similar rate
function computeTrend({ recentCount, priorCount, recentSessions, priorSessions }) {
  if (priorCount === 0) return "emerging";
  if (recentCount === 0) return "resolved";
  const recentRate = recentCount / Math.max(1, recentSessions);
  const priorRate = priorCount / Math.max(1, priorSessions);
  if (recentRate <= priorRate * IMPROVING_RATIO) return "improving";
  return "persistent";
}

// Generic, pack-agnostic fallback phrasing for an AFN chip. House law 1 keeps
// learner-facing COPY in the packs, but no pack string phrases a trend; §5.2 both
// sanctions a generic phrase here AND asks us to expose `n`+`trend` so the frontend
// phrases the real chip via t(). This English string is the last-resort fallback,
// never the source of truth for the UI. NO Spanish is hardcoded.
function afnReason(n, trend) {
  const times = `${n}×`;
  switch (trend) {
    case "emerging":
      return `${times}, newly appearing`;
    case "improving":
      return `${times}, improving`;
    case "persistent":
      return `${times}, still recurring`;
    default:
      return times;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure aggregation over the fetched rows. Exported for deterministic unit tests
// (pass a fixed `nowMs` so recencyDays/salience are reproducible). The handler
// calls it with Date.now().
// ─────────────────────────────────────────────────────────────────────────────
export function aggregateSpeechEvents(rows, labels = new Map(), nowMs = Date.now()) {
  const all = Array.isArray(rows) ? rows.filter(Boolean) : [];
  if (!all.length) return emptyModel();

  // Split items (grammar/word_choice) from strengths.
  const items = [];
  const strengthRows = [];
  for (const r of all) {
    if (r.channel === "strength") strengthRows.push(r);
    else if (ITEM_CHANNELS.has(r.channel)) items.push(r);
  }

  // ── totals ──
  // sessions = distinct non-null session_id across ALL rows (any session that produced
  //            a speech event counts). events = item rows only. first/last = over items.
  const sessionSet = new Set();
  for (const r of all) if (r.session_id) sessionSet.add(r.session_id);
  let firstSeen = null;
  let lastSeen = null;
  for (const r of items) {
    const ts = r.created_at;
    if (!ts) continue;
    if (!firstSeen || ts < firstSeen) firstSeen = ts;
    if (!lastSeen || ts > lastSeen) lastSeen = ts;
  }
  const totals = {
    sessions: sessionSet.size,
    events: items.length,
    firstSeen,
    lastSeen,
  };

  // ── recency window (session-based) ──
  // Rank distinct non-null item sessions by their latest created_at; the
  // RECENT_SESSIONS most-recent form the "recent" window. A boundary timestamp lets
  // the rare null-session row still be bucketed by time.
  const sessionLatest = new Map(); // session_id -> max created_at
  for (const r of items) {
    if (!r.session_id || !r.created_at) continue;
    const prev = sessionLatest.get(r.session_id);
    if (!prev || r.created_at > prev) sessionLatest.set(r.session_id, r.created_at);
  }
  const ranked = [...sessionLatest.entries()].sort((a, b) =>
    a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0
  );
  const recentSessionIds = new Set(ranked.slice(0, RECENT_SESSIONS).map(([id]) => id));
  const recentSessions = recentSessionIds.size;
  const priorSessions = Math.max(0, ranked.length - recentSessions);
  // Latest created_at of the OLDEST recent session; a null-session row at/after this
  // instant is "recent". Null when the learner has no session-keyed rows at all.
  const boundaryTs = recentSessions ? ranked[recentSessions - 1][1] : null;

  const isRecent = (r) => {
    if (r.session_id) return recentSessionIds.has(r.session_id);
    if (boundaryTs && r.created_at) return r.created_at >= boundaryTs;
    return true; // no session-keyed history to compare against -> treat as recent
  };

  // ── categories[] (items grouped by category) ──
  const byCat = new Map();
  for (const r of items) {
    const code = r.category || "(uncategorized)";
    let g = byCat.get(code);
    if (!g) {
      g = { code, channel: r.channel, rows: [] };
      byCat.set(code, g);
    }
    g.rows.push(r);
  }

  const categories = [];
  for (const g of byCat.values()) {
    const rowsSorted = g.rows.slice().sort(byCreatedDesc); // newest first
    const n = rowsSorted.length;

    let cFirst = null;
    let cLast = null;
    const severityMix = { blocked: 0, noticeable: 0, polish: 0 };
    let recentCount = 0;
    let priorCount = 0;
    for (const r of rowsSorted) {
      const ts = r.created_at;
      if (ts) {
        if (!cFirst || ts < cFirst) cFirst = ts;
        if (!cLast || ts > cLast) cLast = ts;
      }
      if (r.severity && SEVERITIES.includes(r.severity)) severityMix[r.severity] += 1;
      if (isRecent(r)) recentCount += 1;
      else priorCount += 1;
    }

    const recencyDays = cLast ? daysSince(cLast, nowMs) : 0;
    const newest = rowsSorted[0] || {};
    const lastExample = {
      utterance: newest.utterance || null,
      suggestion: newest.suggestion || null,
      explanation: newest.explanation || null,
    };
    const trend = computeTrend({ recentCount, priorCount, recentSessions, priorSessions });

    // salience = n_weighted × recency_factor × severity_weight
    //   n_weighted     = ln(1 + n)                     (diminishing returns on count)
    //   recency_factor = 1 / (1 + recencyDays/7)       (this week counts full; a month decays)
    //   severity_weight= 1 + 0.5·blocked_share + 0.25·noticeable_share
    const blockedShare = n ? severityMix.blocked / n : 0;
    const noticeableShare = n ? severityMix.noticeable / n : 0;
    const nWeighted = Math.log(1 + n);
    const recencyFactor = 1 / (1 + recencyDays / 7);
    const severityWeight = 1 + 0.5 * blockedShare + 0.25 * noticeableShare;
    const salience = nWeighted * recencyFactor * severityWeight;

    categories.push({
      code: g.code,
      label: labels.get(g.code) || g.code, // fall back to the raw code if unmapped
      channel: g.channel,
      n,
      firstSeen: cFirst,
      lastSeen: cLast,
      recencyDays,
      trend,
      severityMix,
      lastExample,
      _salience: salience,
    });
  }
  categories.sort((a, b) => b._salience - a._salience);

  // ── afn[] (derived longitudinally): top <=3 non-resolved categories by salience ──
  const afn = categories
    .filter((c) => c.trend !== "resolved")
    .slice(0, MAX_AFN)
    .map((c) => ({
      code: c.code,
      label: c.label,
      n: c.n,
      trend: c.trend,
      reason: afnReason(c.n, c.trend),
    }));

  // Drop the internal sort key from the public shape.
  for (const c of categories) delete c._salience;

  // ── crutchWords[] (word_choice / crutch_words, normalized + tallied) ──
  const crutchMap = new Map(); // term -> { term, n, lastSeen }
  for (const r of items) {
    if (r.channel !== "word_choice" || r.category !== "crutch_words") continue;
    const term = normTerm(r.utterance);
    if (!term) continue;
    const e = crutchMap.get(term) || { term, n: 0, lastSeen: null };
    e.n += 1;
    if (r.created_at && (!e.lastSeen || r.created_at > e.lastSeen)) e.lastSeen = r.created_at;
    crutchMap.set(term, e);
  }
  const crutchWords = [...crutchMap.values()]
    .sort((a, b) => b.n - a.n || byCreatedDesc({ created_at: a.lastSeen }, { created_at: b.lastSeen }))
    .slice(0, MAX_CRUTCH);

  // ── strengths (channel='strength') ──
  const strengthsSorted = strengthRows.slice().sort(byCreatedDesc);
  const strengths = {
    n: strengthRows.length,
    recent: strengthsSorted.slice(0, MAX_STRENGTHS_RECENT).map((r) => ({
      utterance: r.utterance || null,
      note: r.explanation || null,
      lastSeen: r.created_at || null,
    })),
  };

  return { totals, categories, crutchWords, afn, strengths };
}

export default async function handler(req, res) {
  // 1) CORS / method (router also handles CORS + the admin gate; mirror word-info)
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  // 2) ADMIN_TOKEN gate (belt-and-suspenders with the router)
  const token =
    (req.headers["x-admin-token"] || "").toString().trim() ||
    (req.query?.token || "").toString().trim();
  const expected = (process.env.ADMIN_TOKEN || "").toString().trim();
  if (!expected || token !== expected) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  // 3) Validate input. pack -> whitelist {'es','en'}, default 'en'. uid is a STRING,
  // sliced but NOT UUID-validated (reads must key identically to how the analyst wrote).
  const body = req.body || {};
  const uid = (body.uid || "").toString().trim().slice(0, 80);
  const pack = (body.pack || "en").toString().trim() === "es" ? "es" : "en";

  // 4) Supabase (lazy, optional — never let a read break the panel)
  let sb = null;
  try {
    const { getSupabaseAdmin } = await import("../lib/supabase.js");
    sb = getSupabaseAdmin();
  } catch {
    sb = null; // env not configured; degrade gracefully
  }

  // Missing Supabase or no uid yet -> the empty portrait is the correct answer, not
  // an error (the panel calls this before the user has done anything).
  if (!sb || !uid) {
    return res.status(200).json({ ok: true, pack, model: emptyModel() });
  }

  // 5) Read (bounded) + aggregate. Any failure logs a warning and returns the empty
  // shape — never a 500 on the learner-model surface.
  try {
    const { data, error } = await sb
      .from("speech_events")
      .select(
        "session_id, channel, category, severity, utterance, suggestion, explanation, created_at"
      )
      .eq("uid", uid)
      .eq("pack", pack)
      .order("created_at", { ascending: false })
      .limit(MAX_ROWS);

    if (error) {
      console.warn("[learner-model] read failed", error?.message || error);
      return res.status(200).json({ ok: true, pack, model: emptyModel() });
    }

    const rows = Array.isArray(data) ? data : [];
    if (!rows.length) {
      return res.status(200).json({ ok: true, pack, model: emptyModel() });
    }

    const labels = await loadLabelMap(pack);
    const model = aggregateSpeechEvents(rows, labels, Date.now());
    return res.status(200).json({ ok: true, pack, model });
  } catch (e) {
    console.warn("[learner-model] aggregation failed", e?.message || e);
    return res.status(200).json({ ok: true, pack, model: emptyModel() });
  }
}
