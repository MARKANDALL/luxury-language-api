// file: /api/attempt.js  (Vercel Serverless Function)
// Inserts into public.lux_attempts (uid, ts, passage_key, part_index, text, summary)

import { Pool } from "pg";

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

const ALLOW_ORIGINS = [
  "https://luxury-language-api.vercel.app",
  "https://prh3j3.csb.app",
  "http://localhost:3000",
];

function allowOrigin(origin) {
  if (!origin) return ALLOW_ORIGINS[0];
  return ALLOW_ORIGINS.includes(origin) ? origin : ALLOW_ORIGINS[0];
}

export default async function handler(req, res) {
  const origin = allowOrigin(req.headers.origin);
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  try {
    const b = req.body || {};

    // Accept either flat scores or a nested summary
    const summary =
      b.summary && typeof b.summary === "object"
        ? b.summary
        : {
            acc: b.acc ?? null,
            flu: b.flu ?? null,
            comp: b.comp ?? null,
            pron: b.pron ?? null,
            // if the client included lows (trouble phonemes), keep them
            lows: Array.isArray(b.lows) ? b.lows : undefined,
          };

    // Minimal row mapping to your schema
    const row = {
      uid: b.uid || null,
      ts: b.ts || new Date().toISOString(),
      passage_key: b.passage || "unknown",
      part_index: Number.isFinite(Number(b.part)) ? Number(b.part) : 0,
      text: b.text || "",
      summary,
    };

    // Insert
    const sql = `
      insert into public.lux_attempts (uid, ts, passage_key, part_index, text, summary)
      values ($1, $2, $3, $4, $5, $6)
      returning id
    `;
    const params = [
      row.uid,
      row.ts,
      row.passage_key,
      row.part_index,
      row.text,
      JSON.stringify(row.summary ?? {}),
    ];

    const { rows } = await pool.query(sql, params);

    // (Optional) ignore raw Azure on the DB; it’s large
    // If you *do* want it, create a separate table/column.

    return res.status(200).json({ ok: true, id: rows?.[0]?.id || null });
  } catch (e) {
    console.error("attempt insert error:", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
