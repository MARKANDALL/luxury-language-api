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

  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  const supabaseKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.SUPABASE_SERVICE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    "";

  if (!supabaseUrl || !supabaseKey) return null;

  try {
    const supabase = getSupabaseAdmin({ url: supabaseUrl, key: supabaseKey });

    const { data, error } = await supabase
      .from("lux_attempts")
      .select("summary, created_at")
      .eq("uid", uid)
      .order("created_at", { ascending: false })
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
      if (lows && typeof lows === "object" && !Array.isArray(lows)) {
        for (const [k, v] of Object.entries(lows)) {
          const n = safeNum(v) || 0;
          if (!k) continue;
          phonemeCounts[k] = (phonemeCounts[k] || 0) + n;
        }
      }

      const words = summary?.words;
      if (words && typeof words === "object") {
        if (Array.isArray(words)) {
          for (const item of words) {
            if (typeof item === "string") {
              wordCounts[item] = (wordCounts[item] || 0) + 1;
            } else if (item && typeof item === "object") {
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