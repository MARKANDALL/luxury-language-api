// lib/metrics.js
// One-line: Reads one stored score off an attempt summary, returning null for
// "not scored" so a silent turn can never be averaged in as a zero.
//
// WHY THIS EXISTS
// ---------------
// routes/attempt.js stores `pron: null` for an attempt Azure never scored — a
// typed conversation turn, a recording with no speech in it. That is correct
// and deliberate. The readers then undid it: `Number(null)` is 0, and 0 is a
// finite number, so every "is this a real score" guard downstream waved it
// through as a genuine total failure. A four-turn conversation scored 88, 90
// and 86 with one typed turn reported Pronunciation 66.
//
// `Number()` is the wrong tool for reading a stored metric, because the values
// it turns into 0 are exactly the values that mean "absent": null, "", "  ",
// [], false. So this accepts only what a score can actually be — a finite
// number, or a string that parses to one — and returns null for everything
// else.
//
// A genuine 0 is REAL DATA and survives. The opposite mistake (treating a hard
// zero as no data) is its own bug, and this must not commit it.
export function metricNum(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export default metricNum;
