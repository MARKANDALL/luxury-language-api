// api/user-recent.js
// PUBLIC ENDPOINT: Fetches history for a specific user.
// Security: Validates UID format (UUID) to prevent abuse. No admin token required.

import { pool } from "../lib/pool.js";

// 2. Helper to validate UUIDs (Prevents SQL Injection / garbage data)
function isUUID(str) {
  const regex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return regex.test(str);
}

export default async function handler(req, res) {
  // Allow CORS (So your frontend can call this)


  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    // 3. Get and Validate the UID
    const { uid } = req.query;

    if (!uid || !isUUID(uid)) {
      return res.status(400).json({
        error: "Invalid or missing UID. Must be a standard UUID.",
      });
    }

    // 4. Run the Query
    // We limit to 50 to keep it fast.
    const sql = `
      SELECT
        id,
        uid,
        ts,
        passage_key,
        part_index,
        text,
        session_id,
        (summary - 'raw') AS summary
      FROM public.lux_attempts
      WHERE uid = $1
      ORDER BY ts DESC
      LIMIT 50
    `;

    const { rows } = await pool.query(sql, [uid]);

    // 5. Return the rows
    return res.status(200).json({ rows });
  } catch (err) {
    console.error("user-recent error:", err);
    return res.status(500).json({ error: "Server error fetching history." });
  }
}