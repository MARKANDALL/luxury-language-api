// file: /api/router.js
// Single Vercel Function router to avoid the Hobby 12-function limit.

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

export default async function handler(req, res) {
  const u = new URL(req.url, `http://${req.headers.host || "localhost"}`);

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
}
