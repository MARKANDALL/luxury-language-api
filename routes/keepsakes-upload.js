// routes/keepsakes-upload.js
// One-line: Parks one already-compressed convo illustration in the learner's PENDING keepsake set.
// Endpoint: POST /api/keepsakes/upload
//
// The browser compresses (canvas -> WebP q80, long edge 1280, plus a 320px
// thumb) and sends the finished bytes. This route does NO image processing: it
// writes the two objects and one metadata row, and returns. Generation quality
// in the live conversation is untouched — the learner still sees the full
// original.
//
// Idempotent by design. The object keys and the (set_id, idx) row key are both
// derived from (uid, conversationId, idx), so a retried upload overwrites
// itself rather than duplicating. That matters because the client's apiFetch
// retries on timeout.
//
// ⚠️ uid is client-asserted, exactly as it is on every other route in this
// backend (see routes/attempt.js, routes/word-info.js). This route does not
// make that weaker, and deliberately does not try to fix it here.

import {
  safeKeyPart,
  objectKeyPair,
  decodeImagePayload,
  pendingExpiryIso,
  KEEPSAKE_BUCKET,
} from "../lib/keepsakes.js";
import { getSupabaseAdmin } from "../lib/supabase.js";
import { sendJson, readJsonBody } from "../lib/expenses/http.js";

const UNIQUE_VIOLATION = "23505";

/**
 * Find or create the pending set for this conversation.
 *
 * Deliberately NOT an upsert: an upsert would rewrite status and expires_at on
 * every image, which would resurrect the expiry on a set the learner has
 * already saved. Reading first keeps "saved stays saved" true no matter how
 * many stragglers arrive afterwards.
 */
async function ensureSet(sb, { uid, conversationId, scenarioId, scenarioLabel }) {
  const find = () =>
    sb
      .from("keepsake_sets")
      .select("id, status")
      .eq("uid", uid)
      .eq("conversation_id", conversationId)
      .maybeSingle();

  const existing = await find();
  if (existing.error) return { error: existing.error };
  if (existing.data) return { set: existing.data };

  const insert = await sb
    .from("keepsake_sets")
    .insert({
      uid,
      conversation_id: conversationId,
      scenario_id: scenarioId || null,
      scenario_label: scenarioLabel || null,
      status: "pending",
      expires_at: pendingExpiryIso(),
    })
    .select("id, status")
    .single();

  if (!insert.error) return { set: insert.data };

  // Two images from the same conversation can land at once and race to create
  // the set. The loser re-reads the winner's row.
  if (insert.error.code === UNIQUE_VIOLATION) {
    const retry = await find();
    if (retry.error) return { error: retry.error };
    if (retry.data) return { set: retry.data };
  }
  return { error: insert.error };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "POST only" });

  const body = await readJsonBody(req);

  const uid = safeKeyPart(body?.uid);
  const conversationId = safeKeyPart(body?.conversationId);
  const idx = Number(body?.idx);

  if (!uid) return sendJson(res, 400, { ok: false, error: "bad_uid" });
  if (!conversationId) return sendJson(res, 400, { ok: false, error: "bad_conversation_id" });
  if (!Number.isInteger(idx) || idx < 0 || idx > 999) {
    return sendJson(res, 400, { ok: false, error: "bad_idx" });
  }

  const full = decodeImagePayload(body?.image, "image");
  if (full.error) return sendJson(res, 400, { ok: false, error: full.error });
  const thumb = decodeImagePayload(body?.thumb, "thumb");
  if (thumb.error) return sendJson(res, 400, { ok: false, error: thumb.error });

  try {
    const sb = getSupabaseAdmin();

    const { set, error: setErr } = await ensureSet(sb, {
      uid,
      conversationId,
      scenarioId: body?.scenarioId,
      scenarioLabel: body?.scenarioLabel,
    });
    if (setErr || !set) {
      console.error("[keepsakes-upload] set lookup failed:", setErr?.message || "no set");
      return sendJson(res, 500, { ok: false, error: "set_failed" });
    }

    const { storagePath, thumbPath } = objectKeyPair(uid, conversationId, idx);
    const store = sb.storage.from(KEEPSAKE_BUCKET);
    const opts = { contentType: "image/webp", upsert: true, cacheControl: "3600" };

    const [upFull, upThumb] = await Promise.all([
      store.upload(storagePath, full.buffer, opts),
      store.upload(thumbPath, thumb.buffer, opts),
    ]);

    if (upFull.error || upThumb.error) {
      console.error(
        "[keepsakes-upload] storage upload failed:",
        upFull.error?.message || upThumb.error?.message
      );
      return sendJson(res, 502, { ok: false, error: "upload_failed" });
    }

    const { error: rowErr } = await sb.from("keepsake_images").upsert(
      {
        set_id: set.id,
        idx,
        storage_path: storagePath,
        thumb_path: thumbPath,
        width: Number.isFinite(Number(body?.width)) ? Number(body.width) : null,
        height: Number.isFinite(Number(body?.height)) ? Number(body.height) : null,
        bytes: full.buffer.length,
        thumb_bytes: thumb.buffer.length,
        caption: typeof body?.caption === "string" ? body.caption.slice(0, 2000) : null,
        description: typeof body?.description === "string" ? body.description.slice(0, 4000) : null,
      },
      { onConflict: "set_id,idx" }
    );

    if (rowErr) {
      console.error("[keepsakes-upload] row upsert failed:", rowErr.message);
      return sendJson(res, 500, { ok: false, error: "row_failed" });
    }

    // status is echoed so a straggler arriving after Save can be observed in
    // logs rather than guessed at.
    return sendJson(res, 200, { ok: true, setId: set.id, idx, status: set.status });
  } catch (err) {
    console.error("[keepsakes-upload] failed:", err?.message || err);
    return sendJson(res, 500, { ok: false, error: "keepsake_upload_failed" });
  }
}
