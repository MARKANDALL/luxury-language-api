// routes/keepsakes-promote.js
// One-line: Flips a conversation's PENDING keepsake set to SAVED. No processing, no waiting.
// Endpoint: POST /api/keepsakes/promote
//
// This is the whole of "Save". The objects were written under their final keys
// as the conversation ran, so nothing moves and nothing is re-encoded: promoting
// is one indexed UPDATE. That is what lets the report card confirm instantly
// instead of showing a spinner.
//
// Clearing expires_at is what actually makes the set permanent — the cleanup
// cron reaps on (status = 'pending' AND expires_at < now()).
//
// STRAGGLERS: an image still uploading when this runs is not lost. It attaches
// to the set by id, and keepsakes-upload.js never rewrites status, so it lands
// in a set that is already saved and is kept.

import { safeKeyPart } from "../lib/keepsakes.js";
import { getSupabaseAdmin } from "../lib/supabase.js";
import { sendJson, readJsonBody } from "../lib/expenses/http.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "POST only" });

  const body = await readJsonBody(req);
  const uid = safeKeyPart(body?.uid);
  const conversationId = safeKeyPart(body?.conversationId);

  if (!uid) return sendJson(res, 400, { ok: false, error: "bad_uid" });
  if (!conversationId) return sendJson(res, 400, { ok: false, error: "bad_conversation_id" });

  try {
    const sb = getSupabaseAdmin();

    const { data: promoted, error } = await sb
      .from("keepsake_sets")
      .update({ status: "saved", saved_at: new Date().toISOString(), expires_at: null })
      .eq("uid", uid)
      .eq("conversation_id", conversationId)
      .eq("status", "pending")
      .select("id, saved_at")
      .maybeSingle();

    if (error) {
      console.error("[keepsakes-promote] update failed:", error.message);
      return sendJson(res, 500, { ok: false, error: "promote_failed" });
    }

    if (!promoted) {
      // Either already saved (a double tap, which must stay harmless) or there
      // was never a set, because every image failed to compress or upload.
      const { data: existing } = await sb
        .from("keepsake_sets")
        .select("id, status, saved_at")
        .eq("uid", uid)
        .eq("conversation_id", conversationId)
        .maybeSingle();

      if (existing?.status === "saved") {
        return sendJson(res, 200, {
          ok: true,
          setId: existing.id,
          savedAt: existing.saved_at,
          alreadySaved: true,
        });
      }
      return sendJson(res, 404, { ok: false, error: "no_pending_set" });
    }

    const { count } = await sb
      .from("keepsake_images")
      .select("id", { count: "exact", head: true })
      .eq("set_id", promoted.id);

    return sendJson(res, 200, {
      ok: true,
      setId: promoted.id,
      savedAt: promoted.saved_at,
      imageCount: count ?? null,
    });
  } catch (err) {
    console.error("[keepsakes-promote] failed:", err?.message || err);
    return sendJson(res, 500, { ok: false, error: "promote_failed" });
  }
}
