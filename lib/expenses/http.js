// lib/expenses/http.js
// One-line: Shared request helpers for the expense endpoints — admin/cron auth, JSON send, body read.
//
// Mirrors the admin-token contract used by api/router.js (x-admin-token header
// or ?token= query param, compared to ADMIN_TOKEN). The refresh endpoint also
// accepts a Vercel cron call authorized by CRON_SECRET (Authorization: Bearer).

export function getHeader(req, name) {
  const h = req?.headers;
  if (!h) return "";
  if (typeof h.get === "function") return String(h.get(name) || "").trim();
  return String(h?.[name] ?? h?.[name.toLowerCase()] ?? "").trim();
}

export function normToken(v) {
  const s = String(v || "").trim();
  return s.replace(/^["'](.*?)["']$/, "$1").trim();
}

function tokenFromUrl(req) {
  try {
    const u = new URL(req.url, `http://${getHeader(req, "host") || "localhost"}`);
    return normToken(u.searchParams.get("token") || "");
  } catch {
    return "";
  }
}

export function readAdminToken(req) {
  return normToken(getHeader(req, "x-admin-token")) || tokenFromUrl(req);
}

// True when the caller presented the shared admin token.
export function isAdmin(req) {
  const expected = normToken(process.env.ADMIN_TOKEN);
  if (!expected) return false;
  const token = readAdminToken(req);
  return !!token && token === expected;
}

// True when the caller is Vercel Cron. Vercel attaches
// `Authorization: Bearer <CRON_SECRET>` to scheduled invocations when the
// CRON_SECRET env var is set. Returns false if CRON_SECRET is unset.
export function isVercelCron(req) {
  const secret = normToken(process.env.CRON_SECRET);
  if (!secret) return false;
  const auth = getHeader(req, "authorization");
  const m = /^Bearer\s+(.+)$/i.exec(auth || "");
  const bearer = m ? normToken(m[1]) : "";
  return !!bearer && bearer === secret;
}

export function sendJson(res, status, body) {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(status === 204 ? "" : JSON.stringify(body));
}

// The router already hydrates req.body for application/json POSTs. This is a
// resilient fallback that also handles string bodies and raw streams.
export async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  try {
    const chunks = [];
    for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    const raw = Buffer.concat(chunks).toString("utf8").trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}
