import http from "node:http";

/**
 * Wrap a Vercel-style (req,res) handler in a Node HTTP server
 * so supertest can call it.
 */
export function mkServer(handler) {
  return http.createServer((req, res) => handler(req, res));
}