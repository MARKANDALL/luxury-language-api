// routes/keepsakes-list.js
// One-line: The learner's album — their saved keepsake sets, newest first, with signed THUMB urls.
// Endpoint: GET /api/keepsakes/list?uid=...&limit=&offset=
//
// Thumbs only. The album grid renders ~14 KB per image, and the full 91 KB
// versions are fetched by routes/keepsakes-set.js when a set is actually
// opened. Signing is batched into one round trip rather than one per object.
//
// Pending sets are never listed. A set the learner did not save does not exist
// as far as the album is concerned, whether or not the cron has reaped it yet.

import { signPaths } from "../lib/keepsakes.js";
import { getSupabaseAdmin } from "../lib/supabase.js";
import { sendJson, getHeader } from "../lib/expenses/http.js";

const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 60;

function readQuery(req) {
  try {
    return new URL(req.url, `http://${getHeader(req, "host") || "localhost"}`).searchParams;
  } catch {
    return new URLSearchParams();
  }
}

export default async function handler(req, res) {
  if (req.method !== "GET") return sendJson(res, 405, { ok: false, error: "GET only" });

  const q = readQuery(req);
  const uid = String(q.get("uid") || "").trim();
  if (!uid) return sendJson(res, 400, { ok: false, error: "bad_uid" });

  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(q.get("limit")) || DEFAULT_LIMIT));
  const offset = Math.max(0, Number(q.get("offset")) || 0);

  try {
    const sb = getSupabaseAdmin();

    const { data: sets, error: setsErr } = await sb
      .from("keepsake_sets")
      .select("id, conversation_id, scenario_id, scenario_label, saved_at, created_at")
      .eq("uid", uid)
      .eq("status", "saved")
      .order("saved_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (setsErr) {
      console.error("[keepsakes-list] set read failed:", setsErr.message);
      return sendJson(res, 500, { ok: false, error: "list_failed" });
    }
    if (!sets?.length) return sendJson(res, 200, { ok: true, sets: [] });

    const { data: images, error: imgErr } = await sb
      .from("keepsake_images")
      .select("set_id, idx, thumb_path, caption, description")
      .in("set_id", sets.map((s) => s.id))
      .order("idx", { ascending: true });

    if (imgErr) {
      console.error("[keepsakes-list] image read failed:", imgErr.message);
      return sendJson(res, 500, { ok: false, error: "list_failed" });
    }

    const signed = await signPaths(sb, (images || []).map((i) => i.thumb_path));

    const bySet = new Map(sets.map((s) => [s.id, []]));
    for (const img of images || []) {
      const url = signed.get(img.thumb_path);
      if (!url) continue; // an object that would not sign is simply not shown
      bySet.get(img.set_id)?.push({
        idx: img.idx,
        thumbUrl: url,
        caption: img.caption || "",
        description: img.description || "",
      });
    }

    return sendJson(res, 200, {
      ok: true,
      sets: sets.map((s) => ({
        setId: s.id,
        conversationId: s.conversation_id,
        scenarioId: s.scenario_id,
        scenarioLabel: s.scenario_label,
        savedAt: s.saved_at,
        createdAt: s.created_at,
        thumbs: bySet.get(s.id) || [],
      })),
    });
  } catch (err) {
    console.error("[keepsakes-list] failed:", err?.message || err);
    return sendJson(res, 500, { ok: false, error: "list_failed" });
  }
}
