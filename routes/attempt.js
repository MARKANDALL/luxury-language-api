// file: /api/attempt.js
// Accept attempt payloads and insert into Postgres (table: public.lux_attempts)

import { pool } from "../lib/pool.js";
import { safeNum } from "./pronunciation-gpt/scoring.js";

// ---------- Helpers ----------
function toIso(x) {
  try {
    return x ? new Date(x).toISOString() : new Date().toISOString();
  } catch {
    return new Date().toISOString();
  }
}

// A phoneme occurrence counts as "low" below 80. This is NOT a new threshold:
// it is the exact test the only reader of the field below already applies to
// the field it stands beside (features/progress/rollups/rollupsAccumulate.js:265,
// and :161 on the full-Azure path), copied here so the preferred branch counts
// lows the same way the fallback branch does and the Progress explainer's
// "N of M scored below 80%" keeps meaning what it has always meant.
const PHONEME_LOW_BELOW = 80;

// A real utterance cannot contain this many DISTINCT phonemes in any language
// Lux serves — English has about 44, Spanish about 25. The ceiling exists only
// so a malformed or hostile payload cannot write an unbounded object into a
// column with no size guard of its own. Past it the field is dropped WHOLE
// rather than sampled, because a partial sample is the exact defect this field
// exists to remove; readers then fall back to `lows`, which is today's
// behaviour, so nothing breaks and nothing is quietly biased.
const SUMMARY_PHONEME_MAX_KEYS = 256;

// { phoneme: { occ, avg, low } } over every scored phoneme, or null.
// occ is how many times the phoneme was scored in this attempt, avg its mean
// across those occurrences to one decimal, low how many fell below
// PHONEME_LOW_BELOW. Storing occ + avg rather than the raw list is exact for
// averaging — a reader's sum += avg * occ recovers the true mean — and bounds
// the field by the language's phoneme inventory instead of by how long the
// learner spoke.
function toPhonemeStats(phScores) {
  if (!phScores.length) return null;

  const agg = new Map();
  for (const { p, s } of phScores) {
    const cur = agg.get(p) || { occ: 0, sum: 0, low: 0 };
    cur.occ += 1;
    cur.sum += s;
    if (s < PHONEME_LOW_BELOW) cur.low += 1;
    agg.set(p, cur);
  }
  if (agg.size > SUMMARY_PHONEME_MAX_KEYS) return null;

  const phonemes = {};
  for (const [p, v] of agg) {
    phonemes[p] = {
      occ: v.occ,
      avg: Math.round((v.sum / v.occ) * 10) / 10,
      low: v.low,
    };
  }
  return { phonemes };
}

// Build a compact summary for admin UI from Azure JSON
function toSummaryFromAzure(result) {
  // Defensive defaults
  const nb = result?.NBest?.[0] || {};
  const pa = nb?.PronunciationAssessment || result?.PronunciationAssessment || {};
  const ca = nb?.ContentAssessment || result?.ContentAssessment || {};

  const pron =
    safeNum(nb?.PronScore ?? pa?.PronunciationScore ?? pa?.PronScore) ?? null;
  const acc = safeNum(nb?.AccuracyScore ?? pa?.AccuracyScore) ?? null;
  const flu = safeNum(nb?.FluencyScore ?? pa?.FluencyScore) ?? null;
  const comp = safeNum(nb?.CompletenessScore ?? pa?.CompletenessScore) ?? null;

  const words = Array.isArray(nb?.Words) ? nb.Words : [];

  // trouble phonemes (lowest 6 by score)
  const phScores = [];
  for (const w of words) {
    const phs = Array.isArray(w?.Phonemes) ? w.Phonemes : [];
    for (const p of phs) {
      const key = String(p?.Phoneme || "").trim();
      const score = safeNum(p?.AccuracyScore);
      if (!key || score == null) continue;
      phScores.push({ p: key, s: score });
    }
  }
  phScores.sort((a, b) => a.s - b.s);
  const lows = phScores.slice(0, 6).map((x) => [x.p, x.s]);

  // Every scored phoneme of the attempt, beside the six above.
  //
  // `lows` is the SIX LOWEST phonemes, and it is the only phoneme record the
  // Progress page can reach: routes/user-recent.js selects `summary` and no
  // Azure column, so every rollup downstream averages a deliberately
  // worst-picked sample. A learner who says /eɪ/ three times at 95, 92 and 78
  // has 78 stored, attempt after attempt, and is told /eɪ/ is a trouble sound
  // when its real average is 88.
  //
  // This writes the true distribution in the shape the rollups ALREADY prefer:
  // features/progress/rollups/rollupsAccumulate.js:206-241 reads
  // summary.stats.phonemes as { ipa: {occ, avg, low} } and only falls back to
  // `lows` when it is absent. So `lows` stays exactly as it was for its other
  // readers, rows written before today keep working on the fallback branch, and
  // new rows get the real average with no frontend change.
  const stats = toPhonemeStats(phScores);

  // trouble words (aggregate avg by word, lowest 10)
  const wordAgg = new Map();
  for (const w of words) {
    const key = String(w?.Word || w?.word || "").trim().toLowerCase();
    const s = safeNum(w?.AccuracyScore);
    if (!key || s == null) continue;
    const cur = wordAgg.get(key) || { sum: 0, n: 0 };
    cur.sum += s;
    cur.n += 1;
    wordAgg.set(key, cur);
  }
  const wordRows = Array.from(wordAgg.entries()).map(([w, { sum, n }]) => ({
    w,
    s: Math.round(sum / Math.max(1, n)),
    n,
  }));
  wordRows.sort((a, b) => a.s - b.s);
  const wordsLow = wordRows.slice(0, 10).map((r) => [r.w, r.s, r.n]);

  // `stats` is omitted rather than written empty, so a reader's "is it there"
  // test keeps meaning "this row carries the real distribution".
  return {
    pron,
    acc,
    flu,
    comp,
    lows,
    words: wordsLow,
    ...(stats ? { stats } : {}),
  };
}

