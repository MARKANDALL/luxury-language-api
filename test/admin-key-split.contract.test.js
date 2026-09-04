// test/admin-key-split.contract.test.js
// One-line: Locks the ADMIN_TOKEN / ADMIN_KEY_PRIVATE split — admin-only routes accept the private key ONLY, student-facing routes are untouched.
//
// ADMIN_TOKEN ships inside the client bundle as VITE_ADMIN_TOKEN, so it must
// never open a route that exposes one learner's data to another. These tests
// exist so that guarantee fails loudly if someone re-widens a gate.

import request from "supertest";
import { describe, it, expect, beforeAll, vi } from "vitest";
import { mkServer } from "./_helpers/mkServer.js";

const ADMIN_TOKEN = "bundled_token_readable_by_anyone";
const ADMIN_KEY_PRIVATE = "backend_only_private_key";

beforeAll(() => {
  process.env.ADMIN_TOKEN = ADMIN_TOKEN;
  process.env.ADMIN_KEY_PRIVATE = ADMIN_KEY_PRIVATE;
  // Keep the DB/vendor layers out of this: every assertion below is about the
  // auth decision, which happens before any handler touches a datastore.
  process.env.CORS_ORIGINS = "";
});

// Routes that must reject ADMIN_TOKEN and accept ADMIN_KEY_PRIVATE.
// Cron-reachable routes are excluded from the router set on purpose and are
// asserted separately below.
const ADMIN_ONLY_ROUTES = [
  { route: "admin-recent", method: "get" },
  { route: "admin-user-stats", method: "get" },
  { route: "admin-label-user", method: "get" },
  { route: "admin/expenses/summary", method: "get" },
  { route: "admin/expenses/manual", method: "post" },
  { route: "admin/expenses/migrate", method: "post" },
];

// Cron-reachable admin routes: self-gated, so the router lets them through and
// the handler decides. They must still refuse ADMIN_TOKEN.
const CRON_REACHABLE_ADMIN_ROUTES = [
  { route: "admin/expenses/refresh", method: "post" },
  { route: "keepsakes/cleanup", method: "get" },
];

// Student-facing routes must keep behaving EXACTLY as before: ADMIN_TOKEN
// opens them, and the private key does not.
const STUDENT_ROUTES = [
  { route: "word-info", method: "post" },
  { route: "learner-model", method: "post" },
];

async function mkClient() {
  const mod = await import("../api/router.js");
  const handler = mod.default || mod.handler || mod;
  return request(mkServer(handler));
}

function call(api, { route, method }, headers) {
  const req = api[method](`/api/router?route=${encodeURIComponent(route)}`);
  for (const [k, v] of Object.entries(headers || {})) req.set(k, v);
  if (method === "post") req.set("content-type", "application/json").send({});
  return req;
}

describe("admin key split — admin-only routes reject the bundled ADMIN_TOKEN", () => {
  for (const target of ADMIN_ONLY_ROUTES) {
    it(`${target.route}: x-admin-token -> 401`, async () => {
      const api = await mkClient();
      const r = await call(api, target, { "x-admin-token": ADMIN_TOKEN });
      expect(r.status).toBe(401);
      expect(r.body).toMatchObject({ error: "unauthorized" });
    });

    it(`${target.route}: ?token= in the URL -> 401`, async () => {
      const api = await mkClient();
      const r = await api[target.method](
        `/api/router?route=${encodeURIComponent(target.route)}&token=${ADMIN_TOKEN}`
      );
      expect(r.status).toBe(401);
    });

    it(`${target.route}: the private key in ?key= is also refused (header only)`, async () => {
      const api = await mkClient();
      const r = await api[target.method](
        `/api/router?route=${encodeURIComponent(target.route)}&key=${ADMIN_KEY_PRIVATE}`
      );
      expect(r.status).toBe(401);
    });

    it(`${target.route}: no credentials -> 401`, async () => {
      const api = await mkClient();
      const r = await call(api, target, {});
      expect(r.status).toBe(401);
    });

    it(`${target.route}: x-admin-key gets PAST the auth gate`, async () => {
      const api = await mkClient();
      const r = await call(api, target, { "x-admin-key": ADMIN_KEY_PRIVATE });
      // The route runs. Without a live DB it may fail downstream (500) or
      // reject the empty body (400) — what matters is that it is no longer 401.
      expect(r.status).not.toBe(401);
    });
  }
});

