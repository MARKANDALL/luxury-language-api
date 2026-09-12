// test/l1-traps.es.test.js
// Round 6 item 4 — the Spanish difficulty table, pinned on the six words Mark
// named plus the cases that broke the first draft.
//
// These are CONTRACT tests for a table a teacher owns. If Mark retunes a tier,
// the matching expectation here changes with it and that is correct; what must
// not change silently is WHICH sounds get flagged and how the position rules
// (initial sC-, final cluster, final voiced, dark l) decide.

import { describe, it, expect } from "vitest";
import { trapsForWord, splitIpa, hasTrapTable } from "../lang/l1-traps/index.js";
import { findTraps, ES_PHONEME_TRAPS, TIER_SOME, TIER_VERY } from "../lang/l1-traps/es.js";

/** "symbol(tier)@index" for every trap, in phoneme order. */
const sig = (ipa) =>
  trapsForWord(ipa, "es").traps.map((t) => `${t.symbol}(${t.tier})@${t.index}`);

/** Just the tier for one symbol, or undefined when it is not flagged. */
const tierOf = (ipa, symbol) =>
  trapsForWord(ipa, "es").traps.find((t) => t.symbol === symbol)?.tier;

describe("the table is wired up", () => {
  it("has Spanish and does not invent other languages", () => {
    expect(hasTrapTable("es")).toBe(true);
    expect(hasTrapTable("fr")).toBe(false);
  });

  it("an L1 with no table gets NO traps and says the model must decide", () => {
    const out = trapsForWord("wɝld", "fr");
    expect(out.traps).toEqual([]);
    expect(out.source).toBe("model");
  });

  it("Spanish reports that the table decided", () => {
    expect(trapsForWord("wɝld", "es").source).toBe("table");
  });

  it("splits IPA the way the card's chips do", () => {
    expect(splitIpa("ˈtiːtʃɚ")).toEqual(["t", "iː", "tʃ", "ɚ"]);
    expect(splitIpa("/dʒʌmp/")).toEqual(["dʒ", "ʌ", "m", "p"]);
  });
});

describe("the six pinned words", () => {
  // wɝld: the American r-coloured vowel, a dark l inside a final cluster, and a
  // final voiced d. Four sounds, three of them hard.
  it("world", () => {
    expect(sig("wɝld")).toEqual(["w(1)@0", "ɝ(2)@1", "l(2)@2", "d(2)@3"]);
  });

  it("world transcribed the British way finds the same traps", () => {
    expect(sig("wɜːld")).toEqual(["w(1)@0", "ɜː(2)@1", "l(2)@2", "d(2)@3"]);
  });

  // sɪksθ: the ɪ/iː contrast, then a three-consonant coda ending in θ.
  it("sixth", () => {
    expect(sig("sɪksθ")).toEqual(["ɪ(2)@1", "k(2)@2", "θ(2)@4"]);
  });

  // wʊlvz: four very difficult sounds in five, which is the point of the word.
  it("wolves", () => {
    expect(sig("wʊlvz")).toEqual(["w(1)@0", "ʊ(2)@1", "l(2)@2", "v(2)@3", "z(2)@4"]);
  });

  // ˈrændi: the English r and the æ, both tier 2, and nothing else.
  it("Randy", () => {
    expect(sig("ˈrændi")).toEqual(["r(2)@0", "æ(2)@1"]);
  });

  // plæn: only the vowel is hard; the initial p is the aspiration nudge.
  it("plan", () => {
    expect(sig("plæn")).toEqual(["p(1)@0", "æ(2)@2"]);
  });

  // stɔːl: the initial sC- cluster is the headline, not the vowel.
  it("stall", () => {
    expect(sig("stɔːl")).toEqual(["s(2)@0", "ɔː(1)@2", "l(1)@3"]);
  });
});

describe("the position rules", () => {
  it("initial s + consonant is tier 2; s before a vowel is not flagged at all", () => {
    expect(tierOf("stɔːl", "s")).toBe(TIER_VERY);
    expect(tierOf("sɪksθ", "s")).toBeUndefined(); // /sɪ/ is s before a vowel
  });

  it("a final cluster flags its FIRST consonant only, once", () => {
    const traps = trapsForWord("sɪksθ", "es").traps;
    const cluster = traps.filter((t) => /almost never end in two/.test(t.why));
    expect(cluster).toHaveLength(1);
    expect(cluster[0].index).toBe(2); // the k that opens /ksθ/
  });

  it("a final voiced consonant is tier 2 and a final t is tier 1", () => {
    expect(tierOf("hɪz", "z")).toBe(TIER_VERY);
    expect(tierOf("kæt", "t")).toBe(TIER_SOME);
  });

  it("dark l after a vowel is flagged; clear l before one is not", () => {
    expect(tierOf("stɔːl", "l")).toBe(TIER_SOME); // coda: dark
    expect(tierOf("plæn", "l")).toBeUndefined(); // onset: clear, native
  });

  it("the higher tier wins when a sound is both a phoneme trap and a pattern", () => {
    // The l of world is dark (tier 1) AND inside a final cluster (tier 2).
    expect(tierOf("wɝld", "l")).toBe(TIER_VERY);
  });
});

describe("the vowel set is what the coda rules stand on", () => {
  // The first draft did not know ɝ was a vowel, so world read as a
  // four-consonant coda and the vowel trap went missing entirely.
  it("an r-coloured vowel is a vowel, not a consonant", () => {
    const traps = trapsForWord("wɝld", "es").traps;
    expect(traps.find((t) => t.index === 0).tier).toBe(TIER_SOME); // w, not a cluster
    expect(traps.find((t) => t.symbol === "ɝ")).toBeTruthy();
  });

  it("a word with no recognised vowel produces no cluster trap rather than a false one", () => {
    // Nonsense input must degrade to silence, never to a confident wrong answer.
    const traps = trapsForWord("qqq", "es").traps;
    expect(traps.every((t) => !/almost never end in two/.test(t.why))).toBe(true);
  });
});

describe("the table itself", () => {
  it("every row has a tier of 1 or 2 and a reason that reads as a sentence", () => {
    for (const [sym, row] of Object.entries(ES_PHONEME_TRAPS)) {
      expect([TIER_SOME, TIER_VERY], sym).toContain(row.tier);
      expect(row.why.length, sym).toBeGreaterThan(20);
      expect(row.why.trim().endsWith("."), sym).toBe(true);
    }
  });

  it("findTraps is total: junk in, empty list out", () => {
    expect(findTraps([])).toEqual([]);
    expect(findTraps(null)).toEqual([]);
  });

  it("returns traps in phoneme order", () => {
    const idx = trapsForWord("wʊlvz", "es").traps.map((t) => t.index);
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
  });
});
