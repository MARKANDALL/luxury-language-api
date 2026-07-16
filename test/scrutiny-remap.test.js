// test/scrutiny-remap.test.js
// Phase 3 scrutiny remap — BACKEND MIRROR test. The expectation table below is
// byte-identical to the frontend twin (lux-frontend/tests/scrutiny-remap.test.js);
// if one changes, change both, or the mirror has drifted and coach-side tiering
// will disagree with the UI.

import { describe, it, expect } from "vitest";
import {
  POINTS_PER_NOTCH,
  applyScrutiny,
  normalizeScrutinyDelta,
  adjustAzureResultForScrutiny,
  getScrutinyInfo,
  scoreTier,
  cefrBandFromScore,
  extractOverallPronScore,
  extractOverallPronScoreRaw,
} from "../routes/pronunciation-gpt/scoring.js";

// ── Prototype parity table (raw 84 / 72 / 58 from the feel prototype) ────────
const PROTOTYPE_TABLE = [
  // delta, [adj84, adj72, adj58], [tier84, tier72, tier58]
  [-6, [97, 85, 71], ["good", "good", "warn"]],
  [-3, [91, 79, 65], ["good", "warn", "warn"]],
  [-2, [88, 76, 62], ["good", "warn", "warn"]],
  [-1, [86, 74, 60], ["good", "warn", "warn"]],
  [ 0, [84, 72, 58], ["good", "warn", "bad"]],
  [ 1, [82, 70, 56], ["good", "warn", "bad"]],
  [ 2, [80, 68, 54], ["good", "warn", "bad"]],   // 84 → 79.6 → rounds to 80: STAYS good
  [ 3, [77, 65, 51], ["warn", "warn", "bad"]],
  [ 6, [71, 59, 45], ["warn", "bad", "bad"]],
];
const RAWS = [84, 72, 58];

describe("scrutiny mirror: constant + delta normalization", () => {
  it("POINTS_PER_NOTCH is the locked 2.2 (twin of core/scoring/scrutiny.js)", () => {
    expect(POINTS_PER_NOTCH).toBe(2.2);
  });

  it("normalizeScrutinyDelta: non-finite → 0, clamped to ±17", () => {
    expect(normalizeScrutinyDelta(undefined)).toBe(0);
    expect(normalizeScrutinyDelta(NaN)).toBe(0);
    expect(normalizeScrutinyDelta("2")).toBe(2);
    expect(normalizeScrutinyDelta(99)).toBe(17);
    expect(normalizeScrutinyDelta(-99)).toBe(-17);
  });
});

describe("scrutiny mirror: prototype sample words (raw 84 / 72 / 58)", () => {
  for (const [delta, adjs, tiers] of PROTOTYPE_TABLE) {
    it(`delta ${delta >= 0 ? "+" + delta : delta}: adjusted ${adjs.join("/")} → ${tiers.join("/")}`, () => {
      RAWS.forEach((raw, i) => {
        const adjusted = applyScrutiny(raw, delta);
        expect(adjusted).toBe(adjs[i]);
        expect(scoreTier(adjusted)).toBe(tiers[i]);
      });
    });
  }

  it("boundary case: raw 84 at +2 rounds 79.6 → 80 and stays 'good'", () => {
    expect(applyScrutiny(84, 2)).toBe(80);
    expect(scoreTier(applyScrutiny(84, 2))).toBe("good");
  });

  it("CEFR mapping inherits rigor (raw 84: B1 raw → C2 at −6, A2 at +6)", () => {
    expect(cefrBandFromScore(84)).toBe("B1");
    expect(cefrBandFromScore(applyScrutiny(84, -6))).toBe("C2");
    expect(cefrBandFromScore(applyScrutiny(84, 6))).toBe("A2");
  });

  it("clamps to [0, 100] and passes null through", () => {
    expect(applyScrutiny(3, 6)).toBe(0);
    expect(applyScrutiny(98, -6)).toBe(100);
    expect(applyScrutiny(null, 3)).toBeNull();
  });
});

// ── Adjusted-view derivation on a realistic Azure shape ─────────────────────
function sampleAzure() {
  return {
    PronunciationAssessment: { PronunciationScore: 72, AccuracyScore: 74 },
    NBest: [
      {
        PronScore: 72,
        FluencyScore: 90,
        ProsodyScore: 66,
        PronunciationAssessment: { PronunciationScore: 72 },
        Words: [
          { Word: "comfortable", AccuracyScore: 84, Phonemes: [{ Phoneme: "k", AccuracyScore: 84 }] },
          { Word: "through", AccuracyScore: 72, Phonemes: [{ Phoneme: "θ", AccuracyScore: 58 }] },
          { Word: "vegetable", AccuracyScore: 58 },
        ],
      },
    ],
  };
}

