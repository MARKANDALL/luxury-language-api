// lang/l1-traps/index.js
// Which first languages have a difficulty table, and how a word's IPA becomes
// the list of traps the card paints.
//
// ⚠️ TWIN FILE: splitIpa below mirrors features/word-motor/card-phonemes.js in
// the frontend, symbol for symbol. The two MUST agree, because a trap carries
// an INDEX into the phoneme list and the frontend paints the chip at that
// index. If you add a digraph to one, add it to the other in the same PR. The
// frontend also matches on the symbol as a guard, so a drift degrades to "the
// chip is not marked" rather than "the wrong chip is marked" — but it is still
// a drift, and it is still wrong.

import * as es from "./es.js";

/** L1 code -> its table module. Add a language by adding a file and a line. */
const TABLES = { es };

// The multi-character IPA symbols that must not be split down the middle.
const DIGRAPHS = [
  "tʃ", "dʒ", "eɪ", "aɪ", "ɔɪ", "aʊ", "oʊ", "ɪə", "eə", "ʊə", "əʊ",
];

// Combining marks ride along with the symbol before them rather than becoming
// entries of their own.
const ATTACHING = new Set(["ː", "ˑ", "̩", "̯", "͡", "ʰ", "ʲ", "ʷ", "̃"]);
const DROPPED = new Set(["ˈ", "ˌ", "/", "[", "]", ".", " ", "​"]);

/**
 * Split an IPA transcription into one entry per phoneme. PURE.
 * @param {string} ipa
 * @returns {string[]}
 */
export function splitIpa(ipa) {
  const s = String(ipa || "").trim().replace(/^\/|\/$/g, "");
  if (!s) return [];
  const chars = [...s];
  const out = [];
  for (let i = 0; i < chars.length; i++) {
    const two = chars[i] + (chars[i + 1] || "");
    if (DIGRAPHS.includes(two)) {
      out.push(two);
      i++;
      continue;
    }
    const c = chars[i];
    if (DROPPED.has(c)) continue;
    if (ATTACHING.has(c)) {
      if (out.length) out[out.length - 1] += c;
      continue;
    }
    out.push(c);
  }
  return out;
}

/** Is there a hand-written table for this first language? */
export function hasTrapTable(l1) {
  return Object.prototype.hasOwnProperty.call(TABLES, String(l1 || ""));
}

/**
 * Every trap in a word for this L1.
 *
 * Returns `{ traps, source }`. `source` is "table" when a hand-written table
 * decided, and "model" when there is none for this L1 and the caller should
 * fall back to the model's single judgement. A caller that gets "model" back
 * gets an EMPTY trap list: this function never guesses.
 *
 * @param {string} ipa the word's transcription
 * @param {string} l1 the learner's first language
 */
export function trapsForWord(ipa, l1) {
  const code = String(l1 || "").toLowerCase();
  const table = TABLES[code];
  if (!table || typeof table.findTraps !== "function") {
    return { traps: [], source: "model" };
  }
  return { traps: table.findTraps(splitIpa(ipa)), source: "table" };
}

export default { splitIpa, hasTrapTable, trapsForWord };
