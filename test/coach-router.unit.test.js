// test/coach-router.unit.test.js
// Unit tests for THE COACH ROUTER's pure pieces (routes/coach-page/router.js):
// input shaping, verdict normalization (demotion + the confidence floor), the
// canned off-scope redirects, the route deep link, and classify()'s fail-open
// guarantee. No network, no env, no HTTP — the transport-level behavior lives in
// test/coach-page.contract.test.js.
import { describe, it, expect, vi } from "vitest";
import { jsonrepair } from "jsonrepair";
import {
  CONFIDENCE_FLOOR,
  LANES,
  OFF_SCOPE_REPLIES,
  PAGES,
  ROUTER_TEMPERATURE,
  SYSTEM_PROMPT_BASE,
  buildRouterUser,
  buildSystemPrompt,
  classify,
  normalizeClassification,
  offScopeReply,
  routeDeepLink,
} from "../routes/coach-page/router.js";

const verdict = (over = {}) => ({
  lane: "LANGUAGE_GENERAL",
  in_scope: true,
  route_target: "",
  route_question: "",
  confidence: 0.9,
  ...over,
});

describe("coach router — lanes and prompt", () => {
  it("exposes exactly the seven charter lanes", () => {
    expect(LANES).toEqual([
      "EXPLAIN",
      "NAV_HELP",
      "PATTERNS",
      "CREATOR_INFO",
      "LANGUAGE_GENERAL",
      "ROUTE_TO_PAGE",
      "OFF_SCOPE",
    ]);
  });

  it("keeps the charter system prompt verbatim and appends only the PAGES block", () => {
    const sys = buildSystemPrompt();
    expect(sys.startsWith(SYSTEM_PROMPT_BASE)).toBe(true);
    expect(sys).toContain("You are the traffic controller for the Lux AI Coach.");
    expect(sys).toContain("Ties go to the learner.");
    expect(sys).toContain("PAGES (the only valid route_target values)");
    for (const key of Object.keys(PAGES)) expect(sys).toContain(`- ${key}:`);
  });
});

describe("coach router — buildRouterUser", () => {
  it("mirrors the YOU RECEIVE block and caps every field", () => {
    const u = buildRouterUser({
      pageId: "practiceSkills",
      anchor: { type: "phoneme", text: "/r/" },
      message: "why is this one red",
      learner: { level: "B1", l1: "es", flags: ["th-stopping", "r-tap"] },
      recent: [1, 2, 3, 4, 5, 6, 7],
    });
    expect(u.pageId).toBe("practiceSkills");
    expect(u.anchor).toEqual({ type: "phoneme", text: "/r/" });
    expect(u.message).toBe("why is this one red");
    expect(u.learner.flags).toEqual(["th-stopping", "r-tap"]);
    expect(u.recent).toHaveLength(5); // last few, not all of them
  });

  it("normalizes an absent/empty anchor to null and a missing learner to blanks", () => {
    expect(buildRouterUser({ message: "hi" }).anchor).toBeNull();
    expect(buildRouterUser({ message: "hi", anchor: { type: "", text: "" } }).anchor).toBeNull();
    expect(buildRouterUser({ message: "hi" }).learner).toEqual({ level: "", l1: "", flags: [] });
  });

  it("caps a long message and a flood of pattern flags", () => {
    const u = buildRouterUser({
      message: "x".repeat(5000),
      learner: { flags: Array.from({ length: 40 }, (_, i) => `flag${i}`) },
    });
    expect(u.message).toHaveLength(1000);
    expect(u.learner.flags).toHaveLength(8);
  });
});