// ── runCoach harness (shared by the integration + Phase 4 prompt tests) ──────
async function runWith({ azureResult, scrutinyDelta, buildPrompt, persona = "tutor" }) {
    const { runPronunciationCoach } = await import("../routes/pronunciation-gpt/runCoach.js");
    const { POINTS_PER_NOTCH } = await import("../routes/pronunciation-gpt/scoring.js");
    const seen = { worstWordsInput: null, overallInput: null, messages: null };

    const result = await runPronunciationCoach({
      openai: { chat: { completions: { create: async ({ messages }) => {
        seen.messages = messages;
        return {
          choices: [{ message: { content: JSON.stringify({ sections: [{ title: "T", en: "x", emoji: "✅" }] }) } }],
        };
      } } } },
      jsonrepair: (s) => s,
      QUICK_MODEL: "m", DEEP_MODEL: "m", DEEP_REASONING_MODEL: "", DEEP_REASONING_EFFORT: "", TRANSLATE_MODEL: "m",
      PERSONAS: { tutor: { role: "You are a warm tutor.", style: "Encouraging, gentle." } },
      PERSONAS_ES: null, DRILL_CASING_GUARDRAILS: "",
      forceJson: JSON.parse,
      parseJsonWithRepair: (s) => JSON.parse(s),
      safeNum: (v) => (Number.isFinite(Number(v)) ? Number(v) : null),
      scoreTier,
      cefrBandFromScore,
      extractOverallPronScore: (json) => { seen.overallInput = json; return extractOverallPronScore(json); },
      extractOverallPronScoreRaw,
      extractPronScore: () => null,
      adjustAzureResultForScrutiny,
      getScrutinyInfo,
      normalizeScrutinyDelta,
      POINTS_PER_NOTCH,
      makeNorm: () => (s) => s,
      worstPhoneme: () => "",
      worstWords: (json) => { seen.worstWordsInput = json; return []; },
      translateMissing: async () => {},
      computeHistorySummaryIfNeeded: async () => null,
      buildCoachPrompt: buildPrompt || (() => ({ targetSections: ["a"], systemPrompt: "s", maxTokens: 64 })),
    }, { referenceText: "t", azureResult, mode: "simple", persona, scrutinyDelta });

    const sys = seen.messages?.find((m) => m.role === "system")?.content || "";
    const user = JSON.parse(seen.messages?.find((m) => m.role === "user")?.content || "{}");
    return { result, seen, sys, user };
}

// ── runCoach integration: the coach must reason about ADJUSTED scores ────────
describe("scrutiny mirror: runPronunciationCoach applies rigor before tiering", () => {
  it("untagged (raw) input + scrutinyDelta: extraction sees ADJUSTED scores", async () => {
    const { result, seen } = await runWith({ azureResult: sampleAzure(), scrutinyDelta: 2 });
    expect(seen.worstWordsInput.NBest[0].Words.map((w) => w.AccuracyScore)).toEqual([80, 68, 54]);
    expect(extractOverallPronScore(seen.overallInput)).toBe(68); // 72 → 68
    expect(result.meta.scrutinyDelta).toBe(2);
  });

  it("tagged (frontend-adjusted) input is used as-is — never double-applied", async () => {
    const tagged = adjustAzureResultForScrutiny(sampleAzure(), 2);
    const { result, seen } = await runWith({ azureResult: tagged, scrutinyDelta: 2 });
    expect(seen.worstWordsInput).toBe(tagged); // same reference, no re-clone
    expect(seen.worstWordsInput.NBest[0].Words.map((w) => w.AccuracyScore)).toEqual([80, 68, 54]);
    expect(result.meta.scrutinyDelta).toBe(2); // read from the tag
  });

  it("no delta anywhere → raw behavior, meta reports 0", async () => {
    const raw = sampleAzure();
    const { result, seen } = await runWith({ azureResult: raw });
    expect(seen.worstWordsInput).toBe(raw);
    expect(result.meta.scrutinyDelta).toBe(0);
  });
});