// ---------- Full Azure detail (additive capture) ----------
//
// toSummaryFromAzure above keeps the ten lowest words and six lowest phonemes
// and throws the rest away, so nothing downstream can say what the learner
// actually said, in what order, or when. This builds the record that can:
// the recognition fields, whether the attempt was scripted, and every word in
// SPOKEN ORDER with its timings, ErrorType, syllables and phonemes.
//
// It is a pure function of the Azure payload the client already posts as
// azureResult, and it does not read or write `summary`.

// Serialized ceiling for one attempt's azure_detail. Past this the phoneme
// layer is dropped rather than writing an unbounded row or failing the attempt.
const AZURE_DETAIL_MAX_BYTES = 64 * 1024;

// Azure puts per-item scores either flat on the item or nested under
// PronunciationAssessment, depending on granularity and API version, and both
// shapes are already handled by frontend readers (features/convo/word-feedback/
// align-plan.js:15, features/progress/rollups/rollupsAccumulate.js:30). Read
// both, and return undefined rather than null when neither is present:
// safeNum(null) is 0, so a null here would turn a missing score into a real
// zero, which reads downstream as a total failure rather than as "not scored".
function azField(item, name) {
  return item?.[name] ?? item?.PronunciationAssessment?.[name];
}

// SNR arrives at the TOP LEVEL of the result, a sibling of DisplayText and
// NBest, not inside the pronunciation assessment: a live en-US capture on
// 3 September returned {RecognitionStatus, Offset, Duration, DisplayText, SNR,
// NBest}. Azure has carried it elsewhere across versions, so the other two
// positions are probed as a fallback and null is stored when it is genuinely
// absent, rather than inventing a number.
function azSnr(result, nb) {
  return (
    azField(nb, "SNR") ??
    result?.SNR ??
    result?.AudioSourceInfo?.SNR
  );
}

function trimAzureWord(w, withPhonemes) {
  const errorType = azField(w, "ErrorType");
  const syllables = Array.isArray(w?.Syllables) ? w.Syllables : [];
  const phonemes = Array.isArray(w?.Phonemes) ? w.Phonemes : [];

  return {
    word: String(w?.Word ?? w?.word ?? ""),
    offset: safeNum(w?.Offset),
    duration: safeNum(w?.Duration),
    accuracy: safeNum(azField(w, "AccuracyScore")),
    error_type: typeof errorType === "string" && errorType ? errorType : null,
    syllables: syllables.map((s) => ({
      syllable: String(s?.Syllable ?? ""),
      grapheme: typeof s?.Grapheme === "string" ? s.Grapheme : null,
      offset: safeNum(s?.Offset),
      duration: safeNum(s?.Duration),
      accuracy: safeNum(azField(s, "AccuracyScore")),
    })),
    // NBestPhonemes (Azure's per-phoneme alternative candidate lists) and the
    // per-word prosody Feedback blocks are dropped on purpose: together they
    // are the bulk of the payload and nothing in scope reads either.
    phonemes: withPhonemes
      ? phonemes.map((p) => ({
          phoneme: String(p?.Phoneme ?? ""),
          offset: safeNum(p?.Offset),
          duration: safeNum(p?.Duration),
          accuracy: safeNum(azField(p, "AccuracyScore")),
        }))
      : [],
  };
}

