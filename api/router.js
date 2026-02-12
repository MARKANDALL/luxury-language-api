// /api/router.js
// One-line: Single Vercel Function router that dispatches /api/router?route=... requests to route handlers.

// Single Vercel Function router that dispatches /api/router?route=... requests to route handlers.

// file: /api/router.js
// Single Vercel Function router to avoid the Hobby 12-function limit.

// IMPORTANT:
// This is the ONLY Vercel function. It must support BOTH:
// - multipart/form-data uploads (assess) -> requires bodyParser: false
// - application/json bodies (most routes) -> we hydrate req.body ourselves.
export const config = { api: { bodyParser: false, externalResolver: true } };

import crypto from "node:crypto";

import adminLabelUser from "../routes/admin-label-user.js";
import adminRecent from "../routes/admin-recent.js";
import adminUserStats from "../routes/admin-user-stats.js";
import assess from "../routes/assess.js";
import attempt from "../routes/attempt.js";
import altMeaning from "../routes/alt-meaning.js";
import convoReport from "../routes/convo-report.js";
import convoTurn from "../routes/convo-turn.js";
import evaluate from "../routes/evaluate.js";
import migrate from "../routes/migrate.js";
import pronunciationGpt from "../routes/pronunciation-gpt.js";
import realtimeWebrtcSession from "../routes/realtime-webrtc-session.js";
import tts from "../routes/tts.js";
import updateAttempt from "../routes/update-attempt.js";
import userRecent from "../routes/user-recent.js";

const ROUTES = {
  "admin-label-user": adminLabelUser,
  "admin-recent": adminRecent,
  "admin-user-stats": adminUserStats,
  "alt-meaning": altMeaning,
  assess,
  attempt,
  "convo-report": convoReport,
  "convo-turn": convoTurn,
  evaluate,
  migrate,
  "pronunciation-gpt": pronunciationGpt,
  "realtime/webrtc/session": realtimeWebrtcSession,
  tts,
  "update-attempt": updateAttempt,
  "user-recent": userRecent,
};

function mkReqId(req) {
  const existing = req.headers?.["x-request-id"];
  return (typeof existing === "string" && existing.trim()) ? existing : crypto.randomUUID();
}

async function hydrateJsonBodyIfNeeded(req, res) {
  const method = String(req.method || "GET").toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return true;

  // If some runtime already set req.body, don’t touch it.
  if (typeof req.body !== "undefined") return true;

  const ct = String(req.headers["content-type"] || "").toLowerCase();
  if (!ct.includes("application/json")) return true;

  try {
    const chunks = [];
    for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    const raw = Buffer.concat(chunks).toString("utf8").trim();
    req.body = raw ? JSON.parse(raw) : {};
    return true;
  } catch (e) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: false, error: "bad_json", detail: String(e?.message || e) }));
    return false;
  }
}

export default async function handler(req, res) {
  const requestId = mkReqId(req);
  res.setHeader("x-request-id", requestId);

  try {
    const u = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    // ============================================================
    // CORS (dev-friendly, safe default)
    // - Enables browser calls from your frontend dev server
    // - Handles preflight OPTIONS
    // ============================================================
    const origin = req.headers.origin;
    const allowList = new Set(
      String(process.env.CORS_ORIGINS || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    );

    // Dev convenience: allow localhost origins automatically
    const isLocalhost =
      typeof origin === "string" && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);

    const allowOrigin =
      (origin && (isLocalhost || allowList.has(origin))) ? origin : "";

    if (allowOrigin) {
      res.setHeader("Access-Control-Allow-Origin", allowOrigin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "content-type, x-admin-token, x-request-id"
      );
      res.setHeader(
        "Access-Control-Allow-Methods",
        "GET,POST,OPTIONS"
      );
    }

    // Preflight
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }

    // If this is JSON, populate req.body for downstream routes.
    // If it's multipart (assess), we leave the stream untouched for formidable.
    const ok = await hydrateJsonBodyIfNeeded(req, res);
    if (!ok) return;

    // Route comes from vercel rewrite (see vercel.json below)
    const route = (u.searchParams.get("route") || "").replace(/^\/+|\/+$/g, "");

    const fn = ROUTES[route];
    if (!fn) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: false, error: "unknown_route", route }));
      return;
    }

    // Make downstream handlers see the original URL shape they expect.
    // Remove `route` from query params and rewrite req.url to `/api/<route>?...`
    u.searchParams.delete("route");
    const qs = u.searchParams.toString();
    req.url = `/api/${route}` + (qs ? `?${qs}` : "");

    return fn(req, res);
  } catch (err) {
    console.error(`[router] requestId=${requestId}`, err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: false, error: "internal_error", requestId }));
    }
  }
}
