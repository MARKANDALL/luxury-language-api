// file: /api/attempt.js  (Vercel Node serverless function, ESM)
import { Pool } from "pg";

// ---- Connection pool (reuse across invocations) ----
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

// ---- CORS ----
const ALLOW_ORIGINS = [
  "https://luxury-language-api.vercel.app",
  "https://prh3j3.csb.app",
  "http://localhost:3000",
];
function allowOrigin(origin) {
  if (!origin) return ALLOW_ORIGINS[0];
  return ALLOW_ORIGINS.includes(origin) ? origin : ALLOW_ORIGINS[0];
}
function setCors(req, res) {
  const origin = allowOrigin(req.headers.origin);
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function tidySummary(body) {
  // accept scores directly from client; keep small
  const s = {
    pron: body.pron ?? null,
    acc: body.acc ?? null,
    flu: body.flu ?? null,
    comp: body.comp ?? null,
  };
  // optional low phonemes list if you ever send it
  if (Array.isArray(body.lows)) s.lows = body.lows.slice(0, 20);
  return s;
}

export default async function handler(req, res) {
  setCors(req, res);

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method Not Allowed" });
    return;
  }

  try {
    const b = req.body || {};
    const row = {
      uid: b.uid || null,
      ts: b.ts || new Date().toISOString(),
      passage_key: b.passage || "unknown",
      part_index: Number.isFinite(+b.part) ? +b.part : 0,
      text: b.text || "",
      summary: tidySummary(b),
    };

    // insert (summary is JSONB column)
    await pool.query(
      `INSERT INTO public.lux_attempts
       (uid, ts, passage_key, part_index, text, summary)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        row.uid,
        row.ts,
        row.passage_key,
        row.part_index,
        row.text,
        row.summary,
      ]
    );

    res.status(200).json({ ok: true });
  } catch (e) {
    console.error("attempt insert error:", e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
