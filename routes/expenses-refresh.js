// routes/expenses-refresh.js
// One-line: /api/admin/expenses/refresh — run every auto fetcher, write snapshots, return per-source results.
//
// POST: backs the "REFRESH ALL" button (admin token).
// GET:  the Vercel daily cron (authorized by CRON_SECRET, or the admin token).
// Each source is isolated: one fetcher throwing never aborts the others.

import { isAdmin, isVercelCron, sendJson } from "../lib/expenses/http.js";
import { getSources, insertSnapshot } from "../lib/expenses/db.js";
import { getFetcher } from "../lib/expenses/fetchers/index.js";

export default async function handler(req, res) {
  const method = String(req.method || "GET").toUpperCase();
  if (method === "OPTIONS") return sendJson(res, 204, {});
  if (method !== "GET" && method !== "POST") {
    return sendJson(res, 405, { ok: false, error: "method_not_allowed" });
  }

  const admin = isAdmin(req);
  const cron = isVercelCron(req);
  if (!admin && !cron) return sendJson(res, 401, { ok: false, error: "unauthorized" });
  const triggeredBy = admin ? "admin" : "cron";

  try {
    const sources = await getSources({ activeOnly: true });
    const autoSources = sources.filter((s) => s.fetch_mode === "auto");
    const results = [];

    for (const source of autoSources) {
      const fetcher = getFetcher(source.slug);
      if (!fetcher) {
        results.push({ slug: source.slug, ok: false, skipped: true, note: "no fetcher registered" });
        continue;
      }

      try {
        const r = await fetcher(source);

        // Recoverable skip (e.g. missing key): don't write a snapshot.
        if (!r || r.skipped || r.ok === false) {
          results.push({
            slug: source.slug,
            ok: false,
            skipped: true,
            method: r?.fetch_mode_effective || "manual",
            note: r?.note || "skipped",
          });
          continue;
        }

        const snapshot = await insertSnapshot({
          source_id: source.id,
          period_start: r.period_start || null,
          period_end: r.period_end || null,
          amount_usd: r.amount_usd ?? null,
          method: r.method || "auto",
          fetched_at: new Date().toISOString(),
          raw: r.raw || null,
        });

        results.push({
          slug: source.slug,
          ok: true,
          amount_usd: snapshot.amount_usd == null ? null : Number(snapshot.amount_usd),
          period_start: snapshot.period_start,
          period_end: snapshot.period_end,
          method: snapshot.method,
          snapshot_id: snapshot.id,
          note: r.note || null,
        });
      } catch (err) {
        console.error(`[expenses-refresh] ${source.slug} failed:`, err);
        results.push({ slug: source.slug, ok: false, error: String(err?.message || err) });
      }
    }

    const okCount = results.filter((r) => r.ok).length;
    return sendJson(res, 200, {
      ok: true,
      triggered_by: triggeredBy,
      ran_at: new Date().toISOString(),
      counts: { total: autoSources.length, ok: okCount, failed: autoSources.length - okCount },
      results,
    });
  } catch (err) {
    console.error("[expenses-refresh] failed:", err);
    return sendJson(res, 500, {
      ok: false,
      error: "refresh_failed",
      detail: String(err?.message || err),
    });
  }
}
