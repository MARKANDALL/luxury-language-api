// routes/pronunciation-gpt/historySummary.js
// ONE-LINE: Optional Supabase-powered history summary injection (every 3rd attempt / includeHistory) for coaching prompts.

import { getSupabaseAdmin } from '../../lib/supabase.js';

export async function computeHistorySummaryIfNeeded(
  { safeNum, extractPronScore },
  { mode, chunk, includeHistory, attemptId, uid }
) {
  // Only for DeepDive and only on chunk 1
  if (mode === "simple") return null;
  if ((Number(chunk) || 1) !== 1) return null;
  if (!uid) return null;

  const attemptNum = safeNum(attemptId);
  const includeByRule =
    includeHistory === true ||
    (attemptNum != null && attemptNum % 3 === 0);

  if (!includeByRule) return null;

  try {
    // Use the shared admin client instead of a bespoke key chain. That chain
    // omitted SUPABASE_SERVICE_ROLE (and SUPABASE_SERVICE_ROLE_KEY_JWT), so on an
    // environment where only SUPABASE_SERVICE_ROLE is set — which is prod — it
    // resolved to nothing and this function bailed at its own url/key guard: the
    // coaching history never loaded, including item 1's trouble words/phonemes.
    // getSupabaseAdmin() resolves the service-role key in the canonical order
    // (SUPABASE_SERVICE_ROLE first) and warns loudly if it must fall back to anon.
    // If the env is genuinely unconfigured it throws, and the catch below degrades
    // to null exactly as the old guard did.
    const supabase = getSupabaseAdmin();

    // Order by `ts`, the column attempt.js populates on insert and that every
    // other lux_attempts reader uses (user-recent, admin-recent, admin-user-stats,
    // convo-report, word-history). This was the lone outlier ordering by
    // `created_at`; aligning it keeps the "recent attempts" window consistent
    // across the codebase. See backend-hygiene item 3.
    const { data, error } = await supabase
      .from("lux_attempts")
      .select("summary, ts")
      .eq("uid", uid)
      .order("ts", { ascending: false })
      .limit(40);

    if (error) {
      console.warn("[AI Coach] History query error:", error);
      return null;
    }

    const rows = Array.isArray(data) ? data : [];
    if (!rows.length) return null;

    const phonemeCounts = {};
    const wordCounts = {};
    const pronScores = [];

    for (const row of rows) {
      const summary = row?.summary || null;

      const lows = summary?.lows;
      if (lows && typeof lows === "object") {
        if (Array.isArray(lows)) {
          for (const item of lows) {
            if (typeof item === "string") {
              // Legacy: a bare phoneme string.
              phonemeCounts[item] = (phonemeCounts[item] || 0) + 1;
            } else if (Array.isArray(item)) {
              // Writer's real shape: compact pair [phoneme, score] emitted by
              // attempt.js toSummaryFromAzure for the lowest-scoring phonemes.
              // The old reader only handled non-array objects, so every pair was
              // skipped and the trouble-phoneme list came back empty. NOTE the
              // pair carries a SCORE, not a count, so each appearance weighs 1 —
              // topTroublePhonemes ranks by how often a phoneme lands in the
              // bottom set, never by its score.
              const k = typeof item[0] === "string" ? item[0].trim() : "";
              if (k) phonemeCounts[k] = (phonemeCounts[k] || 0) + 1;
            } else if (item && typeof item === "object") {
              // Legacy: an object row { phoneme|p, count? }.
              const k = item.phoneme || item.p || "";
              const c = safeNum(item.count) || 1;
              if (k) phonemeCounts[k] = (phonemeCounts[k] || 0) + c;
            }
          }
        } else {
          for (const [k, v] of Object.entries(lows)) {
            const n = safeNum(v) || 0;
            if (!k) continue;
            phonemeCounts[k] = (phonemeCounts[k] || 0) + n;
          }
        }
      }

      const words = summary?.words;
      if (words && typeof words === "object") {
        if (Array.isArray(words)) {
          for (const item of words) {
            if (typeof item === "string") {
              // Legacy: a bare word string.
              wordCounts[item] = (wordCounts[item] || 0) + 1;
            } else if (Array.isArray(item)) {
              // Writer's real shape: compact triple [word, score, count] emitted
              // by attempt.js toSummaryFromAzure for the bottom-10 trouble words.
              // The old reader only understood {word,...} objects, so every triple
              // fell through to "" and the trouble-word list came back empty.
              const w = typeof item[0] === "string" ? item[0].trim() : "";
              const c = safeNum(item[2]) || 1;
              if (w) wordCounts[w] = (wordCounts[w] || 0) + c;
            } else if (item && typeof item === "object") {
              // Legacy: an object row { word|text|w, count? }.
              const w = item.word || item.text || item.w || "";
              const c = safeNum(item.count) || 1;
              if (w) wordCounts[w] = (wordCounts[w] || 0) + c;
            }
          }
        } else {
          for (const [k, v] of Object.entries(words)) {
            const n = safeNum(v) || 0;
            if (!k) continue;
            wordCounts[k] = (wordCounts[k] || 0) + n;
          }
        }
      }

      const ps = extractPronScore(summary);
      if (ps != null) pronScores.push(ps);
    }

    const topTroublePhonemes = Object.entries(phonemeCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([k]) => k);

    const topTroubleWords = Object.entries(wordCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([k]) => k);

    let pronDeltaLast5 = null;
    if (pronScores.length >= 6) {
      const last5 = pronScores.slice(0, 5);
      const prev5 = pronScores.slice(5, 10);
      const avg = (arr) => arr.reduce((s, x) => s + x, 0) / Math.max(1, arr.length);
      pronDeltaLast5 = Number((avg(last5) - avg(prev5)).toFixed(2));
    }

    return {
      topTroublePhonemes,
      topTroubleWords,
      pronDeltaLast5,
    };
  } catch (e) {
    console.warn("[AI Coach] History summary unavailable:", e);
    return null;
  }
}