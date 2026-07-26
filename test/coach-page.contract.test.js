// test/coach-page.contract.test.js
// Contract test for the unified coach page on /api/router?route=coach-page, with
// THE COACH ROUTER running inside it as a pre-pass. Mirrors
// coach-ask.contract.test.js: hermetic — Supabase and OpenAI are both mocked, so
// no network is ever reached.
//
// The OpenAI mock answers BOTH calls off one spy and tells them apart by the
// system prompt, so every test can assert the thing that matters most here:
// HOW MANY model calls actually happened. One call means the cost gate fired.
import request from "supertest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkServer } from "./_helpers/mkServer.js";
import { OFF_SCOPE_REPLIES } from "../routes/coach-page/router.js";

const { state, insertSpy, fromSpy, createSpy } = vi.hoisted(() => {
  const state = {
    classification: {
      lane: "LANGUAGE_GENERAL",
      in_scope: true,
      route_target: "",
      route_question: "",
      confidence: 0.9,
    },
    classifyRaw: null, // set to a string to bypass JSON.stringify(classification)
    classifyThrows: false,
    answer: "Here's the short version, and one thing to try.",
  };

  const insertSpy = vi.fn(() => Promise.resolve({ error: null }));
  const fromSpy = vi.fn(() => ({ insert: insertSpy }));

  const createSpy = vi.fn(async (body) => {
    const sys = String(body?.messages?.[0]?.content || "");
    const isRouter = sys.includes("traffic controller for the Lux AI Coach");
    if (isRouter) {
      if (state.classifyThrows) throw new Error("router upstream down");
      const content =
        state.classifyRaw != null ? state.classifyRaw : JSON.stringify(state.classification);
      return { choices: [{ message: { content } }] };
    }
    return { choices: [{ message: { content: JSON.stringify({ answer: state.answer }) } }] };
  });

  return { state, insertSpy, fromSpy, createSpy };
});

vi.mock("../lib/supabase.js", () => ({
  getSupabaseAdmin: () => ({ from: fromSpy }),
}));

vi.mock("openai", () => ({
  OpenAI: class {
    constructor() {
      this.chat = { completions: { create: createSpy } };
    }
  },
}));

beforeEach(() => {
  vi.resetModules();
  insertSpy.mockClear();
  fromSpy.mockClear();
  createSpy.mockClear();
  state.classification = {
    lane: "LANGUAGE_GENERAL",
    in_scope: true,
    route_target: "",
    route_question: "",
    confidence: 0.9,
  };
  state.classifyRaw = null;
  state.classifyThrows = false;
  state.answer = "Here's the short version, and one thing to try.";
  process.env.ADMIN_TOKEN = "test_admin_token";
  // Model tiers are per-test; start every test from the built-in defaults.
  delete process.env.LUX_AI_QUICK_MODEL;
  delete process.env.LUX_AI_MODEL;
  delete process.env.LUX_AI_DEEP_MODEL;
});

async function client() {
  const mod = await import("../api/router.js");
  const handler = mod.default || mod;
  return request(mkServer(handler));
}

function ask(api, body) {
  return api
    .post("/api/router?route=coach-page")
    .set("x-admin-token", "test_admin_token")
    .send(body);
}

// The two calls the route can make, pulled back out of the shared spy.
const routerCall = () =>
  createSpy.mock.calls.find((c) =>
    String(c[0]?.messages?.[0]?.content || "").includes("traffic controller")
  )?.[0];
const mainCall = () =>
  createSpy.mock.calls.find(
    (c) => !String(c[0]?.messages?.[0]?.content || "").includes("traffic controller")
  )?.[0];

