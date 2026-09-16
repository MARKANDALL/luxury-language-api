// lib/admin-auth.js
// One-line: Single source of truth for ADMIN-ONLY authentication — compares the caller's key against ADMIN_KEY_PRIVATE and nothing else.
//
// WHY THIS EXISTS, AND WHY IT IS NOT ADMIN_TOKEN
// ---------------------------------------------
// ADMIN_TOKEN is shared with the frontend as VITE_ADMIN_TOKEN. Vite inlines
// VITE_* variables into the client bundle at build time, so ADMIN_TOKEN is
// readable by anyone who views source. It still gates the paid student-facing
// routes (cost control), which is all it was ever fit for.
//
// ADMIN_KEY_PRIVATE is backend-only. It is set in Vercel for Production,
// Preview and Development, exists nowhere else, and must NEVER become a VITE_
// variable, be echoed in a response body, or be sent to a student-facing page.
// Routes that expose one learner's data to another — cohort feeds, attempt
// lists, CSV export, the expense dashboard, the keepsake reaper — authenticate
// here and only here.
//
// The key travels in the dedicated `x-admin-key` request header. It is
// deliberately NOT read from the query string: a secret in a URL leaks into
// browser history, Referer headers and access logs.

import crypto from "node:crypto";

export function getHeader(req, name) {
  const h = req?.headers;
  if (!h) return "";
  // Vercel / undici / fetch-style request
  if (typeof h.get === "function") return String(h.get(name) || "").trim();
  // Node/Express-style plain object
  return String(h?.[name] ?? h?.[name.toLowerCase()] ?? "").trim();
}

export function normKey(v) {
  const s = String(v || "").trim();
  // strip one pair of surrounding quotes if present
  return s.replace(/^["'](.*?)["']$/, "$1").trim();
}

// Constant-time, length-independent secret comparison (compare SHA-256 digests
// so a byte-by-byte timing side-channel can't leak the key length or value).
function secretsMatch(a, b) {
  const da = crypto.createHash("sha256").update(String(a || ""), "utf8").digest();
  const db = crypto.createHash("sha256").update(String(b || ""), "utf8").digest();
  return crypto.timingSafeEqual(da, db);
}

// Header only — see the note above about secrets in URLs.
export function readAdminKey(req) {
  return normKey(getHeader(req, "x-admin-key"));
}

// True only when the caller presented ADMIN_KEY_PRIVATE. An unset env var means
// false, never "open": a misconfigured deployment must fail closed.
export function isAdminKeyRequest(req) {
  const expected = normKey(process.env.ADMIN_KEY_PRIVATE);
  if (!expected) return false;
  const provided = readAdminKey(req);
  return !!provided && secretsMatch(provided, expected);
}

// Uniform rejection for admin-only routes. The body never distinguishes
// "wrong key" from "key not configured" — that difference is for the logs, not
// for the caller.
export function sendUnauthorized(res, extra) {
  if (res.headersSent) return;
  res.statusCode = 401;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ ok: false, error: "unauthorized", ...(extra || {}) }));
}
