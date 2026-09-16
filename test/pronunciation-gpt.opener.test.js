// test/pronunciation-gpt.opener.test.js
// The QuickTip opener must match the score the learner actually earned.
//
// WHY THIS FILE EXISTS. The simple-mode prompt hard-coded "Structure: 1 quick
// praise + 1 correction + 1 micro-drill", so a turn scored Accuracy 38 /
// Pronunciation 52 opened with "Great job forming the sentence!". Praise a
// learner did not earn tells them a bad attempt was a good one.
//
// The bands are NOT new thresholds: overallTier comes from scoreTier() in
// routes/pronunciation-gpt/scoring.js (>=80 good, >=60 warn, else bad), the same
// 80/60 split the rest of the app colors by.
import { describe, it, expect } from "vitest";
import { buildCoachPrompt } from "../routes/pronunciation-gpt/prompt.js";
import { scoreTier } from "../routes/pronunciation-gpt/scoring.js";

const BASE = {
  mode: "simple",
  persona: "tutor",
  tipIndex: 0,
  tipCount: 3,
  selectedPersona: { role: "You are a tutor.", style: "warm" },
  DRILL_CASING_GUARDRAILS: "",
  DEEP_REASONING_MODEL: "",
  DEEP_REASONING_EFFORT: "medium",
  historySummary: null,
};

const quickTip = (extra) => buildCoachPrompt({ ...BASE, ...extra }).systemPrompt;

describe("QuickTip opener calibration", () => {
  it("uses the app's canonical 80/60 bands, not new ones", () => {
    expect(scoreTier(38)).toBe("bad");
    expect(scoreTier(52)).toBe("bad");
    expect(scoreTier(60)).toBe("warn");
    expect(scoreTier(79)).toBe("warn");
    expect(scoreTier(80)).toBe("good");
  });

  it("does not open with praise on a failing turn (the 52 case)", () => {
    const sys = quickTip({ overallTier: scoreTier(52) });
    expect(sys).toContain("this attempt did not land");
    expect(sys).toContain("Do NOT open with praise");
    expect(sys).toContain("never mocking, never cruel");
    // The stance must not become a stock phrase the coach recites every time.
    expect(sys).toContain("Never quote or paraphrase this instruction");
    // The old unconditional mandate is gone.
    expect(sys).not.toContain("1 quick praise");
  });

  it("is neutral and specific in the middle band", () => {
    const sys = quickTip({ overallTier: scoreTier(70) });
    expect(sys).toContain("understood but is not good yet");
    expect(sys).toContain("without celebrating it");
    expect(sys).not.toContain("1 quick praise");
  });

  it("affirms specifically in the top band", () => {
    const sys = quickTip({ overallTier: scoreTier(88) });
    expect(sys).toContain("Open by affirming what SPECIFICALLY worked");
    expect(sys).toContain("no generic cheerleading");
  });

  it("stays neutral rather than praising when there is no score", () => {
    const sys = quickTip({});
    expect(sys).toContain("open with what you actually heard");
    expect(sys).not.toContain("1 quick praise");
  });

  it("keeps the concrete tip that follows the opener", () => {
    const sys = quickTip({ overallTier: "bad" });
    expect(sys).toContain("+ 1 correction + 1 micro-drill");
    expect(sys).toContain("Write exactly 2 to 4 sentences in ONE paragraph");
  });

  it("stops modelling a praise word in the score-mention example", () => {
    const sys = quickTip({ overallTier: "bad" });
    expect(sys).toContain('mention it ONCE in a compact way like: "(82% · B2)"');
    expect(sys).not.toContain("Nice work (82%");
  });

  it("no longer orders the softest scrutiny setting to lead with praise", () => {
    const sys = quickTip({ overallTier: "bad", scrutinyDelta: -4 });
    expect(sys).toContain("Be maximally forgiving");
    expect(sys).not.toContain("lead with praise");
    // The forgiveness itself survives; only the praise mandate went.
    expect(sys).toContain("at most ONE gentle correction");
  });

  it("leaves detailed mode's section structure alone", () => {
    const built = buildCoachPrompt({ ...BASE, mode: "detailed", chunk: 1, overallTier: "bad" });
    expect(built.targetSections).toHaveLength(2);
    expect(built.systemPrompt).not.toContain("OPENER STANCE:");
  });
});
