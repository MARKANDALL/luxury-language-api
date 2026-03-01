// api/update-attempt.js
// Updates an existing attempt (e.g. to add AI feedback later)

import { pool } from "../lib/pool.js";

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  // --- Admin token gate
  const token =
    (req.headers["x-admin-token"] || "").toString().trim() ||
    (req.query?.token || "").toString().trim();
  const expected = (process.env.ADMIN_TOKEN || "").toString().trim();
  if (!expected || token !== expected) {
    return res.status(401).json({ error: "unauthorized" });
  }

  try {
    const { id, ai_feedback } = req.body;

    if (!id || !ai_feedback) {
      return res.status(400).json({ error: "Missing id or ai_feedback" });
    }

    // We use a neat PostgreSQL trick: jsonb_set to merge data without overwriting everything
    // This assumes 'summary' is a JSONB column.
    // It updates summary -> 'ai_feedback' with the new data.
    const sql = `
      UPDATE public.lux_attempts
      SET summary = jsonb_set(summary, '{ai_feedback}', $2::jsonb)
      WHERE id = $1
      RETURNING id, summary
    `;

    const { rows } = await pool.query(sql, [id, JSON.stringify(ai_feedback)]);

    if (rows.length === 0) {
      return res.status(404).json({ error: "Attempt not found" });
    }

    return res.status(200).json({ ok: true, summary: rows[0].summary });

  } catch (err) {
    console.error("update-attempt error:", err);
    return res.status(500).json({ error: err.message });
  }
}