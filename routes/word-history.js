// routes/word-history.js
// One-line: Word Motor Wave 4 (W4-A) — the learner's own history with a single
// word, for the card's "You and this word" personal block.
//
// Cloned from the routes/word-info.js skeleton: same CORS-by-router + internal
// ADMIN_TOKEN gate, same lazy/optional Supabase (degrades gracefully when the
// env is missing). Read-only: it NEVER writes a word_taps row (history reads are
// not taps — decision 8), and it never calls a model.
//
// Contract:
//   POST { uid, word, lang }
//   ->   { ok: true, history: {
//            taps,                 // number of real taps on this word
//            firstSeen, lastSeen,  // ISO timestamps (or null)
//            surfaces,             // distinct Word Motor surfaces it was tapped from
//            saved,                // is it in My Words (my_words_entries)?
//            scores: { count, avg, last } | null  // from lux_attempts, if derivable
//          } }
//
// Sources (all read through the one Supabase admin client — every table below is
// a PostgREST-exposed public table, so no second DB client is needed and the
// no-Supabase degrade stays uniform):
//   - word_taps        → taps / firstSeen / lastSeen / surfaces
//   - my_words_entries → saved
//   - lux_attempts     → scores (scanned from summary.words; see note below)
//
// scores caveat (disclosed in the handover): lux_attempts.summary.words keeps
// only each attempt's LOWEST-scoring ~10 words, so a word's average here skews
// toward the learner's weaker attempts and a well-said word may be absent. It is
// still the honest best-effort per decision 7 ("JSON payloads count").

export const config = {
  api: {
    bodyParser: true,
    externalResolver: true,
  },
};

const MAX_ATTEMPTS_SCAN = 200; // cheap per-uid scan bound for the scores summary

// Mirror the frontend My Words normalizer (features/my-words/normalize.js) so a
// saved-status lookup keys the same way the Save button wrote the row.
function normText(s) {
  return String(s || "").trim().replace(/\s+/g, " ").toLowerCase();
}

// Pull the target word's score out of one attempt's compact summary. The words
// row shape is [word, score, count] (see routes/attempt.js toSummaryFromAzure).
function scoreForWord(summary, wordLc) {
  const words = summary && Array.isArray(summary.words) ? summary.words : [];
  for (const row of words) {
    if (!Array.isArray(row) || row.length < 2) continue;
    const w = String(row[0] == null ? "" : row[0]).trim().toLowerCase();
    if (w !== wordLc) continue;
    const s = Number(row[1]);
    if (Number.isFinite(s)) return s;
  }
  return null;
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

  // 3) Validate input
  const body = req.body || {};
  const word = (body.word || "").toString().trim().slice(0, 60);
  const lang = (body.lang || "en").toString().trim() === "es" ? "es" : "en";
  const uid = (body.uid || "").toString().trim().slice(0, 80);

  if (!word) {
    return res.status(400).json({ ok: false, error: "bad_request", detail: "word required" });
  }

  const wordLc = word.toLowerCase();

  // The empty history shape — also the graceful answer when Supabase is absent
  // or the caller has no uid yet (nothing to look up).
  const emptyHistory = {
    taps: 0,
    firstSeen: null,
    lastSeen: null,
    surfaces: [],
    saved: false,
    scores: null,
  };

  // 4) Supabase (lazy, optional — never let a read break the card)
  let sb = null;
  try {
    const { getSupabaseAdmin } = await import("../lib/supabase.js");
    sb = getSupabaseAdmin();
  } catch {
    sb = null; // env not configured; degrade gracefully
  }

  if (!sb || !uid) {
    return res.status(200).json({ ok: true, history: emptyHistory });
  }

  const history = { ...emptyHistory };

  // 4a) word_taps → taps / firstSeen / lastSeen / surfaces.
  // word_taps.word is stored with its original case (word-info inserts the raw
  // trimmed token), so match case-insensitively.
  try {
    const { data, error } = await sb
      .from("word_taps")
      .select("surface, created_at")
      .eq("uid", uid)
      .eq("lang", lang)
      .ilike("word", wordLc);
    if (!error && Array.isArray(data) && data.length) {
      history.taps = data.length;
      const times = data
        .map((r) => r.created_at)
        .filter(Boolean)
        .sort();
      if (times.length) {
        history.firstSeen = times[0];
        history.lastSeen = times[times.length - 1];
      }
      history.surfaces = [...new Set(data.map((r) => r.surface).filter(Boolean))];
    }
  } catch (e) {
    console.warn("[word-history] taps read failed", e?.message || e);
  }

  // 4b) my_words_entries → saved (non-archived entry present for this uid).
  try {
    const { data, error } = await sb
      .from("my_words_entries")
      .select("id, archived")
      .eq("uid", uid)
      .eq("normalized_text", normText(word))
      .limit(1);
    if (!error && Array.isArray(data) && data.length) {
      history.saved = !data[0].archived;
    }
  } catch (e) {
    console.warn("[word-history] saved read failed", e?.message || e);
  }

  // 4c) lux_attempts → scores (scan summary.words for this word).
  try {
    const { data, error } = await sb
      .from("lux_attempts")
      .select("summary, ts")
      .eq("uid", uid)
      .order("ts", { ascending: false })
      .limit(MAX_ATTEMPTS_SCAN);
    if (!error && Array.isArray(data) && data.length) {
      const scores = [];
      let last = null;
      for (const row of data) {
        const s = scoreForWord(row.summary, wordLc);
        if (s == null) continue;
        if (last == null) last = s; // rows are newest-first
        scores.push(s);
      }
      if (scores.length) {
        const avg = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
        history.scores = { count: scores.length, avg, last };
      }
    }
  } catch (e) {
    console.warn("[word-history] scores read failed", e?.message || e);
  }

  return res.status(200).json({ ok: true, history });
}
