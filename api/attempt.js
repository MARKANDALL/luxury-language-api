// file: /api/attempt.js
// Accept attempt payloads and insert into Postgres (table: public.lux_attempts)

import { Pool } from "pg";

// ---------- Connection pool (singleton across invocations) ----------
const pool =
  globalThis.__lux_pool ||
  new Pool({
    connectionString:
      process.env.POSTGRES_URL ||
      process.env.POSTGRES_CONNECTION ||
      process.env.DATABASE_URL,
    ssl:
      process.env.PGSSLMODE === "disable"
        ? false
        : { rejectUnauthorized: false },
  });
globalThis.__lux_pool = pool;

// ---------- CORS ----------
const PROD_ORIGIN = "https://luxury-language-api.vercel.app";
// allow any CodeSandbox preview in dev (e.g. https://abcd123.csb.app)
function originAllowed(o) {
  if (!o) return false;
  if (o === PROD_ORIGIN) return true;
  try {
    const u = new URL(o);
    return u.hostname.endsWith(".csb.app") || u.hostname === "localhost";
  } catch {
    return false;
  }
}
function pickOrigin(req) {
  const o = req.headers.origin || "";
  return originAllowed(o) ? o : PROD_ORIGIN;
}

// ---------- Helpers ----------
function toIso(x) {
  try {
    return x ? new Date(x).toISOString() : new Date().toISOString();
  } catch {
    return new Date().toISOString();
  }
}

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Build a compact summary for admin UI from Azure JSON
function toSummaryFromAzure(result) {
  // Defensive defaults
  const nb = result?.NBest?.[0] || {};
  const pa = nb?.PronunciationAssessment || result?.PronunciationAssessment || {};
  const ca = nb?.ContentAssessment || result?.ContentAssessment || {};

  const pron =
    numOrNull(nb?.PronScore ?? pa?.PronunciationScore ?? pa?.PronScore) ?? null;
  const acc = numOrNull(nb?.AccuracyScore ?? pa?.AccuracyScore) ?? null;
  const flu = numOrNull(nb?.FluencyScore ?? pa?.FluencyScore) ?? null;
  const comp = numOrNull(nb?.CompletenessScore ?? pa?.CompletenessScore) ?? null;

  const words = Array.isArray(nb?.Words) ? nb.Words : [];

  // trouble phonemes (lowest 6 by score)
  const phScores = [];
  for (const w of words) {
    const phs = Array.isArray(w?.Phonemes) ? w.Phonemes : [];
    for (const p of phs) {
      const key = String(p?.Phoneme || "").trim();
      const score = numOrNull(p?.AccuracyScore);
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
    const s = numOrNull(w?.AccuracyScore);
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

export default async function handler(req, res) {
  // CORS headers
  const origin = pickOrigin(req);
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method Not Allowed" });
    return;
  }

  try {
    const body =
      typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};

    // ---- Accept both legacy and new shapes ----
    const uid = body.uid || body.userId || null;
    const passageKey = body.passageKey || body.passage || "unknown";
    const partIndex =
      body.partIndex != null ? Number(body.partIndex) : Number(body.part ?? 0);
    const text =
      body.text ||
      body.referenceText ||
      body.azureResult?.DisplayText ||
      body.azureResult?.NBest?.[0]?.Display ||
      "";

    // summary:
    let summary = null;
    if (body.summary && typeof body.summary === "object") {
      summary = body.summary;
    } else if (body.azureResult && typeof body.azureResult === "object") {
      summary = toSummaryFromAzure(body.azureResult);
    } else {
      // fallback to any flat fields client might have sent
      summary = {
        pron: numOrNull(body.pron),
        acc: numOrNull(body.acc),
        flu: numOrNull(body.flu),
        comp: numOrNull(body.comp),
        lows: Array.isArray(body.lows) ? body.lows : [],
        words: Array.isArray(body.words) ? body.words : [],
      };
    }

    if (!uid) return res.status(400).json({ ok: false, error: "missing_uid" });

    const row = {
      uid,
      ts: toIso(body.ts),
      passage_key: passageKey,
      part_index: Number.isFinite(partIndex) ? partIndex : 0,
      text,
      summary: summary || {},
    };

    // Insert
    const sql = `
      INSERT INTO public.lux_attempts
        (uid, ts, passage_key, part_index, text, summary)
      VALUES
        ($1, $2::timestamptz, $3, $4, $5, $6::jsonb)
      RETURNING id
    `;
    const params = [
      row.uid,
      row.ts,
      row.passage_key,
      row.part_index,
      row.text,
      JSON.stringify(row.summary),
    ];

    const { rows } = await pool.query(sql, params);
    const insertedId = rows?.[0]?.id || null;

    console.log("[attempt] inserted", {
      uid: row.uid,
      passage: row.passage_key,
      part_index: row.part_index,
      id: insertedId,
    });

    res.status(200).json({ ok: true, id: insertedId });
  } catch (err) {
    console.error("attempt handler error:", err);
    res
      .status(500)
      .json({ ok: false, error: "server_error", detail: String(err?.message || err) });
  }
}
