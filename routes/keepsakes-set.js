// routes/keepsakes-set.js
// One-line: One saved set's full-size images, signed, for opening the gallery.
// Endpoint: GET /api/keepsakes/set?uid=...&setId=...
//
// Split from keepsakes-list.js on purpose: the album grid loads thumbs for many
// sets, and signing every full image for every set on that screen would be
// wasted work for images nobody opens. This route signs the ~6 fulls of one set,
// at the moment it is opened.

import { signPaths } from "../lib/keepsakes.js";
import { getSupabaseAdmin } from "../lib/supabase.js";
import { sendJson, getHeader } from "../lib/expenses/http.js";

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
  const setId = String(q.get("setId") || "").trim();

  if (!uid) return sendJson(res, 400, { ok: false, error: "bad_uid" });
  if (!setId) return sendJson(res, 400, { ok: false, error: "bad_set_id" });

  try {
    const sb = getSupabaseAdmin();

    // The uid filter is the ownership check: a set id alone is not enough to
    // read someone else's images.
    const { data: set, error: setErr } = await sb
      .from("keepsake_sets")
      .select("id, conversation_id, scenario_id, scenario_label, saved_at, status")
      .eq("id", setId)
      .eq("uid", uid)
      .eq("status", "saved")
      .maybeSingle();

    if (setErr) {
      console.error("[keepsakes-set] set read failed:", setErr.message);
      return sendJson(res, 500, { ok: false, error: "set_read_failed" });
    }
    if (!set) return sendJson(res, 404, { ok: false, error: "not_found" });

    const { data: images, error: imgErr } = await sb
      .from("keepsake_images")
      .select("idx, storage_path, thumb_path, width, height, caption, description, scan_key, scan_lang, scan_level")
      .eq("set_id", set.id)
      .order("idx", { ascending: true });

    if (imgErr) {
      console.error("[keepsakes-set] image read failed:", imgErr.message);
      return sendJson(res, 500, { ok: false, error: "set_read_failed" });
    }

    const signed = await signPaths(sb, [
      ...(images || []).map((i) => i.storage_path),
      ...(images || []).map((i) => i.thumb_path),
    ]);

    return sendJson(res, 200, {
      ok: true,
      set: {
        setId: set.id,
        conversationId: set.conversation_id,
        scenarioId: set.scenario_id,
        scenarioLabel: set.scenario_label,
        savedAt: set.saved_at,
      },
      images: (images || [])
        .map((i) => ({
          idx: i.idx,
          url: signed.get(i.storage_path) || "",
          thumbUrl: signed.get(i.thumb_path) || "",
          width: i.width,
          height: i.height,
          caption: i.caption || "",
          description: i.description || "",
          // ── SEAM: I Spy in the album (Stage C, gated on feat/image-vocab-game) ──
          // scanKey is the picture's row in the I Spy scan cache, captured at
          // save time from the original data URI. When the chip is wired up,
          // the album round must probe convo-image-targets with this key and
          // NO imageUrl: a key-only probe returns the cached row untouched,
          // whereas sending imageUrl alongside it makes the route crop-check
          // every box, one vision call each, even on a hit.
          // scanLang and scanLevel are the other two thirds of that cache's
          // primary key (image_key, lang, level); steer the round to them or
          // the lookup legitimately misses. A null scanKey means never
          // scanned, and the round has to supply bytes and pay once.
          scanKey: i.scan_key || null,
          scanLang: i.scan_lang || null,
          scanLevel: i.scan_level || null,
        }))
        .filter((i) => i.url),
    });
  } catch (err) {
    console.error("[keepsakes-set] failed:", err?.message || err);
    return sendJson(res, 500, { ok: false, error: "set_read_failed" });
  }
}