describe("coach router — normalizeClassification", () => {
  it("passes a well-formed in-scope verdict through untouched", () => {
    const v = normalizeClassification(verdict({ lane: "EXPLAIN", confidence: 0.97 }), {
      pageId: "practiceSkills",
      hasAnchor: true,
    });
    expect(v).toMatchObject({
      lane: "EXPLAIN",
      in_scope: true,
      confidence: 0.97,
      advisory: false,
      demoted: "",
      raw_lane: "EXPLAIN",
    });
  });

  it("derives in_scope from the lane (a confident OFF_SCOPE is out of scope)", () => {
    const v = normalizeClassification(verdict({ lane: "OFF_SCOPE", confidence: 0.98 }), {});
    expect(v.lane).toBe("OFF_SCOPE");
    expect(v.in_scope).toBe(false);
  });

  it("accepts a lowercase lane from the model", () => {
    expect(normalizeClassification(verdict({ lane: "patterns" }), {}).lane).toBe("PATTERNS");
  });

  it("demotes an unknown lane to the local lane — LANGUAGE_GENERAL with no anchor", () => {
    const v = normalizeClassification(verdict({ lane: "VIBES" }), { hasAnchor: false });
    expect(v).toMatchObject({ lane: "LANGUAGE_GENERAL", demoted: "unknown_lane", raw_lane: "VIBES" });
  });

  it("demotes an unknown lane to EXPLAIN when an anchor is present (Rule 2)", () => {
    const v = normalizeClassification(verdict({ lane: "VIBES" }), { hasAnchor: true });
    expect(v).toMatchObject({ lane: "EXPLAIN", demoted: "unknown_lane" });
  });

  it("keeps a valid route and its question", () => {
    const v = normalizeClassification(
      verdict({
        lane: "ROUTE_TO_PAGE",
        route_target: "allData",
        route_question: "How has my /r/ sound changed over the last month?",
      }),
      { pageId: "myWords" }
    );
    expect(v.lane).toBe("ROUTE_TO_PAGE");
    expect(v.route_target).toBe("allData");
    expect(v.route_question).toContain("last month");
    expect(v.demoted).toBe("");
  });

  it("falls back to the learner's own message when the model routes without a question", () => {
    const v = normalizeClassification(
      verdict({ lane: "ROUTE_TO_PAGE", route_target: "allData", route_question: "" }),
      { pageId: "myWords", message: "how has my r sound changed" }
    );
    expect(v.route_question).toBe("how has my r sound changed");
  });

  it("demotes a route to a page that does not exist (no dead deep links)", () => {
    const v = normalizeClassification(
      verdict({ lane: "ROUTE_TO_PAGE", route_target: "leaderboard", route_question: "q" }),
      { pageId: "myWords" }
    );
    expect(v).toMatchObject({ lane: "LANGUAGE_GENERAL", demoted: "unknown_target" });
    expect(v.route_target).toBe("");
    expect(v.route_question).toBe("");
  });

  it("demotes a route with no target at all", () => {
    const v = normalizeClassification(verdict({ lane: "ROUTE_TO_PAGE" }), { pageId: "myWords" });
    expect(v.demoted).toBe("missing_target");
    expect(v.lane).toBe("LANGUAGE_GENERAL");
  });

  it("demotes a route that points at the page the learner is already on", () => {
    const v = normalizeClassification(
      verdict({ lane: "ROUTE_TO_PAGE", route_target: "allData", route_question: "q" }),
      { pageId: "allData", hasAnchor: true }
    );
    expect(v).toMatchObject({ lane: "EXPLAIN", demoted: "self_route" });
  });

  it("strips route fields from every non-routing lane", () => {
    const v = normalizeClassification(
      verdict({ lane: "NAV_HELP", route_target: "allData", route_question: "q" }),
      {}
    );
    expect(v.route_target).toBe("");
    expect(v.route_question).toBe("");
  });

  it("treats a lane under the floor as advisory and proceeds as LANGUAGE_GENERAL", () => {
    const v = normalizeClassification(verdict({ lane: "PATTERNS", confidence: 0.31 }), {
      hasAnchor: true,
    });
    expect(v).toMatchObject({
      lane: "LANGUAGE_GENERAL",
      advisory: true,
      raw_lane: "PATTERNS",
      in_scope: true,
    });
  });

  it("LOW CONFIDENCE IS NOT A REFUSAL: an unsure OFF_SCOPE still gets answered", () => {
    const v = normalizeClassification(verdict({ lane: "OFF_SCOPE", confidence: 0.3 }), {});
    expect(v.lane).toBe("LANGUAGE_GENERAL");
    expect(v.in_scope).toBe(true);
    expect(v.advisory).toBe(true);
    expect(v.raw_lane).toBe("OFF_SCOPE"); // the log still records what it said
  });

  it("drops the route when a routing verdict is under the floor", () => {
    const v = normalizeClassification(
      verdict({ lane: "ROUTE_TO_PAGE", route_target: "allData", route_question: "q", confidence: 0.2 }),
      { pageId: "myWords" }
    );
    expect(v.lane).toBe("LANGUAGE_GENERAL");
    expect(v.route_target).toBe("");
  });

  it("treats confidence exactly at the floor as confident", () => {
    const v = normalizeClassification(
      verdict({ lane: "OFF_SCOPE", confidence: CONFIDENCE_FLOOR }),
      {}
    );
    expect(v.advisory).toBe(false);
    expect(v.lane).toBe("OFF_SCOPE");
  });

  it("clamps a garbage confidence into 0..1 (missing/NaN -> 0, so advisory)", () => {
    expect(normalizeClassification(verdict({ confidence: 7 }), {}).confidence).toBe(1);
    expect(normalizeClassification(verdict({ confidence: -3 }), {}).confidence).toBe(0);
    expect(normalizeClassification(verdict({ confidence: "banana" }), {}).confidence).toBe(0);
    expect(normalizeClassification({ lane: "OFF_SCOPE" }, {}).advisory).toBe(true);
  });

  it("survives an empty object (the fail-open shape)", () => {
    const v = normalizeClassification({}, {});
    expect(v).toMatchObject({ lane: "LANGUAGE_GENERAL", in_scope: true, confidence: 0, advisory: true });
  });
});

