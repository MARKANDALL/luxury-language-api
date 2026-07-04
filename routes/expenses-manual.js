// routes/expenses-manual.js
// One-line: POST /api/admin/expenses/manual — write a manual snapshot for a source.
//
// Body: { slug, amount_usd (or amount), note?, period? ('YYYY-MM'), period_start?, period_end? }
// Period resolution order: explicit period_start/period_end -> period 'YYYY-MM' -> current UTC month.

import { isAdmin, sendJson, readJsonBody } from "../lib/expenses/http.js";
import { getSourceBySlug, insertSnapshot, currentMonthRange } from "../lib/expenses/db.js";

function monthToRange(period) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(period || "").trim());
  if (!m) return null;
  const y = +m[1];
  const mo = +m[2];
  if (mo < 1 || mo > 12) return null;
  const iso = (d) => d.toISOString().slice(0, 10);
  return {
    start: iso(new Date(Date.UTC(y, mo - 1, 1))),
    end: iso(new Date(Date.UTC(y, mo, 0))),
  };
}

export default async function handler(req, res) {
  const method = String(req.method || "GET").toUpperCase();
  if (method === "OPTIONS") return sendJson(res, 204, {});
  if (method !== "POST") return sendJson(res, 405, { ok: false, error: "method_not_allowed" });
  if (!isAdmin(req)) return sendJson(res, 401, { ok: false, error: "unauthorized" });

  const body = await readJsonBody(req);
  const slug = String(body.slug || "").trim();
  const note = body.note != null ? String(body.note) : null;

  if (!slug) return sendJson(res, 400, { ok: false, error: "missing_slug" });

  const amt = Number(body.amount_usd ?? body.amount);
  if (!Number.isFinite(amt)) return sendJson(res, 400, { ok: false, error: "invalid_amount" });

  // Resolve the period.
  let period_start = body.period_start || null;
  let period_end = body.period_end || null;
  if ((!period_start || !period_end) && body.period) {
    const r = monthToRange(body.period);
    if (!r) return sendJson(res, 400, { ok: false, error: "invalid_period", hint: "use YYYY-MM" });
    period_start = period_start || r.start;
    period_end = period_end || r.end;
  }
  if (!period_start || !period_end) {
    const month = currentMonthRange();
    period_start = period_start || month.start;
    period_end = period_end || month.today; // month-to-date
  }

  try {
    const source = await getSourceBySlug(slug);
    if (!source) return sendJson(res, 404, { ok: false, error: "unknown_source", slug });

    const snapshot = await insertSnapshot({
      source_id: source.id,
      period_start,
      period_end,
      amount_usd: Math.round(amt * 100) / 100,
      method: "manual",
      fetched_at: new Date().toISOString(),
      raw: { source: "manual", note, entered_by: "admin" },
    });

    return sendJson(res, 200, { ok: true, snapshot });
  } catch (err) {
    console.error("[expenses-manual] failed:", err);
    return sendJson(res, 500, {
      ok: false,
      error: "manual_write_failed",
      detail: String(err?.message || err),
    });
  }
}
