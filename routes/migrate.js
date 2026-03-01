import { pool } from "../lib/pool.js";

export default async function handler(req, res) {
  // CORS Headers


  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  // --- Admin token gate (matches admin routes pattern)
  const token =
    (req.headers["x-admin-token"] || "").toString().trim() ||
    (req.query?.token || "").toString().trim();
  const expected = (process.env.ADMIN_TOKEN || "").toString().trim();
  if (!expected || token !== expected) {
    return res.status(401).json({ error: "unauthorized" });
  }

  try {
    const { guestUid, userUid } = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

    if (!guestUid || !userUid) {
      return res.status(400).json({ error: "Missing guestUid or userUid" });
    }

    if (guestUid === userUid) {
      return res.status(200).json({ message: "UIDs match, no migration needed." });
    }

    // The Migration SQL
    // We update all attempts that belonged to the Guest ID to own the new User ID
    const sql = `
      UPDATE public.lux_attempts
      SET uid = $1
      WHERE uid = $2
    `;

    const result = await pool.query(sql, [userUid, guestUid]);

    console.log(`[Migrate] Moved ${result.rowCount} rows from ${guestUid} to ${userUid}`);

    return res.status(200).json({ 
      success: true, 
      count: result.rowCount,
      message: `Migrated ${result.rowCount} attempts.` 
    });

  } catch (err) {
    console.error("[Migrate] Error:", err);
    return res.status(500).json({ error: "Migration failed", details: err.message });
  }
}