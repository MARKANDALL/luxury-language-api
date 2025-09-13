// file: /api/attempt.js
import { Pool } from "pg";

const pool =
  globalThis.__lux_pool ||
  new Pool({
    connectionString:
      process.env.POSTGRES_URL ||
      process.env.POSTGRES_CONNECTION ||
      process.env.DATABASE_URL,
    ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
  });
globalThis.__lux_pool = pool;

const ALLOW = [
  "https://luxury-language-api.vercel.app",
  "https://prh3j3.csb.app",
  "http://localhost:3000",
];

function allowOrigin(origin) {
  if (!origin) return "*";
  return ALLOW.includes(origin) ? origin : ALLOW[0];
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

    // --- Minimal validation
    const uid = (b.uid || "").toString().trim();
    const passage = (b.passage || "").toString().trim();
    const ts = b.ts ? new Date(b.ts).toISOString() : new Date().toISOString();

    const part_index =
      Number.isFinite(Number(b.part)) ? Number(b.part) : 0;

    // Compact summary only (don’t store the whole Azure blob)
    const summary = {
      acc: Number.isFinite(Number(b.acc)) ? Number(b.acc) : null,
      flu: Number.isFinite(Number(b.flu)) ? Number(b.flu) : null,
      comp: Number.isFinite(Number(b.comp)) ? Number(b.comp) : null,
      pron: Number.isFinite(Number(b.pron)) ? Number(b.pron) : null,
    };

    const text = (b.text || "").toString();

    if (!uid || !passage) {
      console.warn("[attempt] missing uid/passage", { uid, passage });
      return res.status(400).json({ ok: false, error: "missing_uid_or_passage" });
    }

    const sql = `
      insert into public.lux_attempts (uid, ts, passage_key, part_index, text, summary)
      values ($1, $2, $3, $4, $5, $6::jsonb)
      returning id
    `;
    const params = [uid, ts, passage, part_index, text, JSON.stringify(summary)];

    const { rows } = await pool.query(sql, params);
    console.log("[attempt] inserted", { uid, passage, part_index, id: rows?.[0]?.id });

    return res.status(200).json({ ok: true, id: rows?.[0]?.id || null });
  } catch (e) {
    console.error("[attempt] insert failed:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
}
