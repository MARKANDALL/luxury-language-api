// test/word-image.contract.test.js
// Contract test for the Word-Image route on /api/router?route=word-image. Mirrors
// coach-ask.contract.test.js: hermetic — OpenAI is mocked and global.fetch (the
// Pexels call) is stubbed, so no network is ever reached. Covers the happy path
// (an imageable word returns up to 3 shaped Pexels images), the non-imageable
// success case, the admin gate, and every graceful-degradation path the contract
// promises (missing key, malformed model JSON, Pexels error/timeout). It also
// asserts the two invariants that matter most: the outbound Pexels call is NOT
// made when the word is not imageable, and the same word returns the same images
// (determinism).
import request from "supertest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkServer } from "./_helpers/mkServer.js";

// The model classifies a word as { imageable, query }; default = an imageable
// word ("shelf"). The Pexels stub returns three photos in a fixed order.
const { createSpy } = vi.hoisted(() => ({
  createSpy: vi.fn(async () => ({
    choices: [{ message: { content: JSON.stringify({ imageable: true, query: "shelf" }) } }],
  })),
}));

vi.mock("openai", () => ({
  OpenAI: class {
    constructor() {
      this.chat = { completions: { create: createSpy } };
    }
  },
}));

// A Pexels /v1/search payload with N photos, in order. Only the fields the route
// maps are populated (plus originals we deliberately do NOT use for thumb/full).
function pexelsPayload(n) {
  const photos = [];
  for (let i = 1; i <= n; i++) {
    photos.push({
      id: i,
      photographer: `Photographer ${i}`,
      url: `https://www.pexels.com/photo/shelf-${i}/`,
      src: {
        original: `https://images.pexels.com/original-${i}.jpg`,
        large: `https://images.pexels.com/large-${i}.jpg`,
        medium: `https://images.pexels.com/medium-${i}.jpg`,
      },
      alt: `some pexels alt ${i}`,
    });
  }
  return { photos, total_results: n, page: 1, per_page: n };
}

// Default fetch stub: a 200 with three photos. Individual tests override with
// mockResolvedValueOnce / mockRejectedValueOnce.
let fetchSpy;

beforeEach(() => {
  vi.resetModules();
  createSpy.mockClear();
  createSpy.mockResolvedValue({
    choices: [{ message: { content: JSON.stringify({ imageable: true, query: "shelf" }) } }],
  });
  fetchSpy = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => pexelsPayload(3),
  }));
  global.fetch = fetchSpy;
  process.env.ADMIN_TOKEN = "test_admin_token";
  process.env.PEXELS_API_KEY = "test_pexels_key";
});

async function client() {
  const mod = await import("../api/router.js");
  const handler = mod.default || mod;
  return request(mkServer(handler));
}

function post(api, bodyOverrides = {}, withToken = true) {
  const req = api.post("/api/router?route=word-image");
  if (withToken) req.set("x-admin-token", "test_admin_token");
  return req.send({ word: "shelf", sentence: "", lang: "en", l1: "es", uid: "u1", ...bodyOverrides });
}

