// lib/keepsakes.js
// One-line: Shared constants and helpers for the convo keepsake routes (storage keys, TTLs, set lookup, reaping).
//
// The bytes live in the private Supabase Storage bucket "keepsakes"; the tables
// keepsake_sets / keepsake_images (migrations/0005_keepsakes.sql) hold only
// metadata and the object key.
//
// The one idea this file exists to protect: an object is written ONCE under its
// final key and NEVER moves. Promoting a set is a single UPDATE of its status.
// That is what makes Save instant, and it is why a straggler image that finishes
// uploading after the learner tapped Keep still lands in the saved set.

import { getSupabaseAdmin } from "./supabase.js";

export const KEEPSAKE_BUCKET = "keepsakes";

// How long an unsaved set survives before routes/keepsakes-cleanup.js reaps it.
export const PENDING_TTL_HOURS = 24;

// Signed-URL lifetime. Long enough to browse an album without re-signing,
// short enough that a leaked URL is not a permanent handle on the object.
export const SIGNED_URL_TTL_SECONDS = 60 * 60;

// Generous ceiling on one uploaded image. The browser sends ~91 KB at q80/1280
// and ~13 KB for the thumb, so this is roughly 20x headroom and exists only to
// stop a malformed or hostile caller writing something enormous.
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/**
 * Storage keys and ids come from the browser, so they are untrusted input that
 * gets concatenated into an object path. Allow only characters that cannot
 * traverse or escape a path segment. Returns "" when the value is unusable.
 */
export function safeKeyPart(value) {
  const s = String(value ?? "").trim();
  if (!s || s.length > 128) return "";
  return /^[A-Za-z0-9_-]+$/.test(s) ? s : "";
}

/** Object key for one keepsake. `kind` is "full" or "thumb". */
export function objectKey(uid, conversationId, idx, kind) {
  const suffix = kind === "thumb" ? "-thumb" : "";
  return `${uid}/${conversationId}/${idx}${suffix}.webp`;
}

/** Both object keys for one keepsake, in one call. */
export function objectKeyPair(uid, conversationId, idx) {
  return {
    storagePath: objectKey(uid, conversationId, idx, "full"),
    thumbPath: objectKey(uid, conversationId, idx, "thumb"),
  };
}

export function getKeepsakeStore() {
  return getSupabaseAdmin().storage.from(KEEPSAKE_BUCKET);
}

/** ISO timestamp for a fresh pending set's expiry. */
export function pendingExpiryIso(now = new Date()) {
  return new Date(now.getTime() + PENDING_TTL_HOURS * 3600 * 1000).toISOString();
}

/**
 * Decode a base64 payload into a Buffer, rejecting anything that is not a
 * plausible image of a sane size. Accepts a bare base64 string or a data: URI.
 * Returns { buffer } or { error }.
 */
export function decodeImagePayload(value, label) {
  if (typeof value !== "string" || !value) {
    return { error: `${label} is required` };
  }
  const base64 = value.startsWith("data:")
    ? value.slice(value.indexOf(",") + 1)
    : value;

  let buffer;
  try {
    buffer = Buffer.from(base64, "base64");
  } catch {
    return { error: `${label} is not valid base64` };
  }
  if (!buffer.length) return { error: `${label} decoded to zero bytes` };
  if (buffer.length > MAX_IMAGE_BYTES) {
    return { error: `${label} exceeds ${MAX_IMAGE_BYTES} bytes` };
  }
  // WebP files are "RIFF....WEBP". Cheap sanity check that also stops a caller
  // parking arbitrary blobs in the bucket.
  const isWebp =
    buffer.length > 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP";
  if (!isWebp) return { error: `${label} is not a WebP image` };

  return { buffer };
}

/**
 * Every object key belonging to a set, derived from its image rows.
 * Used by both the delete route and the cleanup cron.
 */
export function objectPathsForImages(images) {
  const paths = [];
  for (const img of images || []) {
    if (img?.storage_path) paths.push(img.storage_path);
    if (img?.thumb_path) paths.push(img.thumb_path);
  }
  return paths;
}

/**
 * Delete a set's storage objects and then its rows. Storage first: if the row
 * survives a failed object delete we can retry, whereas deleting the row first
 * would orphan the bytes with nothing left pointing at them.
 *
 * Returns { removedObjects, error }.
 */
export async function purgeSets(sb, sets) {
  const ids = (sets || []).map((s) => s.id).filter(Boolean);
  if (!ids.length) return { removedObjects: 0, error: null };

  const { data: images, error: readErr } = await sb
    .from("keepsake_images")
    .select("set_id, storage_path, thumb_path")
    .in("set_id", ids);
  if (readErr) return { removedObjects: 0, error: readErr };

  const paths = objectPathsForImages(images);
  if (paths.length) {
    const { error: rmErr } = await sb.storage.from(KEEPSAKE_BUCKET).remove(paths);
    // A missing object is not a reason to keep the row: the goal is that
    // nothing survives. Log and continue so the rows still go.
    if (rmErr) console.warn("[keepsakes] storage remove failed:", rmErr.message);
  }

  // keepsake_images has on delete cascade, so removing the sets clears both.
  const { error: delErr } = await sb.from("keepsake_sets").delete().in("id", ids);
  if (delErr) return { removedObjects: paths.length, error: delErr };

  return { removedObjects: paths.length, error: null };
}

/**
 * Sign many object paths in one round trip. Returns a Map of path -> signed URL.
 * Paths that fail to sign are simply absent, so a caller renders what it can
 * rather than failing the whole album for one bad object.
 */
export async function signPaths(sb, paths, expiresIn = SIGNED_URL_TTL_SECONDS) {
  const out = new Map();
  const unique = [...new Set((paths || []).filter(Boolean))];
  if (!unique.length) return out;

  const { data, error } = await sb.storage
    .from(KEEPSAKE_BUCKET)
    .createSignedUrls(unique, expiresIn);
  if (error) {
    console.warn("[keepsakes] createSignedUrls failed:", error.message);
    return out;
  }
  for (const row of data || []) {
    if (row?.path && row?.signedUrl) out.set(row.path, row.signedUrl);
  }
  return out;
}
