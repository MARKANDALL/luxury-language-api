// routes/keepsakes-delete.js
// One-line: Deletes one saved keepsake set — its storage objects and its rows.
// Endpoint: POST /api/keepsakes/delete
//
// POST rather than DELETE because api/router.js only advertises GET, POST and
// OPTIONS in Access-Control-Allow-Methods, so a browser DELETE would fail
// preflight.
//
// Objects go before rows (see purgeSets): a row that outlives a failed object
// delete can be retried, whereas a deleted row would orphan bytes with nothing
// left pointing at them.

import { safeKeyPart, purgeSets } from "../lib/keepsakes.js";
import { getSupabaseAdmin } from "../lib/supabase.js";
import { sendJson, readJsonBody } from "../lib/expenses/http.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "POST only" });

  const body = await readJsonBody(req);
  const uid = safeKeyPart(body?.uid);
  const setId = String(body?.setId || "").trim();

  if (!uid) return sendJson(res, 400, { ok: false, error: "bad_uid" });
  if (!setId) return sendJson(res, 400, { ok: false, error: "bad_set_id" });

  try {
    const sb = getSupabaseAdmin();

    // Scoped by uid: the ownership check and the lookup are the same query.
    const { data: set, error: findErr } = await sb
      .from("keepsake_sets")
      .select("id")
      .eq("id", setId)
      .eq("uid", uid)
      .maybeSingle();

    if (findErr) {
      console.error("[keepsakes-delete] lookup failed:", findErr.message);
      return sendJson(res, 500, { ok: false, error: "delete_failed" });
    }
    if (!set) return sendJson(res, 404, { ok: false, error: "not_found" });

    const { removedObjects, error } = await purgeSets(sb, [set]);
    if (error) {
      console.error("[keepsakes-delete] purge failed:", error.message);
      return sendJson(res, 500, { ok: false, error: "delete_failed" });
    }

    return sendJson(res, 200, { ok: true, setId: set.id, removedObjects });
  } catch (err) {
    console.error("[keepsakes-delete] failed:", err?.message || err);
    return sendJson(res, 500, { ok: false, error: "delete_failed" });
  }
}