// ── Phase 4: rigor reaches the coach PROMPT (strictness matches the bar) ────
describe("scrutiny coach wiring: rigor directive in the prompt", () => {
  it("buildCoachPrompt (simple + detailed): stricter delta injects the SCRUTINY directive; 0 stays byte-identical", async () => {
    const { buildCoachPrompt } = await import("../routes/pronunciation-gpt/prompt.js");
    const base = {
      persona: "tutor",
      selectedPersona: { role: "You are a warm tutor.", style: "Encouraging" },
      DRILL_CASING_GUARDRAILS: "", DEEP_REASONING_MODEL: "", DEEP_REASONING_EFFORT: "",
      historySummary: null,
    };
    for (const mode of ["simple", "detailed"]) {
      const off = buildCoachPrompt({ ...base, mode, chunk: 1, tipIndex: 0, tipCount: 3, scrutinyDelta: 0 });
      const on = buildCoachPrompt({ ...base, mode, chunk: 1, tipIndex: 0, tipCount: 3, scrutinyDelta: 2 });
      expect(off.systemPrompt).not.toContain("SCRUTINY");
      expect(on.systemPrompt).toContain("SCRUTINY");
      expect(on.systemPrompt).toContain("2 notches STRICTER");
      expect(on.systemPrompt).toContain("4.4 points more demanding");
      expect(on.systemPrompt).toContain("ALREADY been adjusted");
      expect(on.systemPrompt).toContain("persona's own voice and tone");
      // delta 0 must be byte-identical to a prompt built before Phase 4
      const legacy = buildCoachPrompt({ ...base, mode, chunk: 1, tipIndex: 0, tipCount: 3 });
      expect(off.systemPrompt).toBe(legacy.systemPrompt);
    }
  });

  it("softer directive celebrates approximations; |delta| ≥ 3 escalates intensity", async () => {
    const { buildCoachPrompt } = await import("../routes/pronunciation-gpt/prompt.js");
    const base = {
      mode: "simple", chunk: 1, tipIndex: 0, tipCount: 3, persona: "tutor",
      selectedPersona: { role: "r", style: "s" },
      DRILL_CASING_GUARDRAILS: "", DEEP_REASONING_MODEL: "", DEEP_REASONING_EFFORT: "",
      historySummary: null,
    };
    const soft1 = buildCoachPrompt({ ...base, scrutinyDelta: -1 }).systemPrompt;
    expect(soft1).toContain("1 notch SOFTER");
    expect(soft1).toContain("celebrate close approximations");
    expect(soft1).toContain("genuinely block being understood");
    expect(soft1).not.toContain("maximally forgiving");

    const soft4 = buildCoachPrompt({ ...base, scrutinyDelta: -4 }).systemPrompt;
    expect(soft4).toContain("4 notches SOFTER");
    expect(soft4).toContain("maximally forgiving");

    const strict4 = buildCoachPrompt({ ...base, scrutinyDelta: 4 }).systemPrompt;
    expect(strict4).toContain("maximally exacting");
    expect(strict4).toContain("near-native precision");
  });

  it("end-to-end: tagged (+2) input → directive in system prompt, ADJUSTED overallScore + scrutiny block in user prompt", async () => {
    const { buildCoachPrompt } = await import("../routes/pronunciation-gpt/prompt.js");
    const tagged = adjustAzureResultForScrutiny(sampleAzure(), 2);
    const { sys, user } = await runWith({ azureResult: tagged, buildPrompt: buildCoachPrompt });

    expect(sys).toContain("SCRUTINY");
    expect(sys).toContain("2 notches STRICTER");
    // the coach judges ADJUSTED scores — raw 72 must not appear as the overall
    expect(user.overallScore).toBe(68);
    expect(user.overallTier).toBe("warn");
    expect(user.scrutiny).toEqual({ notches: 2, direction: "stricter", pointsShift: 4.4 });
  });

  it("end-to-end: untagged raw + scrutinyDelta −4 → softer directive + softer scrutiny block", async () => {
    const { buildCoachPrompt } = await import("../routes/pronunciation-gpt/prompt.js");
    const { sys, user } = await runWith({ azureResult: sampleAzure(), scrutinyDelta: -4, buildPrompt: buildCoachPrompt });

    expect(sys).toContain("4 notches SOFTER");
    expect(sys).toContain("maximally forgiving");
    expect(user.overallScore).toBe(81); // 72 + 8.8 → 80.8 → 81 (adjusted, softer)
    expect(user.overallTier).toBe("good");
    expect(user.scrutiny).toEqual({ notches: -4, direction: "softer", pointsShift: 8.8 });
  });

  it("end-to-end: delta 0 → no SCRUTINY directive, no scrutiny field (byte-identical behavior)", async () => {
    const { buildCoachPrompt } = await import("../routes/pronunciation-gpt/prompt.js");
    const { sys, user } = await runWith({ azureResult: sampleAzure(), buildPrompt: buildCoachPrompt });
    expect(sys).not.toContain("SCRUTINY");
    expect(user.scrutiny).toBeUndefined();
    expect(user.overallScore).toBe(72); // raw at zero rigor
  });
});

