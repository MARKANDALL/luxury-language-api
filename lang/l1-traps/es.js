// lang/l1-traps/es.js
// THE SPANISH-L1 DIFFICULTY TABLE: which English sounds are hard for a Spanish
// speaker, and how hard.
//
// ── MARK: THIS FILE IS YOURS TO CORRECT ──────────────────────────────────────
// You are the teacher; this is a first pass from the ESL literature on
// Spanish-L1 transfer, not a fixed truth. Every row is one line you can argue
// with. Change a tier, reword a reason, add a row, delete a row — the card
// picks the change up with no other edit anywhere. Same standing invitation as
// the "Worth knowing" facts in the frontend's notation.js.
//
// WHAT A TIER MEANS.
//   tier 1  a little difficult — the sound exists in Spanish in some form, or
//           the substitution a Spanish speaker makes still lands intelligibly.
//   tier 2  very difficult — Spanish has no such sound or no such position, and
//           the usual substitution changes the word or blocks understanding.
//
// WHY A TABLE AND NOT THE MODEL. The model was being asked "what is the hard
// sound here?" and answered with one guess per word, differently each time, and
// sometimes wrongly. Difficulty by first language is a known, stable, teachable
// fact: it belongs in a table a teacher owns. The model is still asked to write
// the TIP (the sentence of advice in the learner's language), but it is no
// longer asked which sounds are hard or how hard they are.
//
// THE SHAPE OF SPANISH, in one paragraph, because every row below follows from
// it. Spanish has five pure vowels (a e i o u) with no length and no tense/lax
// pair, so every English vowel contrast that rests on length or tenseness has
// to be learned from nothing. Unstressed Spanish vowels keep their full quality,
// so English's reduction to schwa is not a small matter of accent but a rhythm
// the ear has never used. Spanish syllables strongly prefer to end in a vowel,
// so English codas — especially clusters and voiced ones — get simplified,
// devoiced or dropped. And Spanish orthography is near-phonemic, so spelling
// pulls hard on pronunciation in a way it does not for most L1s.
//
// A NOTE ON DIALECT. These rows assume LATIN AMERICAN Spanish, which is what
// most Lux learners speak. Peninsular (Spain) speakers already have θ and find
// that row easy; that is called out in the row itself rather than forked into a
// second table, because it is the only row where the two diverge sharply.

/** tier 1 = a little difficult, tier 2 = very difficult. */
export const TIER_SOME = 1;
export const TIER_VERY = 2;

// ── Per-phoneme rows ─────────────────────────────────────────────────────────
// Keyed by the IPA symbol as it appears in the card's transcription. Length
// marks are stripped before lookup, so "iː" finds the "iː" row and "i" finds
// the "i" row only if one exists; see normalizeSymbol below.

