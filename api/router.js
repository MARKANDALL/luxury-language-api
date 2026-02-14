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
import attempt from "../routes/attempt.js";
import altMeaning from "../routes/alt-meaning.js";
import convoReport from "../routes/convo-report.js";
import convoTurn from "../routes/convo-turn.js";
import migrate from "../routes/migrate.js";
import realtimeWebrtcSession from "../routes/realtime-webrtc-session.js";
import updateAttempt from "../routes/update-attempt.js";
import userRecent from "../routes/user-recent.js";

function getHeader(req, name) {
  const h = req?.headers;
  if (!h) return "";
  // Vercel / undici / fetch-style request
  if (typeof h.get === "function") return String(h.get(name) || "").trim();
  // Node/Express-style plain object
  return String(h?.[name] ?? h?.[name.toLowerCase()] ?? "").trim();
}

function normToken(v) {
  const s = String(v || "").trim();
  // strip one pair of surrounding quotes if present
  return s.replace(/^["'](.*)["']$/, "$1").trim();
}

function isAdminRequest(req, u) {
  const token = normToken(
    getHeader(req, "x-admin-token") ||
    String(u?.searchParams?.get("token") || "")
  );

  const expected = normToken(process.env.ADMIN_TOKEN);

  if (!expected) return false;
  return token && token === expected;
}

function mkReqId(req) {
  const existing = getHeader(req, "x-request-id");
  return (typeof existing === "string" && existing.trim()) ? existing : crypto.randomUUID();
}

function resolveHandler(mod) {
  // Prefer default export, but tolerate named exports if you ever refactor.
  return mod?.default || mod?.handler || null;
}

function lazyRoute(importer, name) {
  let cached = null;
  let cachedPromise = null;

  return async function lazyLoadedHandler(req, res) {
    try {
      if (!cached) {
        cachedPromise = cachedPromise || importer();
        const mod = await cachedPromise;
        cached = resolveHandler(mod);
        if (!cached) throw new Error(`${name}: could not resolve handler export`);
      }
      return await cached(req, res);
    } catch (err) {
      // Reset so dev hot-reload / transient failures can retry.
      cached = null;
      cachedPromise = null;

      console.error(`[router] ${name} lazy-load crash`, err);

      if (res.headersSent) return;

      const requestId =
        (typeof res.getHeader === "function" && res.getHeader("x-request-id")) || null;

      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(
        JSON.stringify({
          ok: false,
          error: "route_failed",
          where: name,
          requestId,
        })
      );
    }
  };
}

// Risky/heavy routes: lazy-load so one bad import can't take down the whole router.
const evaluate = lazyRoute(() => import("../routes/evaluate.js"), "routes/evaluate");
const assess = lazyRoute(() => import("../routes/assess.js"), "routes/assess");
const tts = lazyRoute(() => import("../routes/tts.js"), "routes/tts");
const pronunciationGpt = lazyRoute(
  () => import("../routes/pronunciation-gpt.js"),
  "routes/pronunciation-gpt"
);

// Dev/proxy sanity check endpoint:
// GET /api/ping   -> { ok: true, ... }
// GET /api/health -> alias of /api/ping
// (Do NOT include secret values; only booleans.)
function ping(req, res) {
  const payload = {
    ok: true,
    service: "luxury-language-api",
    ts: new Date().toISOString(),
    node: process.version,
    request: {
      method: req?.method,
      url: req?.url,
      host: getHeader(req, "host") || null,
    },
    env: {
      hasAdminToken: !!process.env.ADMIN_TOKEN,
      hasAzureSpeechKey: !!process.env.AZURE_SPEECH_KEY,
      hasAzureSpeechRegion: !!process.env.AZURE_SPEECH_REGION,
      hasOpenAIKey: !!process.env.OPENAI_API_KEY,
      hasSupabaseUrl: !!process.env.SUPABASE_URL,
    },
  };

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

const ROUTES = {
  ping,
  health: ping,
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

async function hydrateJsonBodyIfNeeded(req, res) {
  const method = String(req.method || "GET").toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return true;

  // If some runtime already set req.body, don’t touch it.
  if (typeof req.body !== "undefined") return true;

const ct = String(getHeader(req, "content-type") || "").toLowerCase();
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
const u = new URL(req.url, `http://${getHeader(req, "host") || "localhost"}`);
    const route = (u.searchParams.get("route") || "").replace(/^\/+|\/+$/g, "");

    // Router-level admin gating (cost-control)
    const ADMIN_ONLY = new Set([
      "tts",
      "pronunciation-gpt",
      "evaluate",
      "assess",
      // add more later if needed:
      // "admin-label-user",
      // "admin-recent",
      // "admin-user-stats",
      // "migrate",
    ]);

    if (ADMIN_ONLY.has(route) && !isAdminRequest(req, u)) {
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ ok: false, error: "unauthorized", route, requestId }));
      return;
    }

    // ============================================================
    // CORS (dev-friendly, safe default)
    // - Enables browser calls from your frontend dev server
    // - Handles preflight OPTIONS
    // ============================================================
    const origin = getHeader(req, "origin");
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

    return await fn(req, res);
  } catch (err) {
    console.error(`[router] requestId=${requestId}`, err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: false, error: "internal_error", requestId }));
    }
  }
}
