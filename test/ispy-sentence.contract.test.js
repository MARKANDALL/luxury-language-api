// test/ispy-sentence.contract.test.js
// The speaking bridge's judgement, which is the game's only production moment.
//
// Hermetic, like ispy-recap.contract.test.js. The promises worth pinning are
// the ones the learner cannot check: that it is still the CHEAP call, that a
// failure is soft so a finished round never shows an error, and that the note
// is asked for at the learner's band and told to be specific.
import request from "supertest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkServer } from "./_helpers/mkServer.js";

const { createSpy } = vi.hoisted(() => ({ createSpy: vi.fn() }));

vi.mock("openai", () => ({
  OpenAI: class {
    constructor(opts) {
      if (!opts || !opts.apiKey) throw new Error("The OPENAI_API_KEY environment variable is missing or empty");
      this.chat = { completions: { create: createSpy } };
    }
  },
}));

const TOKEN = "test_admin_token";
const reply = (obj) => ({ choices: [{ message: { content: JSON.stringify(obj) } }] });

async function client() {
  const mod = await import("../api/router.js");
  return request(mkServer(mod.default || mod));
}
async function post(body, withToken = true) {
  const api = await client();
  const req = api.post("/api/router?route=ispy-sentence");
  if (withToken) req.set("x-admin-token", TOKEN);
  return req.send(body);
}

const OK = { lang: "en", level: "B1", word: "a receipt", sentence: "She put the receipt in her bag." };

beforeEach(() => {
  createSpy.mockReset();
  process.env.ADMIN_TOKEN = TOKEN;
  process.env.OPENAI_API_KEY = "sk-test";
});

describe("ispy-sentence", () => {
  it("returns a verdict and a specific note", async () => {
    createSpy.mockResolvedValue(reply({ correct: true, note: "Uses 'receipt' as a noun, correctly." }));
    const res = await post(OK);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.correct).toBe(true);
    expect(res.body.note).toContain("receipt");
  });

  it("is still the CHEAP call: no image, small budget", async () => {
    createSpy.mockResolvedValue(reply({ correct: true, note: "Good." }));
    await post(OK);
    expect(createSpy).toHaveBeenCalledTimes(1);
    const [req] = createSpy.mock.calls[0];
    expect(JSON.stringify(req.messages)).not.toContain("image_url");
    expect(req.max_tokens).toBeLessThanOrEqual(250);
  });

  it("judges the TARGET WORD, not the whole sentence", async () => {
    // The rule that stops this becoming a grammar checker. A learner who says
    // "the blanket is warm and I sleep good" used the word correctly.
    createSpy.mockResolvedValue(reply({ correct: true, note: "ok" }));
    await post(OK);
    const sys = createSpy.mock.calls[0][0].messages[0].content;
    expect(sys).toContain("ONLY about the target word");
    expect(sys).toContain("still correct if the");
  });

  it("demands a note specific to THIS sentence", async () => {
    createSpy.mockResolvedValue(reply({ correct: true, note: "ok" }));
    await post(OK);
    const sys = createSpy.mock.calls[0][0].messages[0].content;
    expect(sys).toContain("SPECIFIC TO THIS SENTENCE");
    // The exact failure being replaced.
    expect(sys).toContain("Generic praise is the failure");
  });

  it("writes the note at the learner's band", async () => {
    createSpy.mockResolvedValue(reply({ correct: true, note: "ok" }));
    await post({ ...OK, level: "A1" });
    expect(createSpy.mock.calls[0][0].messages[0].content).toContain("Max 10 words");
  });

  it("sends the word and the sentence, and nothing else", async () => {
    createSpy.mockResolvedValue(reply({ correct: true, note: "ok" }));
    await post(OK);
    const user = createSpy.mock.calls[0][0].messages[1].content;
    expect(user).toContain("a receipt");
    expect(user).toContain("She put the receipt in her bag.");
  });

  it("says no, softly, when there is nothing to judge", async () => {
    const res = await post({ lang: "en", level: "B1", word: "", sentence: "" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe("nothing_to_judge");
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("says no, softly, when the model fails or answers with nothing", async () => {
    createSpy.mockRejectedValue(new Error("upstream down"));
    let res = await post(OK);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);

    createSpy.mockResolvedValue(reply({ correct: true, note: "   " }));
    res = await post(OK);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe("no_note");
  });

  it("degrades rather than throwing with no API key", async () => {
    delete process.env.OPENAI_API_KEY;
    const res = await post(OK);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe("init_error");
  });

  it("refuses without the admin token", async () => {
    const res = await post(OK, false);
    expect(res.status).toBe(401);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("treats a missing correct flag as not correct", async () => {
    createSpy.mockResolvedValue(reply({ note: "Something happened." }));
    const res = await post(OK);
    expect(res.body.ok).toBe(true);
    expect(res.body.correct).toBe(false);
  });
});