describe("word-image contract", () => {
  it("happy path: an imageable word returns up to 3 shaped images from Pexels", async () => {
    const api = await client();
    const r = await post(api, { word: "estante", lang: "es" });

    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.imageable).toBe(true);
    expect(r.body.query).toBe("shelf");
    expect(Array.isArray(r.body.images)).toBe(true);
    expect(r.body.images.length).toBe(3);
    expect(r.body.images.length).toBeLessThanOrEqual(3);

    // Each image is shaped to the contract, using the medium/large sizes (NOT the
    // original), and alt is the search query.
    const first = r.body.images[0];
    expect(first).toEqual({
      thumb: "https://images.pexels.com/medium-1.jpg",
      full: "https://images.pexels.com/large-1.jpg",
      alt: "shelf",
      photographer: "Photographer 1",
      sourceUrl: "https://www.pexels.com/photo/shelf-1/",
    });
    for (const im of r.body.images) {
      expect(im.thumb).toContain("medium-");
      expect(im.full).toContain("large-");
      expect(im.alt).toBe("shelf");
    }

    // Exactly one classify call and one Pexels call.
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // The Pexels request: right endpoint, per_page=3, orientation=landscape, the
    // English query, and the raw key as the Authorization header value.
    const [calledUrl, opts] = fetchSpy.mock.calls[0];
    expect(calledUrl).toContain("https://api.pexels.com/v1/search");
    expect(calledUrl).toContain("query=shelf");
    expect(calledUrl).toContain("per_page=3");
    expect(calledUrl).toContain("orientation=landscape");
    expect(opts.headers.Authorization).toBe("test_pexels_key");
  });

  it("translates a Spanish word to the English query used for the Pexels search", async () => {
    const api = await client();
    await post(api, { word: "estante", sentence: "El libro esta en el estante.", lang: "es" });

    // The word + resolved language are handed to the classifier...
    const userMsg = createSpy.mock.calls[0][0].messages[1].content;
    expect(userMsg).toContain("estante");
    expect(userMsg).toContain("Spanish");
    // ...and the English query it returns is what Pexels is searched with.
    expect(fetchSpy.mock.calls[0][0]).toContain("query=shelf");
  });

  it("caps the result at 3 images even when Pexels returns more, preserving order", async () => {
    fetchSpy.mockResolvedValueOnce({ ok: true, status: 200, json: async () => pexelsPayload(5) });
    const api = await client();
    const r = await post(api);

    expect(r.body.images.length).toBe(3);
    // Pexels' own order is preserved (first three).
    expect(r.body.images.map((i) => i.sourceUrl)).toEqual([
      "https://www.pexels.com/photo/shelf-1/",
      "https://www.pexels.com/photo/shelf-2/",
      "https://www.pexels.com/photo/shelf-3/",
    ]);
  });

  it("determinism: the same word returns the same images every time", async () => {
    const api = await client();
    const r1 = await post(api);
    const r2 = await post(api);
    expect(r1.body.images).toEqual(r2.body.images);
    // Classification is requested at temperature 0 (the determinism knob).
    expect(createSpy.mock.calls[0][0].temperature).toBe(0);
  });

  it("a non-imageable word returns imageable:false + [] and makes NO Pexels call", async () => {
    createSpy.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({ imageable: false, query: "" }) } }],
    });
    const api = await client();
    const r = await post(api, { word: "freedom" });

    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.imageable).toBe(false);
    expect(r.body.images).toEqual([]);
    // The core invariant: no outbound Pexels call when the word is not imageable.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a missing PEXELS_API_KEY degrades gracefully (reason no_key, no Pexels call)", async () => {
    delete process.env.PEXELS_API_KEY;
    const api = await client();
    const r = await post(api);

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, imageable: false, images: [], reason: "no_key" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a malformed model response degrades gracefully (reason bad_model_json, no Pexels call)", async () => {
    createSpy.mockResolvedValueOnce({
      choices: [{ message: { content: "this is not json at all {" } }],
    });
    const api = await client();
    const r = await post(api);

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, imageable: false, images: [], reason: "bad_model_json" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("repairs slightly-broken model JSON (jsonrepair) and still returns images", async () => {
    // Trailing comma -> JSON.parse fails, jsonrepair rescues it.
    createSpy.mockResolvedValueOnce({
      choices: [{ message: { content: '{"imageable": true, "query": "shelf",}' } }],
    });
    const api = await client();
    const r = await post(api);

    expect(r.body.imageable).toBe(true);
    expect(r.body.images.length).toBe(3);
  });

  it("a model-call failure degrades gracefully (reason model_failed, no Pexels call)", async () => {
    createSpy.mockRejectedValueOnce(new Error("openai exploded"));
    const api = await client();
    const r = await post(api);

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, imageable: false, images: [], reason: "model_failed" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a non-200 from Pexels degrades gracefully (reason pexels_error)", async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 429, json: async () => ({}) });
    const api = await client();
    const r = await post(api);

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, imageable: false, images: [], reason: "pexels_error" });
  });

  it("a Pexels timeout (aborted request) degrades gracefully (reason pexels_timeout)", async () => {
    const abortErr = new Error("The operation was aborted");
    abortErr.name = "AbortError";
    fetchSpy.mockRejectedValueOnce(abortErr);
    const api = await client();
    const r = await post(api);

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, imageable: false, images: [], reason: "pexels_timeout" });
  });

  it("a missing word degrades gracefully (reason no_word, no model or Pexels call)", async () => {
    const api = await client();
    const r = await post(api, { word: "" });

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, imageable: false, images: [], reason: "no_word" });
    expect(createSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("enforces the admin gate (401 without token, no model or Pexels call)", async () => {
    const api = await client();
    const r = await post(api, {}, /* withToken */ false);

    expect(r.status).toBe(401);
    expect(createSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