describe("scrutiny mirror: adjustAzureResultForScrutiny", () => {
  it("adjusts word/phoneme/overall scores; coach extraction sees the adjusted overall", () => {
    const adj = adjustAzureResultForScrutiny(sampleAzure(), 2);
    expect(adj.NBest[0].Words.map((w) => w.AccuracyScore)).toEqual([80, 68, 54]);
    expect(adj.NBest[0].Words[1].Phonemes[0].AccuracyScore).toBe(54);
    expect(extractOverallPronScore(adj)).toBe(68); // 72 → 68
  });

  it("leaves delivery metrics raw and never mutates the input", () => {
    const raw = sampleAzure();
    const before = JSON.stringify(raw);
    const adj = adjustAzureResultForScrutiny(raw, 2);
    expect(adj.NBest[0].FluencyScore).toBe(90);
    expect(adj.NBest[0].ProsodyScore).toBe(66);
    expect(JSON.stringify(raw)).toBe(before);
  });

  it("delta 0 → identity; tagged input is never double-applied", () => {
    const raw = sampleAzure();
    expect(adjustAzureResultForScrutiny(raw, 0)).toBe(raw);
    const adj = adjustAzureResultForScrutiny(raw, 2);
    expect(getScrutinyInfo(adj)).toEqual({ delta: 2, pointsPerNotch: 2.2 });
    expect(adjustAzureResultForScrutiny(adj, 2)).toBe(adj);
  });
});

// ── Congruency rule: CEFR band ALWAYS derives from the RAW score ─────────────
// Twin of the frontend rule (lux-frontend core/scoring): the band is a claim
// about the learner, not the session. overallScore/overallTier stay adjusted
// (the coach's judgment reacts to rigor); overallCefr never does.
describe("congruency mirror: CEFR band from raw", () => {
  it("adjustAzureResultForScrutiny records <Field>Raw siblings (twin of frontend)", () => {
    const adj = adjustAzureResultForScrutiny(sampleAzure(), 2);
    expect(adj.NBest[0].Words[0].AccuracyScore).toBe(80);
    expect(adj.NBest[0].Words[0].AccuracyScoreRaw).toBe(84);
    expect(adj.NBest[0].PronunciationAssessment.PronunciationScoreRaw).toBe(72);
    expect(adj.PronunciationAssessment.PronunciationScoreRaw).toBe(72);
  });

  it("extractOverallPronScoreRaw: Raw sibling on adjusted views, plain field on raw input", () => {
    const adj = adjustAzureResultForScrutiny(sampleAzure(), -4);
    expect(extractOverallPronScore(adj)).toBe(81);      // adjusted (72 + 8.8 → 81)
    expect(extractOverallPronScoreRaw(adj)).toBe(72);   // raw sibling
    expect(extractOverallPronScoreRaw(sampleAzure())).toBe(72); // raw input → itself
    expect(extractOverallPronScoreRaw({})).toBeNull();
  });

  it("runCoach: overallCefr comes from RAW while overallScore/overallTier stay adjusted (−4 splits the bands)", async () => {
    const { buildCoachPrompt } = await import("../routes/pronunciation-gpt/prompt.js");
    const { user } = await runWith({ azureResult: sampleAzure(), scrutinyDelta: -4, buildPrompt: buildCoachPrompt });
    expect(user.overallScore).toBe(81);            // adjusted → would band B1
    expect(user.overallTier).toBe("good");         // adjusted tier (colors react)
    expect(user.overallCefr).toBe("A2");           // band of RAW 72 — never moves
    expect(cefrBandFromScore(user.overallScore)).toBe("B1"); // proves the split is real
  });

  it("runCoach: tagged frontend input also bands from its Raw siblings", async () => {
    const { buildCoachPrompt } = await import("../routes/pronunciation-gpt/prompt.js");
    const tagged = adjustAzureResultForScrutiny(sampleAzure(), -4);
    const { user } = await runWith({ azureResult: tagged, buildPrompt: buildCoachPrompt });
    expect(user.overallScore).toBe(81);
    expect(user.overallCefr).toBe("A2");
  });

  it("runCoach: delta 0 → band from the plain raw field, byte-identical behavior", async () => {
    const { buildCoachPrompt } = await import("../routes/pronunciation-gpt/prompt.js");
    const { user } = await runWith({ azureResult: sampleAzure(), buildPrompt: buildCoachPrompt });
    expect(user.overallScore).toBe(72);
    expect(user.overallCefr).toBe("A2");
  });
});
