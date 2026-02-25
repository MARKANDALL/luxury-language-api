import request from "supertest";
import { mkServer } from "./_helpers/mkServer.js";
import { describe, it, expect } from "vitest";

async function mkClient() {
  const mod = await import("../api/router.js"); // adjust if needed
  const handler = mod.default || mod.handler || mod;
  const server = mkServer(handler);
  return request(server);
}

describe("api/router contract", () => {
  it("GET ping returns 200 + json", async () => {
    const api = await mkClient();
    const r = await api.get("/api/router?route=ping");
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toContain("application/json");
    expect(r.body).toHaveProperty("ok");
    expect(r.body).toHaveProperty("env");
  });

  it("GET health behaves like ping", async () => {
    const api = await mkClient();
    const r = await api.get("/api/router?route=health");
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty("ok");
  });

  it("unknown route returns 404", async () => {
    const api = await mkClient();
    const r = await api.get("/api/router?route=does-not-exist");
    expect(r.status).toBe(404);
  });
});