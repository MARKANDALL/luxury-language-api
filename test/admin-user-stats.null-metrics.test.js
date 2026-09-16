// The same coercion as convo-report, on the admin cohort dashboard:
// routes/admin-user-stats.js read `Number(r?.summary?.pron)`, and Number(null)
// is 0. An attempt Azure never scored — a typed conversation turn — dragged a
// learner's average, recent average and delta down by a whole attempt's worth
// of zero, on the one screen the teacher uses to decide who needs help.
// Driven through the handler directly rather than api/router.js: this route
// reads req.query, which Vercel populates and the test router does not.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const sb = vi.hoisted(() => ({ attempts: [], users: [] }));

// Minimal PostgREST-shaped builder: only the calls this route actually makes.
vi.mock("../lib/supabase.js", () => {
  const chain = (rows) => {
    const q = {
      select: () => q,
      gte: () => q,
      lte: () => q,
      order: () => q,
      in: () => q,
      limit: () => q,
      then: (ok, err) => Promise.resolve({ data: rows, error: null }).then(ok, err),
    };
    return q;
  };
  return {
    getSupabaseAdmin: () => ({
      from: (table) => chain(table === "lux_users" ? sb.users : sb.attempts),
    }),
  };
});

const KEY = "test-admin-key-private";
let prevKey;

beforeEach(() => {
  vi.resetModules();
  sb.attempts = [];
  sb.users = [];
  prevKey = process.env.ADMIN_KEY_PRIVATE;
  process.env.ADMIN_KEY_PRIVATE = KEY;
});

afterEach(() => {
  if (prevKey === undefined) delete process.env.ADMIN_KEY_PRIVATE;
  else process.env.ADMIN_KEY_PRIVATE = prevKey;
});

const at = (pron) => ({
  uid: "u1",
  ts: "2026-09-04T10:00:00.000Z",
  passage_key: "convo:cafe",
  summary: { pron },
});

function fakeRes() {
  const out = { code: 0, body: null, headers: {} };
  return {
    setHeader: (k, v) => { out.headers[k] = v; },
    status(c) { out.code = c; return this; },
    json(b) { out.body = b; return this; },
    out,
  };
}

async function stats() {
  const { default: handler } = await import("../routes/admin-user-stats.js");
  const res = fakeRes();
  await handler(
    {
      method: "GET",
      headers: { "x-admin-key": KEY },
      query: { from: "2026-09-01", to: "2026-09-04", window: "7" },
    },
    res
  );
  expect(res.out.code).toBe(200);
  return res.out.body.rows[0];
}

describe("admin-user-stats: an unscored attempt is not a zero", () => {
  it("averages only the scored attempts", async () => {
    sb.attempts = [at(88), at(90), at(86), at(null)];

    const row = await stats();
    expect(row.avg_pron).toBe(88); // was 66 when null coerced to 0
    expect(row.recent_avg).toBe(88);
  });

  it("still counts the unscored attempt as an attempt", async () => {
    sb.attempts = [at(88), at(90), at(86), at(null)];
    expect((await stats()).attempts).toBe(4);
  });

  it("keeps a genuine zero", async () => {
    sb.attempts = [at(100), at(0)];
    expect((await stats()).avg_pron).toBe(50);
  });

  it("reports null, not 0, for a learner whose attempts all went unscored", async () => {
    sb.attempts = [at(null), at(null)];

    const row = await stats();
    expect(row.avg_pron).toBeNull();
    expect(row.attempts).toBe(2);
  });
});
