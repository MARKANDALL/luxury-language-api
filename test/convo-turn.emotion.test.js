// test/convo-turn.emotion.test.js
// Emotion driver stage 1 — wiring contract for the per-turn emotion signal.
// Drives the real convo-turn handler through the router with `openai` mocked,
// so we can hand the route any model output we like and assert on both what it
// sent up (the prompt) and what it returned (the wire shape). Proves:
//   (1) every reply object carries `emotion` — normal turn AND every early exit;
//   (2) the validator runs on the wire, not just in isolation;
//   (3) the change is ADDITIVE — no existing field's value or position moves;
//   (4) the route never writes the emotion into any spoken field.
import request from "supertest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkServer } from "./_helpers/mkServer.js";
import { EMOTION_NAMES } from "../lib/emotion.js";

// Hoisted so the vi.mock factory can capture calls and read the staged reply.
const { createCalls, stage } = vi.hoisted(() => ({
  createCalls: [],
  stage: { reply: null },
}));

vi.mock("openai", () => {
  class OpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (args) => {
            createCalls.push(args);
            return { choices: [{ message: { content: JSON.stringify(stage.reply) } }] };
          },
        },
      };
    }
  }
  return { OpenAI, default: OpenAI };
});

// A clean, short turn — short enough that the length-repair pass never fires,
// so createCalls[0] is always the main assembly.
const baseReply = {
  assistant: "Sure, let's start with a basic checking account.",
  narration: null,
  imageDirection: "A bank desk, brochures fanned out, both seated.",
  phase: "active",
  suggested_replies: ["What are the fees?", "Sounds good.", "Can I see the terms?"],
  emotion: { name: "attentive", level: 2 },
};

beforeEach(() => {
  vi.resetModules();
  createCalls.length = 0;
  stage.reply = structuredClone(baseReply);
  process.env.ADMIN_TOKEN = "test_admin_token";
  process.env.OPENAI_API_KEY = "test";
  process.env.LUX_AI_CONVO_MODEL = "gpt-4.1-mini";
});

const baseScenario = {
  title: "Opening a bank account",
  desc: "A bank branch visit — account options to sort through and fees to understand.",
  targetTurns: 12,
  role: { label: "Bank rep" },
  otherRole: {
    label: "New customer",
    npc: "A careful new customer opening an account.",
    npcAnchor: "You are a new customer opening a bank account.",
  },
};

const baseKnobs = { level: "B1", length: "medium" };
const baseMessages = [{ role: "user", content: "Let's look at the checking options." }];

async function callConvoTurn(body) {
  const mod = await import("../api/router.js");
  const handler = mod.default || mod;
  return request(mkServer(handler))
    .post("/api/router?route=convo-turn")
    .set("x-admin-token", "test_admin_token")
    .set("content-type", "application/json")
    .send(body);
}

function systemPrompt() {
  expect(createCalls.length).toBeGreaterThanOrEqual(1);
  return createCalls[0].messages[0].content;
}

describe("convo-turn emotion signal — the wire", () => {
  it("a valid signal reaches the frontend untouched", async () => {
    stage.reply.emotion = { name: "curious", level: 3 };
    const r = await callConvoTurn({ scenario: baseScenario, knobs: baseKnobs, messages: baseMessages });

    expect(r.status).toBe(200);
    expect(r.body.emotion).toEqual({ name: "curious", level: 3 });
  });

  it("an unknown name is validated down to neutral on the wire", async () => {
    stage.reply.emotion = { name: "ecstatic", level: 3 };
    const r = await callConvoTurn({ scenario: baseScenario, knobs: baseKnobs, messages: baseMessages });

    expect(r.status).toBe(200);
    expect(r.body.emotion).toEqual({ name: "neutral", level: null });
  });

  it("a bad level is validated down to neutral on the wire", async () => {
    stage.reply.emotion = { name: "angry", level: 7 };
    const r = await callConvoTurn({ scenario: baseScenario, knobs: baseKnobs, messages: baseMessages });

    expect(r.status).toBe(200);
    expect(r.body.emotion).toEqual({ name: "neutral", level: null });
  });

  it("a missing emotion field still yields the field — the frontend never guesses", async () => {
    delete stage.reply.emotion;
    const r = await callConvoTurn({ scenario: baseScenario, knobs: baseKnobs, messages: baseMessages });

    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty("emotion");
    expect(r.body.emotion).toEqual({ name: "neutral", level: null });
  });

  it("a Spanish-language emotion name is not an allowed token -> neutral", async () => {
    stage.reply.emotion = { name: "curioso", level: 2 };
    const r = await callConvoTurn({ scenario: baseScenario, knobs: baseKnobs, messages: baseMessages, pack: "es" });

    expect(r.status).toBe(200);
    expect(r.body.emotion).toEqual({ name: "neutral", level: null });
  });

  it("the empty-assistant closing fallback carries the field", async () => {
    stage.reply = { assistant: "", suggested_replies: [] };
    const r = await callConvoTurn({ scenario: baseScenario, knobs: baseKnobs, messages: baseMessages });

    expect(r.status).toBe(200);
    expect(r.body.status).toBe("ended");
    expect(r.body.emotion).toEqual({ name: "neutral", level: null });
  });

  it("the hard-turn-cap exit carries the field", async () => {
    // trimmed caps at 16 messages, so the cap is only reachable with a low targetTurns.
    const many = Array.from({ length: 10 }, (_, i) => ({ role: "user", content: `turn ${i}` }));
    const r = await callConvoTurn({
      scenario: { ...baseScenario, targetTurns: 4 },
      knobs: baseKnobs,
      messages: many,
    });

    expect(r.status).toBe(200);
    expect(r.body.status).toBe("ended");
    expect(r.body.emotion).toEqual({ name: "neutral", level: null });
    expect(createCalls.length).toBe(0); // exited before any model call
  });

  it("the route never writes the emotion into a spoken field", async () => {
    stage.reply.emotion = { name: "impatient", level: 3 };
    const r = await callConvoTurn({ scenario: baseScenario, knobs: baseKnobs, messages: baseMessages });

    expect(r.status).toBe(200);
    const spoken = [r.body.assistant, r.body.narration, r.body.imageDirection, ...r.body.suggested_replies]
      .filter(Boolean)
      .join(" ");
    expect(spoken).not.toMatch(/impatient/i);
    expect(spoken).not.toMatch(/level\s*3/i);
  });
});

