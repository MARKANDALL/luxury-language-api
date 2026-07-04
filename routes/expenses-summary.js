// routes/expenses-summary.js
// One-line: GET /api/admin/expenses/summary — latest snapshot per source, MTD total, run/build split, events.

import { isAdmin, sendJson } from "../lib/expenses/http.js";
import {
  getSources,
  latestSnapshotPerSource,
  getEvents,
  currentMonthRange,
} from "../lib/expenses/db.js";

function num(v) {
  return v == null ? null : Number(v);
}

export default async function handler(req, res) {
  const method = String(req.method || "GET").toUpperCase();
  if (method === "OPTIONS") return sendJson(res, 204, {});
  if (method !== "GET") return sendJson(res, 405, { ok: false, error: "method_not_allowed" });
  if (!isAdmin(req)) return sendJson(res, 401, { ok: false, error: "unauthorized" });

  try {
    const [sources, latestMap, events] = await Promise.all([
      getSources({}),
      latestSnapshotPerSource(),
      getEvents({ limit: 50 }),
    ]);

    const perSource = sources.map((s) => {
      const snap = latestMap.get(s.id) || null;
      return {
        id: s.id,
        slug: s.slug,
        display_name: s.display_name,
        category: s.category,
        billing_shape: s.billing_shape,
        fetch_mode: s.fetch_mode,
        vendor_url: s.vendor_url,
        active: s.active,
        notes: s.notes,
        latest: snap
          ? {
              amount_usd: num(snap.amount_usd),
              period_start: snap.period_start,
              period_end: snap.period_end,
              method: snap.method,
              fetched_at: snap.fetched_at,
            }
          : null,
      };
    });

    // MTD total = sum of the latest amount for each ACTIVE source that has one.
    const counted = perSource.filter(
      (x) => x.active && x.latest && x.latest.amount_usd != null
    );
    const sum = (arr) =>
      Math.round(arr.reduce((a, x) => a + (x.latest.amount_usd || 0), 0) * 100) / 100;

    const totals = {
      month_to_date: sum(counted),
      run: sum(counted.filter((x) => x.category === "run")),
      build: sum(counted.filter((x) => x.category === "build")),
      currency: "usd",
    };

    const slugById = new Map(sources.map((s) => [s.id, s.slug]));
    const eventsOut = events.map((e) => ({
      id: e.id,
      source_id: e.source_id,
      slug: slugById.get(e.source_id) || null,
      event_date: e.event_date,
      kind: e.kind,
      amount_usd: num(e.amount_usd),
      description: e.description,
    }));

    return sendJson(res, 200, {
      ok: true,
      as_of: new Date().toISOString(),
      month: currentMonthRange(),
      totals,
      sources: perSource,
      events: eventsOut,
    });
  } catch (err) {
    console.error("[expenses-summary] failed:", err);
    return sendJson(res, 500, {
      ok: false,
      error: "summary_failed",
      detail: String(err?.message || err),
    });
  }
}