export const ES_PHONEME_TRAPS = {
  // ── Vowels ────────────────────────────────────────────────────────────────
  "ɪ": {
    tier: TIER_VERY,
    why: "Spanish has one i. English needs a short, lax ɪ (ship) kept apart from a long iː (sheep), and the pair changes words.",
  },
  "iː": {
    tier: TIER_SOME,
    why: "Close to Spanish i, but it must stay long and tense or it collapses into ɪ and takes the contrast with it.",
  },
  "æ": {
    tier: TIER_VERY,
    why: "No Spanish equivalent. It usually comes out as a (cat sounds like cot) or as e (bad sounds like bed).",
  },
  "ʌ": {
    tier: TIER_VERY,
    why: "No Spanish equivalent. It merges with a, so cup and cop stop being different words.",
  },
  "ɑ": {
    tier: TIER_SOME,
    why: "The nearest thing to Spanish a, so it lands close; the risk is that æ and ʌ collapse into it too.",
  },
  "ʊ": {
    tier: TIER_VERY,
    why: "Spanish has one u. The short, lax ʊ (book) is heard and produced as the long uː (boot).",
  },
  "uː": {
    tier: TIER_SOME,
    why: "Close to Spanish u, but it must stay long or the contrast with ʊ disappears.",
  },
  "ə": {
    tier: TIER_VERY,
    why: "Spanish keeps unstressed vowels full. Schwa is not a sound so much as a habit of weakening, and it is everywhere in English.",
  },
  "ɜ": {
    tier: TIER_VERY,
    why: "No Spanish equivalent. The vowel in bird has no Spanish anchor at all, and the r colouring makes it harder.",
  },
  "ɝ": {
    tier: TIER_VERY,
    why: "The American bird vowel: a vowel said with the English r built into it. Spanish has neither the vowel nor that r.",
  },
  "ɚ": {
    tier: TIER_VERY,
    why: "The weak ending of teacher, and it carries the English r. Spanish reaches for a tapped r and a full vowel instead.",
  },
  "ɛ": {
    tier: TIER_SOME,
    why: "Close to Spanish e. It drifts when it has to stay short in front of a consonant cluster.",
  },
  "ɒ": {
    tier: TIER_SOME,
    why: "The British hot vowel. Spanish o is near enough to be understood; the rounding is the difference.",
  },
  "ɔ": {
    tier: TIER_SOME,
    why: "Maps onto Spanish o closely enough to be understood; the length and the openness are what need work.",
  },
  "e": {
    tier: TIER_SOME,
    why: "Spanish e is close. It drifts only when it has to stay short next to a following consonant cluster.",
  },
  "eɪ": {
    tier: TIER_SOME,
    why: "Spanish has ei, so the glide is familiar; it tends to be cut short rather than mispronounced.",
  },
  "oʊ": {
    tier: TIER_SOME,
    why: "Spanish o plus a weak glide gets close. It usually comes out as a pure o, which is understood.",
  },
  "aɪ": {
    tier: TIER_SOME,
    why: "Spanish ai is close; the English version is longer and the second half weaker.",
  },
  "aʊ": {
    tier: TIER_SOME,
    why: "Spanish au is close; same difference of length and weight as the other diphthongs.",
  },
  "ɔɪ": {
    tier: TIER_SOME,
    why: "Spanish oi is close. This one rarely causes trouble.",
  },

  // ── Consonants ────────────────────────────────────────────────────────────
  "v": {
    tier: TIER_VERY,
    why: "Spanish has no v. Both b and v are written differently and said the same, so vote and boat come out alike.",
  },
  "z": {
    tier: TIER_VERY,
    why: "Spanish s is always voiceless. z becomes s, so eyes and ice stop being different.",
  },
  "ʃ": {
    tier: TIER_VERY,
    why: "Not a sound in most Spanish dialects. It usually surfaces as tʃ, so she becomes che.",
  },
  "ʒ": {
    tier: TIER_VERY,
    why: "Rare or absent in Spanish. It tends to become ʃ or dʒ, neither of which is the target.",
  },
  "dʒ": {
    tier: TIER_VERY,
    why: "Spanish has tʃ but not dʒ. The voicing is the whole difference, so joke and choke get confused.",
  },
  "θ": {
    tier: TIER_VERY,
    why: "Absent from Latin American Spanish, where it becomes s or t. Peninsular speakers already have it and find this one easy.",
  },
  "ð": {
    tier: TIER_SOME,
    why: "Spanish already says this between vowels (nada), so the sound exists; putting it at the start of a word is the new part.",
  },
  "h": {
    tier: TIER_SOME,
    why: "Written h is silent in Spanish, so it gets dropped, or replaced by the harder Spanish j. Both stay intelligible.",
  },
  "ŋ": {
    tier: TIER_SOME,
    why: "Spanish has this sound before k and g, but not standing alone at the end of a word, where it becomes n.",
  },
  "ɹ": {
    tier: TIER_VERY,
    why: "Nothing like the Spanish r. Spanish taps or trills with the tongue tip; English bunches the tongue and touches nothing.",
  },
  "r": {
    tier: TIER_VERY,
    why: "Same sound as ɹ under a different transcription: the English r is not the Spanish tap or trill.",
  },
  "w": {
    tier: TIER_SOME,
    why: "Spanish has this in hueso and cuando, so it exists; it drifts toward gu at the start of a word.",
  },
  "j": {
    tier: TIER_SOME,
    why: "Spanish has this, but it hardens toward dʒ or ʒ in many dialects, which changes yes into jes.",
  },
};

// ── Pattern rows ─────────────────────────────────────────────────────────────
// Some difficulties are not a sound but a POSITION or a SEQUENCE. Each row gets
// the whole phoneme list and an index, and says whether the trap applies at
// that index. Patterns are matched after the per-phoneme rows and can raise a
// phoneme's tier, never lower it.

// EVERY vowel symbol a transcription might use, not just the ones with rows
// above. The coda rules ask "is this a vowel?" to find where the syllable ends,
// so a vowel missing from this set makes a whole word read as one consonant
// run. The r-coloured pair (ɝ, ɚ) is what General American uses for bird and
// teacher, and it is what the route actually returns.
const VOWELS = new Set([
  "i", "iː", "ɪ", "e", "ɛ", "eɪ", "æ", "ɑ", "ɑː", "ɒ", "ʌ", "ɔ", "ɔː", "oʊ",
  "ʊ", "u", "uː", "ə", "ɜ", "ɜː", "ɝ", "ɚ", "aɪ", "aʊ", "ɔɪ", "ɪə", "eə",
  "ʊə", "əʊ", "ɐ", "ɵ",
]);