function azureDetailBytes(detail) {
  return Buffer.byteLength(JSON.stringify(detail), "utf8");
}

function toAzureDetail(result, sentReference) {
  if (!result || typeof result !== "object") return null;

  const nb = result?.NBest?.[0] || {};
  const words = Array.isArray(nb?.Words) ? nb.Words : [];
  const reference = typeof sentReference === "string" ? sentReference.trim() : "";

  const base = {
    lexical: typeof nb?.Lexical === "string" ? nb.Lexical : null,
    display:
      (typeof nb?.Display === "string" && nb.Display) ||
      (typeof result?.DisplayText === "string" ? result.DisplayText : null),
    confidence: safeNum(nb?.Confidence),
    snr: safeNum(azSnr(result, nb)),
    // Offset and Duration of the whole utterance, in Azure's 100-nanosecond
    // ticks, same unit as every per-word offset below.
    offset: safeNum(result?.Offset ?? nb?.Offset),
    duration: safeNum(result?.Duration ?? nb?.Duration),
    // Scripted means a ReferenceText was sent, so Azure ALIGNED against a
    // script rather than transcribing freely. That is what makes phantom
    // Insertion words possible, so a transcript reader needs to know it, and
    // needs the script itself to show what was asked against what was said.
    scripted: reference.length > 0,
    reference_text: reference || null,
  };

  const full = { ...base, words: words.map((w) => trimAzureWord(w, true)) };
  if (azureDetailBytes(full) <= AZURE_DETAIL_MAX_BYTES) return full;

  // Over the ceiling: keep every word and every timing, drop the phoneme layer.
  const lean = words.map((w) => trimAzureWord(w, false));
  const trimmed = { ...base, truncated: true, words: lean };
  if (azureDetailBytes(trimmed) <= AZURE_DETAIL_MAX_BYTES) return trimmed;

  // Still over with no phonemes at all. A recorder-length attempt cannot reach
  // here, but the row must be bounded whatever arrives, so clamp the word list
  // and say how many words were lost rather than write without a ceiling.
  let keep = lean.length;
  while (keep > 0) {
    keep = Math.floor(keep * 0.8);
    const clamped = {
      ...base,
      truncated: true,
      words_dropped: lean.length - keep,
      words: lean.slice(0, keep),
    };
    if (azureDetailBytes(clamped) <= AZURE_DETAIL_MAX_BYTES) return clamped;
  }
  return { ...base, truncated: true, words_dropped: lean.length, words: [] };
}

// Postgres SQLSTATE 42703, undefined_column. The two columns above are added by
// migrations/0010_attempt_azure_detail.sql, and migrations in this repo are
// applied by hand, so a deploy can reach a database that does not have them yet.
const UNDEFINED_COLUMN = "42703";

