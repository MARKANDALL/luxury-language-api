// file: /api/attempt.js
// Writes attempts into public.lux_attempts (same table your admin pages read)
// Uses the same PG pool pattern as /api/admin-recent.js + permissive CORS.

const { Pool } = require("pg");

// ---- Reuse the same pool as admin-recent.js ----
const pool =
  global.__lux_pool ||
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
global.__lux_pool = pool;

// ---- Minimal helper to read JSON body (Vercel functions don’t auto-parse) ----
async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString() || "{}"); }
  catch { return {}; }
}

module.exports = async (req, res) => {
  // CORS for dev + embeds
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  try {
    const b = await readJson(req);

    // Map client payload → columns expected by your admin readers
    const row = {
      uid: b.uid || null,
      ts: b.ts || new Date().toISOString(),
      passage_key: b.passage || "unknown",
      part_index: Number.isFinite(+b.part) ? +b.part : 0,
      text: b.text || "",
      // keep scores inside summary JSON (admin pages read summary.pron/acc/flu/comp)
      summary: {
        pron: b.pron ?? b?.summary?.pron ?? null,
        acc:  b.acc  ?? b?.summary?.acc  ?? null,
        flu:  b.flu  ?? b?.summary?.flu  ?? null,
        comp: b.comp ?? b?.summary?.comp ?? null,
        lows: (b.lows || b?.summary?.lows) ?? [],
        success: b.success !== false,
        error: b.error || null
      }
    };

    const sql = `
      INSERT INTO public.lux_attempts
        (uid, ts, passage_key, part_index, text, summary)
      VALUES ($1,$2,$3,$4,$5,$6)
      RETURNING id
    `;
    const params = [row.uid, row.ts, row.passage_key, row.part_index, row.text, row.summary];

    const { rows } = await pool.query(sql, params);
    return res.status(200).json({ ok: true, id: rows?.[0]?.id ?? null });
  } catch (e) {
    console.error("attempt insert error:", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
};
