import request from "supertest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkServer } from "./_helpers/mkServer.js";

beforeEach(() => {
  vi.resetModules();
  process.env.AZURE_SPEECH_KEY = "test";
  process.env.AZURE_SPEECH_REGION = "eastus";
});

vi.mock("formidable", () => {
  return {
    default: () => ({
      parse: (_req, cb) => {
        cb(null, { text: "hello world", enableProsody: "true" }, { audio: { filepath: "/tmp/in.webm" } });
      },
    }),
  };
});

vi.mock("fs/promises", () => {
  return {
    default: {
      readFile: async () => Buffer.from("RIFF....fakewav"),
      rm: async () => {},
    },
  };
});

vi.mock("@ffmpeg-installer/ffmpeg", () => ({ default: { path: "/bin/ffmpeg" } }));

vi.mock("fluent-ffmpeg", () => {
  const chain = {
    outputOptions() { return chain; },
    on(_evt, cb) { if (_evt === "end") setTimeout(cb, 0); return chain; },
    save() { return chain; },
  };
  return { default: () => chain };
});

describe("assess contract", () => {
  it("returns 200 + azure json when Azure succeeds", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          RecognitionStatus: "Success",
          NBest: [{ PronunciationAssessment: { AccuracyScore: 90 } }],
        }),
    });

    const mod = await import("../api/router.js");
    const handler = mod.default || mod;
    const api = request(mkServer(handler));

    const r = await api
      .post("/api/router?route=assess")
      .set("content-type", "multipart/form-data; boundary=----test")
      .send("noop");

    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty("RecognitionStatus", "Success");
    expect(r.body).toHaveProperty("NBest");
  });

  it("returns 502 when Azure returns non-JSON", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "NOT JSON",
    });

    const mod = await import("../api/router.js");
    const handler = mod.default || mod;
    const api = request(mkServer(handler));

    const r = await api
      .post("/api/router?route=assess")
      .set("content-type", "multipart/form-data; boundary=----test")
      .send("noop");

    expect(r.status).toBe(502);
    expect(r.body).toHaveProperty("error");
  });
});