describe("coach router — off-scope redirects", () => {
  it("gives the Law 6 conversion on the first off-scope ask of the session", () => {
    expect(offScopeReply({ lang: "en", conversionUsed: false })).toEqual({
      kind: "conversion",
      text: OFF_SCOPE_REPLIES.conversion.en,
    });
    expect(offScopeReply({ lang: "en" }).text).toContain("show you how to say it");
  });

  it("gives the plain redirect once the conversion is spent", () => {
    expect(offScopeReply({ lang: "en", conversionUsed: true })).toEqual({
      kind: "plain",
      text: OFF_SCOPE_REPLIES.plain.en,
    });
  });

  it("speaks Spanish for the es pack, both kinds", () => {
    expect(offScopeReply({ lang: "es" }).text).toBe(OFF_SCOPE_REPLIES.conversion.es);
    expect(offScopeReply({ lang: "es", conversionUsed: true }).text).toBe(OFF_SCOPE_REPLIES.plain.es);
  });

  it("falls back to English for an unknown language", () => {
    expect(offScopeReply({ lang: "pt" }).text).toBe(OFF_SCOPE_REPLIES.conversion.en);
    expect(offScopeReply().text).toBe(OFF_SCOPE_REPLIES.conversion.en);
  });
});

describe("coach router — route deep link", () => {
  it("builds ?coachq=<question>&from=<pageId>, url-encoded", () => {
    expect(
      routeDeepLink({ route_question: "How has my /r/ sound changed?", pageId: "myWords" })
    ).toBe("?coachq=How%20has%20my%20%2Fr%2F%20sound%20changed%3F&from=myWords");
  });
});

describe("coach router — classify()", () => {
  const mkOpenAI = (impl) => ({ chat: { completions: { create: vi.fn(impl) } } });
  const input = { pageId: "picker", message: "what's the weather in Kenya right now" };

  it("calls the quick model deterministically, in json_object mode, with a timeout", async () => {
    const openai = mkOpenAI(async () => ({
      choices: [{ message: { content: JSON.stringify(verdict({ lane: "OFF_SCOPE", confidence: 0.98 })) } }],
    }));
    const v = await classify(input, { openai, model: "quick-model", jsonrepair });

    expect(v).toMatchObject({ lane: "OFF_SCOPE", in_scope: false, ok: true });
    const [body, opts] = openai.chat.completions.create.mock.calls[0];
    expect(body.model).toBe("quick-model");
    expect(body.temperature).toBe(ROUTER_TEMPERATURE);
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages[0].content).toContain("traffic controller");
    expect(JSON.parse(body.messages[1].content).message).toContain("Kenya");
    expect(opts?.timeout).toBeGreaterThan(0);
  });

  it("repairs sloppy JSON rather than giving up", async () => {
    const openai = mkOpenAI(async () => ({
      choices: [{ message: { content: '{"lane": "NAV_HELP", "confidence": 0.92,}' } }],
    }));
    const v = await classify(input, { openai, model: "m", jsonrepair });
    expect(v).toMatchObject({ lane: "NAV_HELP", ok: true });
  });

  it("FAILS OPEN when the model call throws — the learner still gets answered", async () => {
    const openai = mkOpenAI(async () => {
      throw new Error("upstream on fire");
    });
    const v = await classify(input, { openai, model: "m", jsonrepair });
    expect(v).toMatchObject({
      lane: "LANGUAGE_GENERAL",
      in_scope: true,
      confidence: 0,
      advisory: true,
      ok: false,
      error: "router_call_failed",
    });
  });

  it("FAILS OPEN when the output is unparseable even after repair", async () => {
    const openai = mkOpenAI(async () => ({ choices: [{ message: { content: "not json at all" } }] }));
    const v = await classify(input, {
      openai,
      model: "m",
      jsonrepair: () => {
        throw new Error("unrepairable");
      },
    });
    expect(v).toMatchObject({ lane: "LANGUAGE_GENERAL", ok: false, error: "router_parse_failed" });
  });

  it("fails open on an anchored message too — advisory is literal, so LANGUAGE_GENERAL", async () => {
    const openai = mkOpenAI(async () => {
      throw new Error("nope");
    });
    const v = await classify(
      { ...input, anchor: { type: "bubble", text: "No manches" }, message: "why did she say it like that" },
      { openai, model: "m", jsonrepair }
    );
    // confidence 0 is advisory, and advisory is literal: LANGUAGE_GENERAL.
    expect(v.lane).toBe("LANGUAGE_GENERAL");
    expect(v.advisory).toBe(true);
  });
});