const VOICED_OBSTRUENTS = new Set(["b", "d", "g", "v", "z", "ʒ", "dʒ", "ð"]);

const isVowel = (p) => VOWELS.has(String(p || "").replace(/[ːˑ]/g, "")) || VOWELS.has(p);

export const ES_PATTERN_TRAPS = [
  {
    id: "initial-s-cluster",
    tier: TIER_VERY,
    why: "Spanish has no word starting s + consonant, so an e appears in front of it: school becomes eschool.",
    // The s of an initial sC- cluster, and only at the very start of the word.
    test(phonemes, i) {
      if (i !== 0) return false;
      if (phonemes[0] !== "s") return false;
      const next = phonemes[1];
      return !!next && !isVowel(next);
    },
  },
  {
    id: "final-cluster",
    tier: TIER_VERY,
    why: "Spanish words almost never end in two or more consonants, so the cluster gets broken up or trimmed.",
    // The first consonant of the run that closes the word. The coda is defined
    // as everything after the LAST vowel, so a word with no vowel this file
    // recognises produces no cluster trap instead of one enormous false one.
    test(phonemes, i) {
      const n = phonemes.length;
      if (i >= n || isVowel(phonemes[i])) return false;
      let lastVowel = -1;
      for (let k = 0; k < n; k++) if (isVowel(phonemes[k])) lastVowel = k;
      if (lastVowel < 0) return false; // no vowel found: say nothing
      const codaLength = n - 1 - lastVowel;
      return codaLength >= 2 && i === lastVowel + 1;
    },
  },
  {
    id: "final-voiced",
    tier: TIER_VERY,
    why: "Spanish devoices or drops a voiced consonant at the end of a word, so his sounds like hiss and bad like bat.",
    test(phonemes, i) {
      return i === phonemes.length - 1 && VOICED_OBSTRUENTS.has(phonemes[i]);
    },
  },
  {
    id: "final-t",
    tier: TIER_SOME,
    why: "A word-final t is weak or dropped in Spanish habits, which can take the whole past tense with it.",
    test(phonemes, i) {
      return i === phonemes.length - 1 && phonemes[i] === "t";
    },
  },
  {
    id: "dark-l",
    tier: TIER_SOME,
    why: "Spanish l is always clear and forward. English darkens it after a vowel, which is why full and fool sound alike.",
    test(phonemes, i) {
      if (phonemes[i] !== "l") return false;
      if (i === 0) return false;
      // Dark only in the coda: preceded by a vowel, and not starting a new
      // syllable in front of one.
      const next = phonemes[i + 1];
      return isVowel(phonemes[i - 1]) && (next === undefined || !isVowel(next));
    },
  },
  {
    id: "initial-aspiration",
    tier: TIER_SOME,
    why: "English p, t and k come with a puff of air at the start of a word; Spanish ones do not, so they can be heard as b, d and g.",
    test(phonemes, i) {
      return i === 0 && (phonemes[0] === "p" || phonemes[0] === "t" || phonemes[0] === "k");
    },
  },
];

/** Strip length marks so "iː" and "i" both find their row. */
export function normalizeSymbol(sym) {
  return String(sym || "").replace(/[ˈˌ]/g, "");
}

/**
 * Every trap in a word, in phoneme order.
 *
 * Returns `[{ symbol, index, tier, why }]` — zero, one or several. A phoneme
 * that matches both a per-phoneme row and a pattern keeps the HIGHER tier and
 * the reason that goes with it, because that is the one worth reading first.
 *
 * @param {string[]} phonemes one entry per sound, already split
 * @returns {Array<{symbol:string,index:number,tier:number,why:string}>}
 */
export function findTraps(phonemes) {
  const list = Array.isArray(phonemes) ? phonemes : [];
  const out = [];

  list.forEach((sym, index) => {
    const bare = normalizeSymbol(sym);
    const noLength = bare.replace(/[ːˑ]/g, "");
    const row = ES_PHONEME_TRAPS[bare] || ES_PHONEME_TRAPS[noLength] || null;

    let best = row ? { symbol: sym, index, tier: row.tier, why: row.why } : null;

    for (const pat of ES_PATTERN_TRAPS) {
      let hit = false;
      try {
        hit = !!pat.test(list, index);
      } catch {
        hit = false;
      }
      if (!hit) continue;
      if (!best || pat.tier > best.tier) {
        best = { symbol: sym, index, tier: pat.tier, why: pat.why };
      }
    }

    if (best) out.push(best);
  });

  return out;
}

export default { ES_PHONEME_TRAPS, ES_PATTERN_TRAPS, findTraps, TIER_SOME, TIER_VERY };
