// routes/keepsakes-cleanup.js
// One-line: Reaps expired PENDING keepsake sets so an unsaved conversation costs nothing.
// Endpoint: GET /api/keepsakes/cleanup   (Vercel cron, or an admin token by hand)
//
// This is the half of the design that keeps the bucket honest. Everything a
// session builds is written immediately and speculatively; only a Save makes it
// permanent. Without this route running, declining to save would still cost
// storage forever, which is precisely the outcome the feature exists to avoid.
//
// Self-gated rather than listed in the router's ADMIN_ONLY set, because Vercel's
// scheduled invocation carries `Authorization: Bearer <CRON_SECRET>` and no
// x-admin-token, so the router-level gate would 401 the cron.
//
// Batched: one run reaps at most MAX_SETS_PER_RUN sets, comfortably inside the
// router's 60s maxDuration. Anything left over is picked up by the next run,
// since the selection is purely "expired and still pending".

import { purgeSets } from "../lib/keepsakes.js";
import { getSupabaseAdmin } from "../lib/supabase.js";
import { sendJson, isVercelCron } from "../lib/expenses/http.js";
import { isAdminKeyRequest } from "../lib/admin-auth.js";

const MAX_SETS_PER_RUN = 200;

export default async function handler(req, res) {
  if (req.method !== "GET") return sendJson(res, 405, { ok: false, error: "GET only" });

  if (!isVercelCron(req) && !isAdminKeyRequest(req)) {
    return sendJson(res, 401, { ok: false, error: "unauthorized" });
  }

  try {
    const sb = getSupabaseAdmin();
    const nowIso = new Date().toISOString();

    const { data: expired, error: findErr } = await sb
      .from("keepsake_sets")
      .select("id")
      .eq("status", "pending")
      .lt("expires_at", nowIso)
      .limit(MAX_SETS_PER_RUN);

    if (findErr) {
      console.error("[keepsakes-cleanup] scan failed:", findErr.message);
      return sendJson(res, 500, { ok: false, error: "cleanup_failed" });
    }

    if (!expired?.length) {
      return sendJson(res, 200, { ok: true, sets: 0, removedObjects: 0 });
    }

    const { removedObjects, error } = await purgeSets(sb, expired);
    if (error) {
      console.error("[keepsakes-cleanup] purge failed:", error.message);
      return sendJson(res, 500, { ok: false, error: "cleanup_failed" });
    }

    console.log(
      `[keepsakes-cleanup] reaped ${expired.length} expired set(s), ${removedObjects} object(s)`
    );

    return sendJson(res, 200, {
      ok: true,
      sets: expired.length,
      removedObjects,
      more: expired.length === MAX_SETS_PER_RUN,
    });
  } catch (err) {
    console.error("[keepsakes-cleanup] failed:", err?.message || err);
    return sendJson(res, 500, { ok: false, error: "cleanup_failed" });
  }
}
