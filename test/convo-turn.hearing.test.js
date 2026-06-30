// test/convo-turn.hearing.test.js
// Swing 1 — backend wiring contract test for the Ear's hearing block.
// Drives the real convo-turn handler through the router with `openai` mocked,
// capturing the messages array sent to chat.completions.create so we can prove:
//   (1) PRODUCTION SAFETY — a request with NO hearing block produces the exact
//       same messages payload as before (system + history + npcAnchor REMINDER),
//       with no HEARING directive anywhere.
//   (2) A non-SLIDE hearing block renders to a private stage direction that is
//       appended to postHistory as the final system message.
//   (3) A SLIDE directive renders to null and injects nothing.
//   (4) The injection is purely ADDITIVE — with-hearing == without-hearing plus
//       exactly one extra trailing system message; nothing else changes.
import request from "supertest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkServer } from "./_helpers/mkServer.js";

// Hoisted so the vi.mock factory can capture every create() call.
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
                      assistant: "One medium oat latte, coming right up for you.",
                      narration: null,
                      imageDirection: "a calm neighborhood cafe",
                      phase: "active",
                      suggested_replies: ["Thanks!", "How much?", "With oat milk."],
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
const baseMessages = [{ role: "user", content: "A medium oat latte, please." }];

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
  // The first create() call is the main turn assembly (any later call is the
  // optional length-repair pass, which uses a different system prompt).
  expect(createCalls.length).toBeGreaterThanOrEqual(1);
  return createCalls[0].messages;
}

function hasHearing(messages) {
  return messages.some(
    (m) => typeof m.content === "string" && m.content.includes("HEARING (private stage direction")
  );
}

describe("convo-turn hearing block wiring", () => {
  it("PRODUCTION SAFETY: no hearing block -> no HEARING injected, shape unchanged", async () => {
    const r = await callConvoTurn({ scenario: baseScenario, knobs: baseKnobs, messages: baseMessages });

    expect(r.status).toBe(200);
    const sent = mainMessages();

    // No hearing directive anywhere in the payload.
    expect(hasHearing(sent)).toBe(false);

    // Canonical shape: leading system prompt, the user turn, then exactly the
    // npcAnchor REMINDER from postHistory as the trailing system message.
    expect(sent[0].role).toBe("system");
    const systemMsgs = sent.filter((m) => m.role === "system");
    expect(systemMsgs.length).toBe(2); // sys + npcAnchor REMINDER
    expect(systemMsgs[systemMsgs.length - 1].content).toMatch(/^REMINDER:/);
  });

  it("ECHO hearing block -> rendered directive appended as last system message", async () => {
    const hearing = { action: "ECHO", target: { word: "latte" } };
    const r = await callConvoTurn({ scenario: baseScenario, knobs: baseKnobs, messages: baseMessages, hearing });

    expect(r.status).toBe(200);
    const sent = mainMessages();

    const last = sent[sent.length - 1];
    expect(last.role).toBe("system");
    expect(last.content).toContain("HEARING (private stage direction");
    expect(last.content).toContain('"latte"');
    // The npcAnchor REMINDER is still present (hearing is additive, not a replace).
    expect(sent.some((m) => typeof m.content === "string" && m.content.startsWith("REMINDER:"))).toBe(true);
  });

  it("SLIDE hearing block -> renders to null, nothing injected", async () => {
    const hearing = { action: "SLIDE" };
    const r = await callConvoTurn({ scenario: baseScenario, knobs: baseKnobs, messages: baseMessages, hearing });

    expect(r.status).toBe(200);
    expect(hasHearing(mainMessages())).toBe(false);
  });

  it("injection is purely additive: with-hearing == without-hearing + 1 trailing system msg", async () => {
    const r1 = await callConvoTurn({ scenario: baseScenario, knobs: baseKnobs, messages: baseMessages });
    expect(r1.status).toBe(200);
    const without = mainMessages();

    createCalls.length = 0;

    const hearing = { action: "ECHO", target: { word: "latte" } };
    const r2 = await callConvoTurn({ scenario: baseScenario, knobs: baseKnobs, messages: baseMessages, hearing });
    expect(r2.status).toBe(200);
    const withH = mainMessages();

    expect(withH.length).toBe(without.length + 1);
    // Everything up to the injected message is byte-identical.
    expect(JSON.stringify(withH.slice(0, without.length))).toBe(JSON.stringify(without));
    // The one added message is the hearing stage direction.
    expect(withH[withH.length - 1].role).toBe("system");
    expect(withH[withH.length - 1].content).toContain("HEARING (private stage direction");
  });
});