describe("coach-page — gate and validation", () => {
  it("401s without the admin token, and never reaches a model", async () => {
    const api = await client();
    const r = await api.post("/api/router?route=coach-page").send({ message: "hola" });
    expect(r.status).toBe(401);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("400s with no message, and never reaches a model", async () => {
    const api = await client();
    const r = await ask(api, { pageId: "picker" });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ ok: false, error: "bad_request" });
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("405s on GET", async () => {
    const api = await client();
    const r = await api.get("/api/router?route=coach-page").set("x-admin-token", "test_admin_token");
    expect(r.status).toBe(405);
  });
});

describe("coach-page — the pre-pass runs inside the route, not beside it", () => {
  it("classifies then answers in ONE round trip (two model calls, one response)", async () => {
    state.classification = { lane: "EXPLAIN", in_scope: true, confidence: 0.97 };
    const api = await client();
    const r = await ask(api, {
      pageId: "practiceSkills",
      anchor: { type: "phoneme", text: "/r/" },
      message: "why is this one red",
      learner: { level: "B1", l1: "es", flags: ["r-tap"] },
    });

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, lane: "EXPLAIN", in_scope: true, advisory: false });
    expect(r.body.answer).toBe(state.answer);
    expect(r.body.route).toBeNull();
    expect(r.body.offScope).toBeNull();
    expect(createSpy).toHaveBeenCalledTimes(2);
  });

  it("runs the classifier on the quick model and the answer on the main model", async () => {
    process.env.LUX_AI_QUICK_MODEL = "quick-tier";
    process.env.LUX_AI_MODEL = "main-tier";
    const api = await client();
    await ask(api, { pageId: "picker", message: "how do people greet each other in Mexico" });
    expect(routerCall().model).toBe("quick-tier");
    expect(routerCall().temperature).toBe(0);
    expect(mainCall().model).toBe("main-tier");
  });

  it("defaults to the cheap tier for the classifier and the answering tier for the answer", async () => {
    const api = await client();
    await ask(api, { pageId: "picker", message: "what does órale mean" });
    expect(routerCall().model).toBe("gpt-4.1-mini");
    expect(mainCall().model).toBe("gpt-4.1");
  });

  it("hands the classifier the page, anchor, learner and recent exchanges", async () => {
    const api = await client();
    await ask(api, {
      pageId: "guidedChat",
      anchor: { type: "bubble", text: "No manches, ¿en serio?" },
      message: "why did she say it like that",
      learner: { level: "A2", l1: "en", flags: ["th-stopping"] },
      logTail: [{ page_id: "picker", lane: "NAV_HELP", message: "where do I start" }],
    });
    const sent = JSON.parse(routerCall().messages[1].content);
    expect(sent).toMatchObject({
      pageId: "guidedChat",
      anchor: { type: "bubble", text: "No manches, ¿en serio?" },
      message: "why did she say it like that",
    });
    expect(sent.learner).toMatchObject({ level: "A2", l1: "en", flags: ["th-stopping"] });
    expect(sent.recent[0]).toMatchObject({ pageId: "picker", lane: "NAV_HELP" });
  });

  it("attaches the lane to the main call", async () => {
    state.classification = { lane: "PATTERNS", in_scope: true, confidence: 0.94 };
    const api = await client();
    await ask(api, { pageId: "practiceSkills", message: "do I always mess up the th sound" });
    expect(mainCall().messages[0].content).toContain("TASK — PATTERNS");
    expect(JSON.parse(mainCall().messages[1].content).lane).toBe("PATTERNS");
  });
});

describe("coach-page — OFF_SCOPE is the cost gate", () => {
  const offScope = { lane: "OFF_SCOPE", in_scope: false, confidence: 0.98 };

  it("short-circuits before the expensive call (ONE model call, canned answer)", async () => {
    state.classification = offScope;
    const api = await client();
    const r = await ask(api, { pageId: "picker", message: "what's the weather in Kenya right now" });

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, lane: "OFF_SCOPE", in_scope: false });
    expect(r.body.answer).toBe(OFF_SCOPE_REPLIES.conversion.en);
    expect(r.body.offScope).toEqual({ kind: "conversion" });
    expect(createSpy).toHaveBeenCalledTimes(1); // the big model was never touched
    expect(mainCall()).toBeUndefined();
  });

  it("gives the plain redirect once the session has spent its conversion", async () => {
    state.classification = offScope;
    const api = await client();
    const r = await ask(api, {
      pageId: "picker",
      message: "who won the game last night",
      conversionUsed: true,
    });
    expect(r.body.answer).toBe(OFF_SCOPE_REPLIES.plain.en);
    expect(r.body.offScope).toEqual({ kind: "plain" });
    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  it("redirects in Spanish for the es pack", async () => {
    state.classification = offScope;
    const api = await client();
    const first = await ask(api, { pageId: "picker", message: "¿qué tiempo hace en Kenia?", lang: "es" });
    expect(first.body.answer).toBe(OFF_SCOPE_REPLIES.conversion.es);

    const second = await ask(api, {
      pageId: "picker",
      message: "¿y el partido de anoche?",
      lang: "es",
      conversionUsed: true,
    });
    expect(second.body.answer).toBe(OFF_SCOPE_REPLIES.plain.es);
  });

  it("LOW CONFIDENCE IS NOT A REFUSAL: an unsure OFF_SCOPE proceeds to a real answer", async () => {
    state.classification = { lane: "OFF_SCOPE", in_scope: false, confidence: 0.3 };
    const api = await client();
    const r = await ask(api, { pageId: "picker", message: "how do I say this at a wedding in Oaxaca" });

    expect(r.body).toMatchObject({ ok: true, lane: "LANGUAGE_GENERAL", in_scope: true, advisory: true });
    expect(r.body.answer).toBe(state.answer);
    expect(r.body.offScope).toBeNull();
    expect(createSpy).toHaveBeenCalledTimes(2);
  });
});

