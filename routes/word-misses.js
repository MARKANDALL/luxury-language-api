// routes/word-misses.js
// One-line: the words that got away, written when a round reveals one and read
// back so the game can bring them round again.
//
// Cloned from the routes/word-history.js skeleton: CORS by the router, internal
// ADMIN_TOKEN gate, lazily-constructed Supabase that degrades rather than 500s,
// never calls a model.
//
// Contract (POST /api/word-misses):
//   { uid, lang, action: "log",   items: [ { label, level?, imageKey?, verdict } ] }
//     -> { ok: true, logged: n }
//   { uid, lang, action: "open",  limit? }
//     -> { ok: true, misses: [ { label, normalizedLabel, level, imageKey, n, lastSeen } ] }
//   { uid, lang, action: "clear", labels: ["..."] }
//     -> { ok: true, cleared: n }
//
// "open" reads the rollup view, so a word missed in four pictures comes back
// once with n=4 rather than four times. The learner model will want the same
// shape, which is why the view exists rather than the route grouping by hand.
//
// THE UID IS UNVERIFIED, exactly as it is for speech_events and coach_log: it
// is the client's device uid, self-asserted and gated only by the shared admin
// token. Nothing here makes that better or worse; see migrations/0009.

import { getSupabaseAdmin } from "../lib/supabase.js";

export const config = {
  api: {
    bodyParser: true,
    externalResolver: true,
  },
};

const MAX_ITEMS = 12;
const MAX_OPEN = 40;
const DEFAULT_OPEN = 8;

const ARTICLES = {
  en: ["the", "a", "an"],
  es: ["el", "la", "los", "las", "un", "una", "unos", "unas"],
};

/**
 * The article-stripped, accent-folded key.
 *
 * Deliberately the same shape as convo-image-targets' fold()/headNoun() pair,
 * because a miss logged from a target has to key identically to the target it
 * came from, or the two can never be matched up again.
 */
function normalize(label, lang) {
  const folded = String(label || "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!folded) return "";
  const parts = folded.split(" ");
  const list = ARTICLES[lang] || ARTICLES.en;
  if (parts.length > 1 && list.includes(parts[0])) return parts.slice(1).join(" ");
  return folded;
}

function packOf(body) {
  const raw = String(body?.lang || body?.pack || "en").toLowerCase();
  return raw.startsWith("es") ? "es" : "en";
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  const expected = (process.env.ADMIN_TOKEN || "").toString().trim();
  const got = (req.headers["x-admin-token"] || "").toString().trim();
  if (!expected || got !== expected) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  const body = req.body || {};
  const uid = String(body.uid || "").trim().slice(0, 80);
  const lang = packOf(body);
  const action = String(body.action || "").trim();

  // A miss with no owner cannot serve a learner model, and silently writing
  // orphan rows would fill the table with data no query can ever use.
  if (!uid) return res.status(400).json({ ok: false, error: "Missing uid" });

  let sb = null;
  try {
    sb = getSupabaseAdmin();
  } catch {
    // No Supabase env. The game is optional and so is its memory: it degrades
    // to a game that does not remember, not to a game that breaks.
    return res.status(200).json({ ok: true, misses: [], logged: 0, cleared: 0, reason: "no_store" });
  }

  try {
    if (action === "log") {
      const items = (Array.isArray(body.items) ? body.items : []).slice(0, MAX_ITEMS);
      const rows = items
        .map((it) => {
          const label = String(it?.label || "").trim().slice(0, 80);
          const normalized_label = normalize(label, lang);
          if (!label || !normalized_label) return null;
          const verdict = it?.verdict === "close" ? "close" : "revealed";
          return {
            uid,
            label,
            normalized_label,
            lang,
            level: String(it?.level || "").trim().slice(0, 8),
            image_key: String(it?.imageKey || "").trim().slice(0, 64) || null,
            surface: "ispy",
            verdict,
          };
        })
        .filter(Boolean);
      if (!rows.length) return res.status(200).json({ ok: true, logged: 0 });

      // AWAITED, for the reason convo-image-targets documents at length: a
      // promise abandoned as the handler responds is a write that may never
      // land, and the failure is invisible because the game still works.
      const { error } = await sb.from("word_misses").insert(rows);
      if (error) {
        console.warn("[word-misses] insert failed:", error.message);
        return res.status(200).json({ ok: true, logged: 0, reason: "write_failed" });
      }
      return res.status(200).json({ ok: true, logged: rows.length });
    }

    if (action === "open") {
      const limit = Math.min(MAX_OPEN, Math.max(1, Number(body.limit) || DEFAULT_OPEN));
      const { data, error } = await sb
        .from("word_miss_rollups")
        .select("label, normalized_label, level, n, n_open, last_seen")
        .eq("uid", uid)
        .eq("lang", lang)
        .gt("n_open", 0)
        .order("last_seen", { ascending: false })
        .limit(limit);
      if (error) {
        console.warn("[word-misses] read failed:", error.message);
        return res.status(200).json({ ok: true, misses: [], reason: "read_failed" });
      }
      return res.status(200).json({
        ok: true,
        misses: (data || []).map((r) => ({
          label: r.label,
          normalizedLabel: r.normalized_label,
          level: r.level,
          times: r.n,
          lastSeen: r.last_seen,
        })),
      });
    }

    if (action === "clear") {
      const keys = (Array.isArray(body.labels) ? body.labels : [])
        .map((l) => normalize(l, lang))
        .filter(Boolean)
        .slice(0, MAX_ITEMS);
      if (!keys.length) return res.status(200).json({ ok: true, cleared: 0 });

      const { data, error } = await sb
        .from("word_misses")
        .update({ cleared_at: new Date().toISOString() })
        .eq("uid", uid)
        .eq("lang", lang)
        .in("normalized_label", keys)
        .is("cleared_at", null)
        .select("id");
      if (error) {
        console.warn("[word-misses] clear failed:", error.message);
        return res.status(200).json({ ok: true, cleared: 0, reason: "write_failed" });
      }
      return res.status(200).json({ ok: true, cleared: (data || []).length });
    }

    return res.status(400).json({ ok: false, error: "Unknown action" });
  } catch (e) {
    console.error("[word-misses] failed", e?.message || e);
    return res.status(200).json({ ok: true, misses: [], logged: 0, cleared: 0, reason: "error" });
  }
}
