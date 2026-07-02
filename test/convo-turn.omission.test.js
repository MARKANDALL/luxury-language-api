// test/convo-turn.omission.test.js
// Backend omission rendering tests for the heard-nothing directive.
// npx vitest run test/convo-turn.omission.test.js
import request from "supertest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkServer } from "./_helpers/mkServer.js";

const { createCalls } = vi.hoisted(() => ({ createCalls: [] }));

vi.mock("openai", () => {
  class OpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (args) => {
            createCalls.push(args);
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      assistant: "A... what size was that?",
                      narration: null,
                      imageDirection: "a busy cafe counter",
                      phase: "active",
                      suggested_replies: ["Medium.", "Large, please.", "Small."],
                    }),
                  },
                },
              ],
            };
          },
        },
      };
    }
  }
  return { OpenAI, default: OpenAI };
});

beforeEach(() => {
  vi.resetModules();
  createCalls.length = 0;
  process.env.ADMIN_TOKEN = "test_admin_token";
  process.env.OPENAI_API_KEY = "test";
  process.env.LUX_AI_CONVO_MODEL = "gpt-4.1-mini";
});

const baseScenario = {
  title: "Coffee shop order",
  desc: "Ordering a coffee at a busy cafe.",
  targetTurns: 12,
  role: { label: "Customer" },
  otherRole: { label: "Barista", npc: "A friendly barista.", npcAnchor: "Stay in character as the barista." },
};

const baseKnobs = { level: "B1", length: "medium" };
const baseMessages = [{ role: "user", content: "Medium is good and that's it." }];

async function callConvoTurn(body) {
  const mod = await import("../api/router.js");
  const handler = mod.default || mod;
  const api = request(mkServer(handler));
  return api
    .post("/api/router?route=convo-turn")
    .set("x-admin-token", "test_admin_token")
    .set("content-type", "application/json")
    .send(body);
}

function mainMessages() {
  expect(createCalls.length).toBeGreaterThanOrEqual(1);
  return createCalls[0].messages;
}

describe("convo-turn omission hearing rendering", () => {
  it("REPAIR with omission.slot 'size' renders block with 'size', not the word 'medium'", async () => {
    const hearing = {
      action: "REPAIR", bucket: "R2",
      omission: { slot: "size", word: null },
      target: null,
      linesRendered: [],
    };
    const r = await callConvoTurn({ scenario: baseScenario, knobs: baseKnobs, messages: baseMessages, hearing });
    expect(r.status).toBe(200);
    const sent = mainMessages();
    const last = sent[sent.length - 1];
    expect(last.role).toBe("system");
    expect(last.content).toContain("HEARING");
    expect(last.content).toContain("size");
    expect(last.content).not.toContain("medium");
  });

  it("REPAIR R1 with omission renders and never names any slot value", async () => {
    const hearing = {
      action: "REPAIR", bucket: "R1",
      omission: { slot: null, word: null },
      target: null,
      linesRendered: [],
    };
    const r = await callConvoTurn({ scenario: baseScenario, knobs: baseKnobs, messages: baseMessages, hearing });
    expect(r.status).toBe(200);
    const sent = mainMessages();
    const last = sent[sent.length - 1];
    expect(last.role).toBe("system");
    expect(last.content).toContain("HEARING");
    expect(last.content).toContain("did not catch");
    expect(last.content).not.toContain("medium");
    expect(last.content).not.toContain("latte");
  });

  it("non-omission REPAIR renders exactly as before", async () => {
    const hearing = {
      action: "REPAIR", bucket: "R2",
      target: { word: "latte", pairKey: "l>n", score: 42 },
      linesRendered: [],
    };
    const r = await callConvoTurn({ scenario: baseScenario, knobs: baseKnobs, messages: baseMessages, hearing });
    expect(r.status).toBe(200);
    const sent = mainMessages();
    const last = sent[sent.length - 1];
    expect(last.role).toBe("system");
    expect(last.content).toContain("HEARING");
    expect(last.content).toContain('"latte"');
    expect(last.content).toContain("did not catch");
  });
});