describe("coach-page — ROUTE_TO_PAGE never skips the local answer (Law 5)", () => {
  it("answers here AND returns the destination, the question, and the deep link", async () => {
    state.classification = {
      lane: "ROUTE_TO_PAGE",
      in_scope: true,
      route_target: "allData",
      route_question: "How has my /r/ sound changed over the last month?",
      confidence: 0.9,
    };
    const api = await client();
    const r = await ask(api, {
      pageId: "myWords",
      message: "how has my r sound changed over the last month",
    });

    expect(r.body.lane).toBe("ROUTE_TO_PAGE");
    expect(r.body.answer).toBe(state.answer); // the local answer still happened
    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(r.body.route).toEqual({
      target: "allData",
      question: "How has my /r/ sound changed over the last month?",
      deepLink:
        "?coachq=How%20has%20my%20%2Fr%2F%20sound%20changed%20over%20the%20last%20month%3F&from=myWords",
    });
  });

  it("demotes a route to a page that does not exist, and answers locally", async () => {
    state.classification = {
      lane: "ROUTE_TO_PAGE",
      in_scope: true,
      route_target: "leaderboard",
      route_question: "who is winning",
      confidence: 0.9,
    };
    const api = await client();
    const r = await ask(api, { pageId: "myWords", message: "who is winning" });
    expect(r.body.lane).toBe("LANGUAGE_GENERAL");
    expect(r.body.route).toBeNull();
    expect(r.body.classifier).toMatchObject({ raw_lane: "ROUTE_TO_PAGE", demoted: "unknown_target" });
  });
});

describe("coach-page — the router fails open", () => {
  it("still answers when the classifier call throws", async () => {
    state.classifyThrows = true;
    const api = await client();
    const r = await ask(api, { pageId: "picker", message: "how do I order coffee politely" });

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, lane: "LANGUAGE_GENERAL", advisory: true });
    expect(r.body.classifier).toMatchObject({ ok: false, error: "router_call_failed" });
    expect(mainCall()).toBeTruthy();
  });

  it("still answers when the classifier returns an unknown lane", async () => {
    state.classification = { lane: "VIBES", in_scope: true, confidence: 0.88 };
    const api = await client();
    const r = await ask(api, { pageId: "picker", message: "what does órale mean" });
    expect(r.body.lane).toBe("LANGUAGE_GENERAL");
    expect(r.body.classifier).toMatchObject({ raw_lane: "VIBES", demoted: "unknown_lane" });
  });

  it("repairs sloppy classifier JSON instead of failing", async () => {
    state.classifyRaw = '{"lane":"NAV_HELP","in_scope":true,"confidence":0.92,}';
    const api = await client();
    const r = await ask(api, { pageId: "allData", message: "where's the minimal pairs practice" });
    expect(r.body.lane).toBe("NAV_HELP");
    expect(r.body.classifier.ok).toBe(true);
  });

  it("502s when the MAIN call yields an empty answer (the router still ran)", async () => {
    state.answer = "";
    const api = await client();
    const r = await ask(api, { pageId: "picker", message: "what does órale mean" });
    expect(r.status).toBe(502);
    expect(r.body).toMatchObject({ ok: false, error: "empty_answer", lane: "LANGUAGE_GENERAL" });
  });
});

describe("coach-page — coach_log", () => {
  it("writes every classification (lane, in_scope, page_id) fire-and-forget", async () => {
    state.classification = { lane: "CREATOR_INFO", in_scope: true, confidence: 0.93 };
    const api = await client();
    await ask(api, { pageId: "journey", message: "who made this app and why", uid: "u1", sessionId: "s1" });

    expect(fromSpy).toHaveBeenCalledWith("coach_log");
    expect(insertSpy).toHaveBeenCalledTimes(1);
    expect(insertSpy.mock.calls[0][0]).toMatchObject({
      uid: "u1",
      session_id: "s1",
      page_id: "journey",
      lane: "CREATOR_INFO",
      raw_lane: "CREATOR_INFO",
      in_scope: true,
      confidence: 0.93,
      advisory: false,
      message: "who made this app and why",
      lang: "en",
      off_scope_reply: null,
    });
  });

  it("logs the off-scope short-circuit too, with which redirect was used", async () => {
    state.classification = { lane: "OFF_SCOPE", in_scope: false, confidence: 0.98 };
    const api = await client();
    await ask(api, { pageId: "picker", message: "what's the weather in Kenya", conversionUsed: true });
    expect(insertSpy.mock.calls[0][0]).toMatchObject({
      lane: "OFF_SCOPE",
      in_scope: false,
      off_scope_reply: "plain",
    });
  });

  it("records the raw lane and the anchor type when a verdict is demoted", async () => {
    state.classification = { lane: "OFF_SCOPE", in_scope: false, confidence: 0.2 };
    const api = await client();
    await ask(api, {
      pageId: "guidedChat",
      anchor: { type: "bubble", text: "No manches" },
      message: "why did she say it like that",
    });
    expect(insertSpy.mock.calls[0][0]).toMatchObject({
      anchor_type: "bubble",
      lane: "LANGUAGE_GENERAL",
      raw_lane: "OFF_SCOPE",
      in_scope: true,
      advisory: true,
    });
  });
});
