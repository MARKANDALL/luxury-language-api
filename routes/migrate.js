import { Pool } from "pg";

// Re-use connection pool logic from attempt.js
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

export default async function handler(req, res) {
  // CORS Headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();

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