describe("admin key split — cron-reachable admin routes still refuse ADMIN_TOKEN", () => {
  for (const target of CRON_REACHABLE_ADMIN_ROUTES) {
    it(`${target.route}: x-admin-token -> 401`, async () => {
      const api = await mkClient();
      const r = await call(api, target, { "x-admin-token": ADMIN_TOKEN });
      expect(r.status).toBe(401);
    });

    it(`${target.route}: x-admin-key gets past the auth gate`, async () => {
      const api = await mkClient();
      const r = await call(api, target, { "x-admin-key": ADMIN_KEY_PRIVATE });
      expect(r.status).not.toBe(401);
    });
  }

  it("the CRON_SECRET bearer path is independent of both admin secrets", async () => {
    process.env.CRON_SECRET = "cron_secret_value";
    const api = await mkClient();
    const r = await api
      .get("/api/router?route=keepsakes/cleanup")
      .set("authorization", "Bearer cron_secret_value");
    expect(r.status).not.toBe(401);
    delete process.env.CRON_SECRET;
  });
});

describe("admin key split — student-facing routes are unchanged", () => {
  for (const target of STUDENT_ROUTES) {
    it(`${target.route}: still opens with ADMIN_TOKEN`, async () => {
      const api = await mkClient();
      const r = await call(api, target, { "x-admin-token": ADMIN_TOKEN });
      expect(r.status).not.toBe(401);
    });

    // The router still honours ?token= for the student surface. Asserted at the
    // router layer specifically: this harness is bare node:http, so req.query is
    // undefined and the route's own second gate can't see a URL token. A
    // router-level rejection is identifiable by the `requestId` field, which the
    // in-handler 401 bodies do not carry.
    it(`${target.route}: the ROUTER still accepts ?token= in the URL`, async () => {
      const api = await mkClient();
      const r = await api[target.method](
        `/api/router?route=${encodeURIComponent(target.route)}&token=${ADMIN_TOKEN}`
      ).set("content-type", "application/json").send({});
      const rejectedByRouter = r.status === 401 && r.body?.requestId !== undefined;
      expect(rejectedByRouter).toBe(false);
    });

    it(`${target.route}: the router REJECTS a bad ?token=`, async () => {
      const api = await mkClient();
      const r = await api[target.method](
        `/api/router?route=${encodeURIComponent(target.route)}&token=not-the-token`
      ).set("content-type", "application/json").send({});
      expect(r.status).toBe(401);
      expect(r.body).toMatchObject({ error: "unauthorized", route: target.route });
    });

    it(`${target.route}: still 401s without any credential`, async () => {
      const api = await mkClient();
      const r = await call(api, target, {});
      expect(r.status).toBe(401);
    });

    it(`${target.route}: the private key does NOT open it`, async () => {
      const api = await mkClient();
      const r = await call(api, target, { "x-admin-key": ADMIN_KEY_PRIVATE });
      expect(r.status).toBe(401);
    });
  }
});

describe("admin key split — the private key never reaches a caller", () => {
  it("ping reports only a boolean, never the key value", async () => {
    const api = await mkClient();
    const r = await api.get("/api/router?route=ping");
    expect(r.status).toBe(200);
    expect(r.body.env.hasAdminKeyPrivate).toBe(true);
    expect(JSON.stringify(r.body)).not.toContain(ADMIN_KEY_PRIVATE);
  });

  it("a 401 body does not echo either secret", async () => {
    const api = await mkClient();
    const r = await call(api, ADMIN_ONLY_ROUTES[0], { "x-admin-token": ADMIN_TOKEN });
    const body = JSON.stringify(r.body);
    expect(body).not.toContain(ADMIN_KEY_PRIVATE);
    expect(body).not.toContain(ADMIN_TOKEN);
  });

  it("no log line emitted during a rejected admin call contains the key", async () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const api = await mkClient();
    await call(api, ADMIN_ONLY_ROUTES[0], { "x-admin-key": "wrong-key-attempt" });

    const written = [...spy.mock.calls, ...errSpy.mock.calls, ...logSpy.mock.calls]
      .flat()
      .map((x) => (typeof x === "string" ? x : JSON.stringify(x ?? "")))
      .join(" ");
    expect(written).not.toContain(ADMIN_KEY_PRIVATE);

    spy.mockRestore();
    errSpy.mockRestore();
    logSpy.mockRestore();
  });
});

describe("admin key split — the gate fails closed", () => {
  it("an unset ADMIN_KEY_PRIVATE rejects everyone, including a matching empty header", async () => {
    const saved = process.env.ADMIN_KEY_PRIVATE;
    delete process.env.ADMIN_KEY_PRIVATE;
    try {
      const api = await mkClient();
      const r = await call(api, ADMIN_ONLY_ROUTES[0], { "x-admin-key": "" });
      expect(r.status).toBe(401);
      const r2 = await call(api, ADMIN_ONLY_ROUTES[0], { "x-admin-key": ADMIN_KEY_PRIVATE });
      expect(r2.status).toBe(401);
    } finally {
      process.env.ADMIN_KEY_PRIVATE = saved;
    }
  });
});
