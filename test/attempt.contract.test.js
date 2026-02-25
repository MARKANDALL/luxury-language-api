import request from "supertest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkServer } from "./_helpers/mkServer.js";

beforeEach(() => {
  vi.resetModules();
  // reset singleton if your code uses globalThis.__lux_pool
  delete globalThis.__lux_pool;
});

vi.mock("pg", () => {
  class Pool {
    async query() {
      return { rows: [{ id: 123 }] };
    }
  }
  return { Pool };
});

describe("attempt contract", () => {
  it("400 if uid missing", async () => {
    const mod = await import("../api/router.js");
    const handler = mod.default || mod;
    const api = request(mkServer(handler));

    const r = await api
      .post("/api/router?route=attempt")
      .set("content-type", "application/json")
      .send({ passageKey: "harvard01" });

    expect(r.status).toBe(400);
    expect(r.body).toHaveProperty("error", "missing_uid");
  });

  it("200 + id when valid", async () => {
    const mod = await import("../api/router.js");
    const handler = mod.default || mod;
    const api = request(mkServer(handler));

    const r = await api
      .post("/api/router?route=attempt")
      .set("content-type", "application/json")
      .send({
        uid: "u_test",
        ts: Date.now(),
        passageKey: "harvard01",
        partIndex: 0,
        text: "Hello world",
        summary: { overallScore: 88 },
        sessionId: "s_test",
      });

    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, id: 123 });
  });
});