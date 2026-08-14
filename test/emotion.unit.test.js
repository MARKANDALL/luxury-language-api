// test/emotion.unit.test.js
// Emotion driver stage 1 — unit contract for the parse-time validator.
// The promise this file defends: `normalizeEmotion` NEVER returns anything but
// an allowed name at a legal strength, and neutral NEVER carries a level. Every
// route caller can therefore hand the result straight to the wire.
import { describe, it, expect } from "vitest";
import {
  EMOTION_NAMES,
  EMOTION_OUTPUT_SCHEMA,
  EMOTION_BLOCK,
  normalizeEmotion,
  neutralEmotion,
} from "../lib/emotion.js";

const NEUTRAL = { name: "neutral", level: null };

describe("EMOTION_NAMES vocabulary", () => {
  it("is exactly the 13 ratified names, in ratified order", () => {
    expect(EMOTION_NAMES).toEqual([
      "neutral", "friendly", "delighted", "attentive", "curious", "surprised",
      "confused", "concerned", "playful", "impatient", "cold", "angry", "emotional",
    ]);
  });

  it("the prompt block and the OUTPUT schema are generated from that one list", () => {
    for (const name of EMOTION_NAMES) {
      expect(EMOTION_BLOCK).toContain(name);
      expect(EMOTION_OUTPUT_SCHEMA).toContain(name);
    }
    // Drift guard: the schema line enumerates the vocabulary, nothing more.
    expect(EMOTION_OUTPUT_SCHEMA).toBe(
      `"emotion":{"name":"${EMOTION_NAMES.join("|")}","level":1|2|3|null}`
    );
  });
});

describe("normalizeEmotion — valid signals", () => {
  it("accepts every non-neutral name at every legal level", () => {
    for (const name of EMOTION_NAMES.filter(n => n !== "neutral")) {
      for (const level of [1, 2, 3]) {
        expect(normalizeEmotion({ name, level })).toEqual({ name, level });
      }
    }
  });

  it("accepts a numeric-string level (models emit these)", () => {
    expect(normalizeEmotion({ name: "curious", level: "2" })).toEqual({ name: "curious", level: 2 });
  });

  it("normalizes case and surrounding whitespace on the name", () => {
    expect(normalizeEmotion({ name: "  Concerned ", level: 3 })).toEqual({ name: "concerned", level: 3 });
    expect(normalizeEmotion({ name: "ANGRY", level: 1 })).toEqual({ name: "angry", level: 1 });
  });

  it("ignores extra keys the model volunteers", () => {
    expect(normalizeEmotion({ name: "playful", level: 2, reason: "she teased him" }))
      .toEqual({ name: "playful", level: 2 });
  });
});

describe("normalizeEmotion — neutral carries no level", () => {
  it("neutral with null level stays neutral", () => {
    expect(normalizeEmotion({ name: "neutral", level: null })).toEqual(NEUTRAL);
  });

  it("neutral with a level has the level stripped, not the name rejected", () => {
    expect(normalizeEmotion({ name: "neutral", level: 2 })).toEqual(NEUTRAL);
    expect(normalizeEmotion({ name: "neutral", level: 3 })).toEqual(NEUTRAL);
  });
});

describe("normalizeEmotion — unknown names collapse to neutral", () => {
  it.each([
    ["warm",       "plausible synonym outside the set"],
    ["happy",      "everyday word outside the set"],
    ["excited",    "tone-table word that is not an emotion name"],
    ["Neutral!",   "punctuation makes it unmatchable"],
    ["curiosity",  "near-miss inflection"],
    ["",           "empty string"],
  ])("%s -> neutral (%s)", (name) => {
    expect(normalizeEmotion({ name, level: 2 })).toEqual(NEUTRAL);
  });
});

describe("normalizeEmotion — bad levels collapse to neutral", () => {
  it.each([
    [0], [4], [-1], [2.5], ["high"], [true], [null], [undefined], [NaN], [Infinity], [[2]],
  ])("level %p on a valid name -> neutral", (level) => {
    expect(normalizeEmotion({ name: "surprised", level })).toEqual(NEUTRAL);
  });

  it("a valid name with the level key missing entirely -> neutral", () => {
    expect(normalizeEmotion({ name: "concerned" })).toEqual(NEUTRAL);
  });
});

describe("normalizeEmotion — missing or malformed field", () => {
  it.each([
    [undefined], [null], ["curious"], [42], [true], [[]], [[{ name: "curious", level: 2 }]], [{}],
  ])("%p -> neutral", (raw) => {
    expect(normalizeEmotion(raw)).toEqual(NEUTRAL);
  });
});

describe("neutralEmotion factory", () => {
  it("returns a fresh object each call so callers cannot bleed into each other", () => {
    const a = neutralEmotion();
    const b = neutralEmotion();
    expect(a).toEqual(NEUTRAL);
    expect(a).not.toBe(b);
    a.name = "angry";
    expect(b).toEqual(NEUTRAL);
  });

  it("normalizeEmotion likewise returns fresh objects", () => {
    const a = normalizeEmotion(null);
    const b = normalizeEmotion(null);
    expect(a).not.toBe(b);
  });
});
