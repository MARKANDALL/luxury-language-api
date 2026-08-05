// routes/coach-page/knowledge.js
// THE KNOWLEDGE DOC SEAM — the Lux Bible's socket, built before the Bible.
//
// The charter grounds two lanes in a document that does not exist yet:
// NAV_HELP ("how Lux works, where things are. Grounded in the Bible") and
// CREATOR_INFO ("about Mark and about Lux's philosophy. Grounded in the Bible's
// bio and philosophy sections"). The doc is being written. The socket is built
// now, so that the day the file lands in docs/ it is picked up on the next cold
// start with no code change, no deploy dance and no flag.
//
// THE CONTRACT
//   - Read a markdown file from a known path (below), once per process.
//   - Missing file, unreadable file, empty file: DEGRADE, never throw. The lane
//     still answers; it just answers from the page list and says "I'm not sure"
//     where it would otherwise have cited. An absent doc must never turn a
//     working coach into a 500.
//   - Bound it. A Bible can grow without limit; the prompt cannot. The doc is
//     clipped at a line boundary so a half-sentence never reaches the model, and
//     the clip is announced in the block so the coach knows it is holding an
//     excerpt rather than the whole book.
//
// WHERE THE FILE GOES. docs/LUX_BIBLE.md in this repo, resolved relative to this
// module rather than to process.cwd() so it works the same under Vercel, vitest
// and a local node. LUX_KNOWLEDGE_DOC overrides the path (absolute, or relative
// to the repo root) for anyone who wants to keep the doc somewhere else.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isAbsolute, join } from "node:path";

// The lanes the charter grounds in the doc. Everything else never reads it, so
// the file cost is paid on navigation and creator questions only.
export const KNOWLEDGE_LANES = Object.freeze(["NAV_HELP", "CREATOR_INFO"]);

// Candidate paths, in order. The first one that reads wins. Two names rather
// than one because the doc is unwritten and the version suffix is a coin flip;
// both are cheap to try and the resolution is deterministic.
export const KNOWLEDGE_DOC_FILES = Object.freeze(["docs/LUX_BIBLE.md", "docs/LUX_BIBLE_v1.md"]);

// The prompt is not a filesystem. Enough for a real navigation answer, small
// enough that the doc can never crowd out the learner's own question.
export const KNOWLEDGE_MAX_CHARS = 6000;

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** The absolute candidate paths, override first. */
export function knowledgeDocPaths(env = process.env) {
  const override = String(env?.LUX_KNOWLEDGE_DOC || "").trim();
  const rel = override ? [override, ...KNOWLEDGE_DOC_FILES] : [...KNOWLEDGE_DOC_FILES];
  return rel.map((p) => (isAbsolute(p) ? p : join(REPO_ROOT, p)));
}

/**
 * Clip markdown at a line boundary, never mid-sentence. Deterministic: the same
 * doc always yields the same excerpt.
 */
export function clipMarkdown(text, maxChars = KNOWLEDGE_MAX_CHARS) {
  const s = String(text || "").trim();
  if (s.length <= maxChars) return { text: s, truncated: false };
  const window = s.slice(0, maxChars);
  const lastBreak = window.lastIndexOf("\n");
  const cut = lastBreak > maxChars * 0.5 ? window.slice(0, lastBreak) : window;
  return { text: cut.trimEnd(), truncated: true };
}

/**
 * Read the doc from the first candidate path that yields one. Never throws.
 *
 * @param {object}   [deps]
 * @param {string[]} [deps.paths]     override the candidate list (tests)
 * @param {Function} [deps.read]      override the reader (tests)
 * @param {number}   [deps.maxChars]
 * @returns {Promise<{ok: boolean, path: string, text: string, chars: number, truncated: boolean}>}
 */
export async function readKnowledgeDoc({ paths, read = readFile, maxChars = KNOWLEDGE_MAX_CHARS } = {}) {
  const candidates = Array.isArray(paths) ? paths : knowledgeDocPaths();
  for (const path of candidates) {
    let raw;
    try {
      raw = await read(path, "utf8");
    } catch {
      continue; // not there (or not readable) — try the next name
    }
    const { text, truncated } = clipMarkdown(raw, maxChars);
    if (!text) continue; // an empty file is the same as no file
    return { ok: true, path, text, chars: text.length, truncated };
  }
  return { ok: false, path: "", text: "", chars: 0, truncated: false };
}

// One read per process. On Vercel a cold start re-reads, which is exactly the
// refresh cadence we want: deploy the doc, and the next lambda picks it up.
let _cache = null;

/** The cached doc. Same shape as readKnowledgeDoc, including the absent case. */
export async function knowledgeDoc(deps) {
  if (!_cache) _cache = readKnowledgeDoc(deps);
  try {
    return await _cache;
  } catch {
    // readKnowledgeDoc does not throw, but a caller-supplied reader might in a
    // way we did not anticipate. A knowledge doc is never worth an outage.
    _cache = null;
    return { ok: false, path: "", text: "", chars: 0, truncated: false };
  }
}

/** Drop the cache. Tests only — nothing in the request path should call this. */
export function resetKnowledgeCache() {
  _cache = null;
}

/**
 * The prompt block for a lane that was granted the doc.
 *
 * The absent case is deliberately NOT an empty string: the model is told the
 * reference is unavailable and told what to do about it, because the failure
 * this whole pass exists to fix is a coach that fills a silence with invention.
 *
 * @param {{ok?: boolean, text?: string, truncated?: boolean}|null} doc
 */
export function knowledgeBlock(doc) {
  if (!doc || !doc.ok || !doc.text) {
    return (
      "\nLUX KNOWLEDGE: the reference document is not available in this build. " +
      "Answer only from the pages listed above and what you were given, and say " +
      "plainly when you are not sure something exists.\n"
    );
  }
  const tail = doc.truncated
    ? "\n(This is an excerpt. Something missing here is unknown to you, not absent from Lux.)"
    : "";
  return `\nLUX KNOWLEDGE (the reference document — the only source you may state Lux facts from):\n${doc.text}${tail}\n`;
}

export default knowledgeDoc;
