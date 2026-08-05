// test/coach-page.knowledge.test.js
// Unit tests for THE KNOWLEDGE DOC SEAM (routes/coach-page/knowledge.js).
//
// The Lux Bible is being written and is NOT in this repo. The most important
// test here is therefore the boring one: with no doc on disk, the seam returns
// an honest empty answer and the prompt block tells the coach to say "I'm not
// sure" instead of inventing. The day the file lands, the same code path picks
// it up — which is what the "reads whatever is at the known path" tests pin.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { access } from "node:fs/promises";
import {
  KNOWLEDGE_DOC_FILES,
  KNOWLEDGE_LANES,
  KNOWLEDGE_MAX_CHARS,
  clipMarkdown,
  knowledgeBlock,
  knowledgeDoc,
  knowledgeDocPaths,
  readKnowledgeDoc,
  resetKnowledgeCache,
} from "../routes/coach-page/knowledge.js";
import { laneWantsKnowledge } from "../routes/coach-page/context.js";

const BIBLE = `# THE LUX BIBLE

## Navigation
Practice Skills is where you record a line and get per-sound detail.

## Mark
Mark is a language teacher who built Lux.`;

beforeEach(() => {
  resetKnowledgeCache();
  delete process.env.LUX_KNOWLEDGE_DOC;
});

describe("knowledge seam — the doc is not written yet, and nothing breaks", () => {
  it("the repo really does not ship the doc (this test's whole premise)", async () => {
    const missing = [];
    for (const path of knowledgeDocPaths()) {
      const there = await access(path).then(
        () => true,
        () => false
      );
      if (!there) missing.push(path);
    }
    // If this ever fails, the Bible landed — delete this test, not the seam.
    expect(missing).toHaveLength(knowledgeDocPaths().length);
  });

  it("returns the empty shape rather than throwing when no candidate exists", async () => {
    const doc = await readKnowledgeDoc();
    expect(doc).toEqual({ ok: false, path: "", text: "", chars: 0, truncated: false });
  });

  it("degrades through the cached entry point too", async () => {
    const doc = await knowledgeDoc();
    expect(doc.ok).toBe(false);
    expect(doc.text).toBe("");
  });

  it("survives a reader that throws on every candidate", async () => {
    const read = vi.fn(async () => {
      throw new Error("EACCES");
    });
    const doc = await readKnowledgeDoc({ read });
    expect(doc.ok).toBe(false);
    expect(read).toHaveBeenCalledTimes(knowledgeDocPaths().length);
  });

  it("treats an empty or whitespace-only file as no file at all", async () => {
    const doc = await readKnowledgeDoc({ paths: ["/x/a.md"], read: async () => "   \n\n  " });
    expect(doc.ok).toBe(false);
  });

  it("tells the model the reference is missing instead of falling silent", () => {
    const block = knowledgeBlock({ ok: false, text: "" });
    expect(block).toContain("not available");
    expect(block).toContain("say");
    expect(block).toContain("not sure");
  });

  it("says the same thing for a null doc", () => {
    expect(knowledgeBlock(null)).toContain("not available");
  });
});

describe("knowledge seam — when the doc lands", () => {
  it("reads the first candidate that yields text", async () => {
    const read = vi.fn(async (p) => {
      if (p.endsWith(KNOWLEDGE_DOC_FILES[0])) throw new Error("ENOENT");
      return BIBLE;
    });
    const doc = await readKnowledgeDoc({ read });
    expect(doc.ok).toBe(true);
    expect(doc.path.endsWith(KNOWLEDGE_DOC_FILES[1])).toBe(true);
    expect(doc.text).toContain("Mark is a language teacher");
  });

  it("puts the doc in the prompt as the only source of Lux facts", () => {
    const block = knowledgeBlock({ ok: true, text: BIBLE, truncated: false });
    expect(block).toContain("LUX KNOWLEDGE");
    expect(block).toContain("Practice Skills is where you record a line");
    expect(block).not.toContain("not available");
  });

  it("reads the doc once per process, not once per ask", async () => {
    const read = vi.fn(async () => BIBLE);
    const first = await knowledgeDoc({ read });
    const second = await knowledgeDoc({ read });
    expect(first.text).toBe(second.text);
    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe("knowledge seam — the known path", () => {
  it("defaults to docs/LUX_BIBLE.md in this repo", () => {
    const paths = knowledgeDocPaths({});
    expect(paths[0].endsWith("docs/LUX_BIBLE.md")).toBe(true);
    expect(paths[0].startsWith("/")).toBe(true); // resolved, not cwd-dependent
  });

  it("lets LUX_KNOWLEDGE_DOC win, absolute or repo-relative", () => {
    expect(knowledgeDocPaths({ LUX_KNOWLEDGE_DOC: "/srv/bible.md" })[0]).toBe("/srv/bible.md");
    const rel = knowledgeDocPaths({ LUX_KNOWLEDGE_DOC: "docs/other.md" })[0];
    expect(rel.endsWith("docs/other.md")).toBe(true);
    expect(rel.startsWith("/")).toBe(true);
  });

  it("keeps the built-in candidates behind the override", () => {
    const paths = knowledgeDocPaths({ LUX_KNOWLEDGE_DOC: "/srv/bible.md" });
    expect(paths).toHaveLength(KNOWLEDGE_DOC_FILES.length + 1);
  });
});

describe("knowledge seam — bounding", () => {
  it("leaves a short doc alone", () => {
    expect(clipMarkdown(BIBLE)).toEqual({ text: BIBLE, truncated: false });
  });

  it("clips a long doc at a line boundary, never mid-sentence", () => {
    const long = Array.from({ length: 400 }, (_, i) => `## Section ${i}\nSome prose here.`).join(
      "\n"
    );
    const { text, truncated } = clipMarkdown(long, 500);
    expect(truncated).toBe(true);
    expect(text.length).toBeLessThanOrEqual(500);
    expect(long.startsWith(text)).toBe(true);
    // The cut lands ON a line break — no half-line, no half-sentence.
    expect(long[text.length]).toBe("\n");
  });

  it("bounds what actually reaches the prompt", async () => {
    const doc = await readKnowledgeDoc({ paths: ["/x/a.md"], read: async () => "x".repeat(50000) });
    expect(doc.chars).toBeLessThanOrEqual(KNOWLEDGE_MAX_CHARS);
    expect(doc.truncated).toBe(true);
  });

  it("tells the coach an excerpt is an excerpt, so silence is not absence", () => {
    const block = knowledgeBlock({ ok: true, text: "half a bible", truncated: true });
    expect(block).toContain("excerpt");
    expect(block).toContain("not absent from Lux");
  });
});

describe("knowledge seam — which lanes get it", () => {
  it("is exactly the two the charter grounds in the Bible", () => {
    expect([...KNOWLEDGE_LANES]).toEqual(["NAV_HELP", "CREATOR_INFO"]);
  });

  it("agrees with the lane diet", () => {
    for (const lane of KNOWLEDGE_LANES) expect(laneWantsKnowledge(lane)).toBe(true);
    for (const lane of ["EXPLAIN", "PATTERNS", "LANGUAGE_GENERAL", "ROUTE_TO_PAGE"]) {
      expect(laneWantsKnowledge(lane)).toBe(false);
    }
  });
});
