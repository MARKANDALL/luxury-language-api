// file: /api/attempt.js
// Accept attempt payloads and insert into Postgres (table: public.lux_attempts)

import { pool } from "../lib/pool.js";
import { safeNum } from "./pronunciation-gpt/scoring.js";
import { recordTrackEnabled } from "../lib/record-track.js";

// ---------- Helpers ----------
function toIso(x) {
  try {
    return x ? new Date(x).toISOString() : new Date().toISOString();
  } catch {
    return new Date().toISOString();
  }
}

// Words that must never be graded as if the learner meant to say them.
// Lowercased, matched exactly.
const FILLER_WORDS = new Set([
  "um", "umm", "uh", "uhh", "hum", "hmm", "hm", "mhm", "mm", "er", "erm", "ah",
]);

// True when a word should be kept out of the trouble lists.
//
// TWO KINDS, ONE RULE. A PHANTOM is a word Azure invented while aligning
// speech to a script it did not match: ErrorType 'Insertion'. The learner
// never said it, so scoring it is scoring nothing. A FILLER is a real
// hesitation sound; the learner did say it, but it is not a word they were
// practising and its schwa should not become a trouble sound.
//
// This decides trouble-list membership only. The word stays in
// azure_detail.words untouched, Azure's overall scores are not recomputed, and
// nothing about the attempt's pronunciation, accuracy, fluency or completeness
// changes. Gated on LUX_RECORD_TRACK; with the flag off it never runs.
function isUngraded(w) {
  if (String(azField(w, "ErrorType") ?? "") === "Insertion") return true;
  const word = String(w?.Word ?? w?.word ?? "").trim().toLowerCase();
  return FILLER_WORDS.has(word);
}

// Build a compact summary for admin UI from Azure JSON
function toSummaryFromAzure(result, ungradeFillers = false) {
  // Defensive defaults
  const nb = result?.NBest?.[0] || {};
  const pa = nb?.PronunciationAssessment || result?.PronunciationAssessment || {};
  const ca = nb?.ContentAssessment || result?.ContentAssessment || {};

  const pron =
    safeNum(nb?.PronScore ?? pa?.PronunciationScore ?? pa?.PronScore) ?? null;
  const acc = safeNum(nb?.AccuracyScore ?? pa?.AccuracyScore) ?? null;
  const flu = safeNum(nb?.FluencyScore ?? pa?.FluencyScore) ?? null;
  const comp = safeNum(nb?.CompletenessScore ?? pa?.CompletenessScore) ?? null;

  const allWords = Array.isArray(nb?.Words) ? nb.Words : [];

  // Under the flag, phantoms and fillers drop out of BOTH lists below, and
  // their phonemes drop out of trouble-sound aggregation with them, because
  // both lists are built from this one array. Nothing above this line reads
  // it, so the four scores are untouched either way.
  const words = ungradeFillers ? allWords.filter((w) => !isUngraded(w)) : allWords;

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

  return { pron, acc, flu, comp, lows, words: wordsLow };
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
// zero. Absent fields are then normalized by numOrNull below.
function azField(item, name) {
  return item?.[name] ?? item?.PronunciationAssessment?.[name];
}

// safeNum is the file's existing coercion and Number(null) is 0, so safeNum
// turns an explicitly null score into a real zero. Every captured number below
// goes through this instead: a genuine 0 survives (an Omission really does
// have offset 0), and absent or null becomes null, which reads as "not
// scored" rather than as "scored zero".
function numOrNull(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
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
    offset: numOrNull(w?.Offset),
    duration: numOrNull(w?.Duration),
    accuracy: numOrNull(azField(w, "AccuracyScore")),
    error_type: typeof errorType === "string" && errorType ? errorType : null,
    syllables: syllables.map((s) => ({
      syllable: String(s?.Syllable ?? ""),
      grapheme: typeof s?.Grapheme === "string" ? s.Grapheme : null,
      offset: numOrNull(s?.Offset),
      duration: numOrNull(s?.Duration),
      accuracy: numOrNull(azField(s, "AccuracyScore")),
    })),
    // NBestPhonemes (Azure's per-phoneme alternative candidate lists) and the
    // per-word prosody Feedback blocks are dropped on purpose: together they
    // are the bulk of the payload and nothing in scope reads either.
    phonemes: withPhonemes
      ? phonemes.map((p) => ({
          phoneme: String(p?.Phoneme ?? ""),
          offset: numOrNull(p?.Offset),
          duration: numOrNull(p?.Duration),
          accuracy: numOrNull(azField(p, "AccuracyScore")),
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
    confidence: numOrNull(nb?.Confidence),
    snr: numOrNull(azSnr(result, nb)),
    // Offset and Duration of the whole utterance, in Azure's 100-nanosecond
    // ticks, same unit as every per-word offset below.
    offset: numOrNull(result?.Offset ?? nb?.Offset),
    duration: numOrNull(result?.Duration ?? nb?.Duration),
    // Scripted means a ReferenceText was sent, so Azure ALIGNED against a
    // script rather than transcribing freely. That is what makes phantom
    // Insertion words possible, so a transcript reader needs to know it, and
    // needs the script itself to show what was asked against what was said.
    scripted: reference.length > 0,
    reference_text: reference || null,
  };

  // THE RECORD TRACK. When LUX_RECORD_TRACK is on, routes/assess.js attaches
  // plain STT of the same audio under __luxRecord (lib/record-track.js), and
  // the client posts the Azure result through untouched, so it arrives here.
  // This is what the scripted assessment structurally cannot say: what was
  // actually spoken, including the off-script words alignment turns into
  // phantoms. Absent when the flag is off, so the key simply does not appear.
  const rec = result?.__luxRecord;
  if (rec && typeof rec === "object") {
    base.record = {
      source: typeof rec.source === "string" ? rec.source : null,
      display: typeof rec.display === "string" ? rec.display : null,
      lexical: typeof rec.lexical === "string" ? rec.lexical : null,
      confidence: numOrNull(rec.confidence),
      words: (Array.isArray(rec.words) ? rec.words : []).map((w) => ({
        word: String(w?.word ?? ""),
        offset: numOrNull(w?.offset),
        duration: numOrNull(w?.duration),
      })),
    };
  }

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
    // Under LUX_RECORD_TRACK the trouble lists stop counting phantom
    // Insertions and fillers. Read per request, never cached, so the flag can
    // be flipped on Vercel without a redeploy of this module's state.
    const ungradeFillers = recordTrackEnabled();
    let summary = azureObj ? toSummaryFromAzure(azureObj, ungradeFillers) : flatBaseline;

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

    const { rows } = await pool.query(sql, params);
    const insertedId = rows?.[0]?.id || null;

    res.status(200).json({ ok: true, id: insertedId });
  } catch (err) {
    console.error("attempt handler error:", err);
    res
      .status(500)
      .json({ ok: false, error: "server_error", detail: String(err?.message || err) });
  }
}