describe("convo-turn emotion signal — additive guarantee", () => {
  it("every pre-existing field keeps its value", async () => {
    const r = await callConvoTurn({ scenario: baseScenario, knobs: baseKnobs, messages: baseMessages });

    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.model).toBe("gpt-4.1-mini");
    expect(r.body.assistant).toBe(baseReply.assistant);
    expect(r.body.narration).toBe(null);
    expect(r.body.imageDirection).toBe(baseReply.imageDirection);
    expect(r.body.phase).toBe("active");
    expect(r.body.suggested_replies).toEqual(baseReply.suggested_replies);
  });

  it("emotion is the only added key, and it comes last", async () => {
    const r = await callConvoTurn({ scenario: baseScenario, knobs: baseKnobs, messages: baseMessages });

    expect(Object.keys(r.body)).toEqual([
      "ok", "model", "assistant", "narration", "imageDirection", "phase", "suggested_replies", "emotion",
    ]);
  });
});

describe("convo-turn emotion signal — the prompt", () => {
  it("asks for the signal, names the whole vocabulary, and bans leakage", async () => {
    await callConvoTurn({ scenario: baseScenario, knobs: baseKnobs, messages: baseMessages });
    const sys = systemPrompt();

    expect(sys).toContain("EMOTION SIGNAL (machine-readable data — never spoken)");
    for (const name of EMOTION_NAMES) expect(sys).toContain(name);
    expect(sys).toContain('When "name" is "neutral", "level" MUST be null.');
    expect(sys).toMatch(/never name, label, spell out, or read aloud/i);
    expect(sys).toMatch(/Never translate it/i);
  });

  it("the OUTPUT schema line keeps every original key, in order, and appends emotion", async () => {
    await callConvoTurn({ scenario: baseScenario, knobs: baseKnobs, messages: baseMessages });
    const sys = systemPrompt();

    const outputLine = sys.split("\n").find((l) => l.startsWith('{"assistant":'));
    expect(outputLine).toBeDefined();
    expect(outputLine).toContain(
      '{"assistant":"your reply","narration":"optional stage direction or null","imageDirection":"required visual scene description for image generator","phase":"opening|active|winding_down|closing","suggested_replies":["option 1","option 2","option 3"]'
    );
    expect(outputLine.endsWith(
      `,"emotion":{"name":"${EMOTION_NAMES.join("|")}","level":1|2|3|null}}`
    )).toBe(true);
  });

  it("the block sits above the OUTPUT line so the schema is the last thing read", async () => {
    await callConvoTurn({ scenario: baseScenario, knobs: baseKnobs, messages: baseMessages });
    const sys = systemPrompt();

    expect(sys.indexOf("EMOTION SIGNAL")).toBeGreaterThan(-1);
    expect(sys.indexOf("EMOTION SIGNAL")).toBeLessThan(sys.indexOf("OUTPUT: JSON only"));
  });

  it("the length-repair prompt is untouched — it still asks only for `assistant`", async () => {
    // A long line forces the repair pass; its system prompt must carry no emotion ask.
    stage.reply.assistant =
      "Well, we have the basic checking account and the premium checking account, and the premium one waives the monthly fee if you set up direct deposit, and it also comes with a slightly better rate on the linked savings account, plus free checks for the first year, and no ATM fees at partner machines nationwide.";
    const r = await callConvoTurn({ scenario: baseScenario, knobs: baseKnobs, messages: baseMessages });

    expect(r.status).toBe(200);
    expect(createCalls.length).toBe(2);
    const repairSys = createCalls[1].messages[0].content;
    expect(repairSys).toContain('{"assistant":"revised line"}');
    expect(repairSys).not.toContain("EMOTION SIGNAL");
    // The repair rewrote the line, but the emotion still came from the first pass.
    expect(r.body.emotion).toEqual({ name: "attentive", level: 2 });
  });
});
