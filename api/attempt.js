// file: /api/attempt.js
// Purpose: accept attempt payloads from the client and insert into Postgres (lux_attempts)

import { Pool } from "pg";

// ---------- Connection pool (singleton across invocations) ----------
const pool =
  globalThis.__lux_pool ||
  new Pool({
    connectionString:
      process.env.POSTGRES_URL ||
      process.env.POSTGRES_CONNECTION ||
      process.env.DATABASE_URL,
    // Most hosted Postgres require SSL; disable only if you know you need to
    ssl:
      process.env.PGSSLMODE === "disable"
        ? false
        : { rejectUnauthorized: false },
  });
globalThis.__lux_pool = pool;

// ---------- CORS ----------
const ALLOW_ORIGINS = new Set([
  "https://luxury-language-api.vercel.app",
  "https://prh3j3.csb.app", // CodeSandbox preview
  "http://localhost:3000",
  "http://localhost:5173",
]);

function pickOrigin(req) {
  const o = req.headers.origin || "";
  return ALLOW_ORIGINS.has(o) ? o : "https://luxury-language-api.vercel.app";
}

// ---------- Helpers ----------
function toIso(x) {
  try {
    return x ? new Date(x).toISOString() : new Date().toISOString();
  } catch {
    return new Date().toISOString();
  }
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
    const body = req.body || {};

    // Build the row we store; "summary" is jsonb and feeds the admin UI (trouble words/sounds)
    const row = {
      uid: body.uid || null,
      ts: toIso(body.ts),
      passage_key: body.passage || "unknown",
      part_index: Number(body.part ?? 0),
      text: body.text || "",
      // Summary should contain {pron,acc,flu,comp,lows[],words[]}; client now sends this
      summary:
        body.summary && typeof body.summary === "object"
          ? body.summary
          : {
              // fallback if client sent flat scores
              pron: body.pron ?? null,
              acc: body.acc ?? null,
              flu: body.flu ?? null,
              comp: body.comp ?? null,
              lows: body.lows || [],
              words: body.words || [],
            },
    };

    // Minimal validation
    if (!row.uid) {
      return res.status(400).json({ ok: false, error: "missing_uid" });
    }

    // Insert into Postgres
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
      JSON.stringify(row.summary || {}),
    ];

    const { rows } = await pool.query(sql, params);
    const insertedId = rows?.[0]?.id || null;

    // Nice log line (shows up in Vercel logs)
    console.log("[attempt] inserted", {
      uid: row.uid,
      passage: row.passage_key,
      part_index: row.part_index,
      id: insertedId,
    });

    res.status(200).json({ ok: true, id: insertedId });
  } catch (err) {
    console.error("attempt handler error:", err);
    res.status(500).json({
      ok: false,
      error: "server_error",
      detail: String(err?.message || err),
    });
  }
}
