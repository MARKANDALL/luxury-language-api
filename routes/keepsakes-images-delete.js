// routes/keepsakes-images-delete.js
// One-line: Deletes named images from one keepsake set, leaving the rest.
// Endpoint: POST /api/keepsakes/images-delete
//
// keepsakes/delete takes a whole set and nothing smaller, which two things now
// need to be able to do: the report card's selective save (promote, then drop
// the pictures the learner did not choose) and the album's per-image delete.
//
// POST rather than DELETE because api/router.js only advertises GET, POST and
// OPTIONS in Access-Control-Allow-Methods, so a browser DELETE fails preflight.
//
// The uid filter on the set lookup is the ownership check: a set id alone must
// not be enough to delete someone else's pictures.

import { safeKeyPart, purgeImages } from "../lib/keepsakes.js";
import { getSupabaseAdmin } from "../lib/supabase.js";
import { sendJson, readJsonBody } from "../lib/expenses/http.js";

// A conversation cannot produce anything near this many pictures; the cap only
// stops a malformed or hostile caller sending an enormous list.
const MAX_INDICES = 200;

export default async function handler(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "POST only" });

  const body = await readJsonBody(req);
  const uid = safeKeyPart(body?.uid);
  const setId = String(body?.setId || "").trim();
  const raw = Array.isArray(body?.idx) ? body.idx : null;

  if (!uid) return sendJson(res, 400, { ok: false, error: "bad_uid" });
  if (!setId) return sendJson(res, 400, { ok: false, error: "bad_set_id" });
  if (!raw || !raw.length) return sendJson(res, 400, { ok: false, error: "bad_idx" });
  if (raw.length > MAX_INDICES) return sendJson(res, 400, { ok: false, error: "too_many_idx" });

  const idx = [...new Set(raw.map(Number))].filter(
    (n) => Number.isInteger(n) && n >= 0 && n <= 999
  );
  if (!idx.length) return sendJson(res, 400, { ok: false, error: "bad_idx" });

  try {
    const sb = getSupabaseAdmin();

    const { data: set, error: findErr } = await sb
      .from("keepsake_sets")
      .select("id")
      .eq("id", setId)
      .eq("uid", uid)
      .maybeSingle();

    if (findErr) {
      console.error("[keepsakes-images-delete] lookup failed:", findErr.message);
      return sendJson(res, 500, { ok: false, error: "delete_failed" });
    }
    if (!set) return sendJson(res, 404, { ok: false, error: "not_found" });

    const { removedImages, removedObjects, setDeleted, error } = await purgeImages(sb, set.id, idx);
    if (error) {
      console.error("[keepsakes-images-delete] purge failed:", error.message);
      return sendJson(res, 500, { ok: false, error: "delete_failed" });
    }

    return sendJson(res, 200, {
      ok: true,
      setId: set.id,
      removedImages,
      removedObjects,
      // The caller needs to know the set went, so the album can drop the whole
      // card rather than leaving an empty one behind.
      setDeleted,
    });
  } catch (err) {
    console.error("[keepsakes-images-delete] failed:", err?.message || err);
    return sendJson(res, 500, { ok: false, error: "delete_failed" });
  }
}
