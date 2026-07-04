// routes/expenses-migrate.js
// One-line: POST /api/admin/expenses/migrate — apply the expense-dashboard schema + seed (idempotent).
//
// Runs the SQL from lib/expenses/migration.js through the pg pool. Admin-gated.
// Safe to call more than once; DDL uses IF NOT EXISTS and seeds are guarded.

import { pool } from "../lib/pool.js";
import { isAdmin, sendJson } from "../lib/expenses/http.js";
import { MIGRATION_SQL } from "../lib/expenses/migration.js";

export default async function handler(req, res) {
  const method = String(req.method || "GET").toUpperCase();
  if (method === "OPTIONS") return sendJson(res, 204, {});
  if (method !== "POST") return sendJson(res, 405, { ok: false, error: "method_not_allowed" });
  if (!isAdmin(req)) return sendJson(res, 401, { ok: false, error: "unauthorized" });

  try {
    // Simple-query protocol (no params) permits multiple statements in one call.
    await pool.query(MIGRATION_SQL);

    const [{ rows: srcRows }, { rows: snapRows }, { rows: evtRows }] = await Promise.all([
      pool.query("select count(*)::int as n from public.expense_sources"),
      pool.query("select count(*)::int as n from public.expense_snapshots"),
      pool.query("select count(*)::int as n from public.expense_events"),
    ]);

    return sendJson(res, 200, {
      ok: true,
      applied: true,
      counts: {
        sources: srcRows[0].n,
        snapshots: snapRows[0].n,
        events: evtRows[0].n,
      },
    });
  } catch (err) {
    console.error("[expenses-migrate] failed:", err);
    return sendJson(res, 500, {
      ok: false,
      error: "migration_failed",
      detail: String(err?.message || err),
    });
  }
}
