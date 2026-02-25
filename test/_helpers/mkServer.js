import http from "node:http";

function wrapRes(res) {
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (obj) => {
    if (!res.headersSent) res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(obj));
  };
  res.send = (body) => {
    if (typeof body === "object") return res.json(body);
    res.end(body ?? "");
  };
  return res;
}

/**
 * Wrap a (req,res) handler in a Node HTTP server, but give res
 * Express-like helpers (status/json/send) because some routes use them.
 */
export function mkServer(handler) {
  return http.createServer((req, res) => handler(req, wrapRes(res)));
}