// The pre-0010 write, kept verbatim. Its parameters are the first seven of the
// full insert's, in the same order, so both statements share one params array.
const LEGACY_ATTEMPT_SQL = `
  INSERT INTO public.lux_attempts
    (uid, ts, passage_key, part_index, text, summary, session_id)
  VALUES
    ($1, $2::timestamptz, $3, $4, $5, $6::jsonb, $7)
  RETURNING id
`;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method Not Allowed" });
    return;
  }

  try {
    const body =
      typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};

    // ---- Accept both legacy and new shapes ----
    const uid = body.uid || body.userId || null;
    const passageKey =
      body.passageKey || body.passage_key || body.passage || "unknown";
    const partIndex =
      body.partIndex != null ? Number(body.partIndex) : Number(body.part ?? 0);
    const text =
      body.text ||
      body.referenceText ||
      body.azureResult?.DisplayText ||
      body.azureResult?.NBest?.[0]?.Display ||
      "";

    // --- NEW: accept sessionId (both shapes) ---
    const sessionId = body.sessionId || body.session_id || null;

    // Prefer client-sent localTime if present
    const ts = toIso(body.localTime || body.ts);

    // summary:
    // Merge server-derived base summary (Azure) with client extensions (meta/stats/AI artifacts).
    const azureObj =
      body.azureResult && typeof body.azureResult === "object"
        ? body.azureResult
        : null;

    // Back-compat fallback shape (used when no Azure and/or when client sends flat fields)
    const flatBaseline = {
      pron: safeNum(body.pron),
      acc: safeNum(body.acc),
      flu: safeNum(body.flu),
      comp: safeNum(body.comp),
      lows: Array.isArray(body.lows) ? body.lows : [],
      words: Array.isArray(body.words) ? body.words : [],
    };
    const hasFlat =
      flatBaseline.pron != null ||
      flatBaseline.acc != null ||
      flatBaseline.flu != null ||
      flatBaseline.comp != null ||
      (flatBaseline.lows && flatBaseline.lows.length) ||
      (flatBaseline.words && flatBaseline.words.length);

    // Start with the server-derived summary when we have Azure, else fall back to the flat baseline.
    let summary = azureObj ? toSummaryFromAzure(azureObj) : flatBaseline;

    // Prefer merging client summary (meta/stats/etc) on top of base summary.
    if (body.summary && typeof body.summary === "object") {
      summary = { ...summary, ...body.summary };
    } else if (azureObj && hasFlat) {
      // Rare: allow flat fields to extend/override when Azure exists but no summary object was sent
      summary = { ...summary, ...flatBaseline };
    }

    // Optional: persist raw Azure only when explicitly requested (never returned by user-recent).
    if (body.storeRawAzure === true && azureObj) {
      const raw = summary.raw && typeof summary.raw === "object" ? summary.raw : {};
      if (!raw.azure) raw.azure = azureObj;
      summary.raw = raw;
    }

    if (!uid) return res.status(400).json({ ok: false, error: "missing_uid" });

    // The full record of this attempt, trimmed here on the server so a client
    // cannot post an unbounded blob. Derived from the same azureResult the
    // summary above is derived from; `summary` itself is not touched.
    //
    // The reference text is read from the raw body rather than from the `text`
    // variable built above, because that one falls back to Azure's own
    // DisplayText when the client sent nothing, which would label an unscripted
    // attempt as scripted against a script it was never given.
    const sentReference =
      (typeof body.referenceText === "string" && body.referenceText) ||
      (typeof body.text === "string" && body.text) ||
      "";
    const azureDetail = toAzureDetail(azureObj, sentReference);
    const recognizedText = azureDetail?.display || null;

    const row = {
      uid,
      ts,
      passage_key: passageKey,
      part_index: Number.isFinite(partIndex) ? partIndex : 0,
      text,
      summary: summary || {},
      session_id: sessionId,
      recognized_text: recognizedText,
      azure_detail: azureDetail,
    };

    // Insert
    const sql = `
      INSERT INTO public.lux_attempts
        (uid, ts, passage_key, part_index, text, summary, session_id, recognized_text, azure_detail)
      VALUES
        ($1, $2::timestamptz, $3, $4, $5, $6::jsonb, $7, $8, $9::jsonb)
      RETURNING id
    `;
    const params = [
      row.uid,
      row.ts,
      row.passage_key,
      row.part_index,
      row.text,
      JSON.stringify(row.summary),
      row.session_id,
      row.recognized_text,
      row.azure_detail ? JSON.stringify(row.azure_detail) : null,
    ];

    let rows;
    try {
      ({ rows } = await pool.query(sql, params));
    } catch (e) {
      // Migration 0010 is not applied on this database, so recognized_text and
      // azure_detail do not exist. 42703 is raised during parse analysis,
      // before any tuple is formed, and this INSERT is its own implicit
      // transaction, so nothing was written and there is no partial row.
      //
      // The capture is additive, and this file already degrades rather than
      // fails an attempt when it cannot store everything: AZURE_DETAIL_MAX_BYTES
      // above drops the phoneme layer instead of dropping the attempt. Losing
      // the whole attempt because an additive column is absent is that same
      // trade made the wrong way, so fall back to the pre-0010 write.
      //
      // Deliberately unlatched: no flag, no cached probe. The moment 0010 is
      // applied the first statement succeeds again and capture resumes on its
      // own, with no redeploy and no stale "the columns are missing" belief
      // pinned to a warm container. If some other column is genuinely undefined
      // the fallback raises 42703 too, and that error leaves this block and is
      // reported by the handler's catch exactly as it is today.
      if (e?.code !== UNDEFINED_COLUMN) throw e;
      console.warn(
        "attempt: recognized_text/azure_detail absent (migration 0010 not applied); " +
          "wrote the attempt without Azure detail capture"
      );
      ({ rows } = await pool.query(LEGACY_ATTEMPT_SQL, params.slice(0, 7)));
    }
    const insertedId = rows?.[0]?.id || null;

    res.status(200).json({ ok: true, id: insertedId });
  } catch (err) {
    console.error("attempt handler error:", err);
    res
      .status(500)
      .json({ ok: false, error: "server_error", detail: String(err?.message || err) });
  }
}