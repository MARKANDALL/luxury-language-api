// test/coach-page.context.test.js
// Unit tests for THE CONTEXT DIET (routes/coach-page/context.js): which keys a
// lane is allowed to eat, and the bounding that keeps a 26-scenario catalog from
// eating the context window. No network, no env, no HTTP — the wiring is proved
// in test/coach-page.contract.test.js.
import { describe, it, expect } from "vitest";
import {
  CONTEXT_SLICES,
  LANE_DIET,
  LEARNER_HISTORY_KEYS,
  PAGE_STATE_KEYS,
  SHRINK_LADDER,
  laneWantsKnowledge,
  selectContext,
  shapeValue,
} from "../routes/coach-page/context.js";
import { LANES } from "../routes/coach-page/router.js";

// The four rows that ship today, with the keys their builders actually send.
const practiceSkillsContext = () => ({
  referenceText: "The birch canoe slid on the smooth planks.",
  partIndex: 0,
  partCount: 3,
  passageKey: "harvard:1",
  firstLang: "es",
  azureResultLatest: {
    said: "The birch canoe slid on the smooth planks.",
    pron: 78,
    accuracy: 81,
    fluency: 74,
    completeness: 100,
    worstWords: [{ word: "birch", score: 52, errorType: "Mispronunciation" }],
    worstPhonemes: [{ ipa: "ɜr", score: 41, word: "birch" }],
  },
});

const allDataContext = () => ({
  historyAggregates: {
    totals: { attempts: 214, sessions: 31, avgScore: 82.4 },
    arc: { recentAvg: 84.1, priorAvg: 79.2, delta: 4.9, direction: "up" },
    stubborn: [
      { ipa: "ɜr", avg: 61.2, recentAvg: 58.0, count: 44 },
      { ipa: "θ", avg: 66.9, recentAvg: 70.1, count: 31 },
    ],
    improving: [{ ipa: "v", recentAvg: 88.0, priorAvg: 79.5, delta: 8.5 }],
  },
  learnerModelFull: { totals: { sessions: 31, events: 402 }, categories: [{ code: "art", n: 12 }] },
  streaks: { current: 4, longest: 11, activeDays: 22, windowDays: 30 },
  perTypeAccumulatives: {
    practice: { attempts: 180, avgScore: 83.1, daysSince: 0 },
    conversation: { attempts: 34, avgScore: 78.0, daysSince: 19 },
  },
});

const guidedChatContext = () => ({
  lastThreeTurns: [
    { role: "assistant", text: "No manches, ¿en serio?" },
    { role: "user", text: "Sí, de verdad." },
  ],
  characterCard: { label: "Daniela", npc: "A patient store employee in her 20s." },
  scenario: { id: "phone-repair", title: "At the Phone Store", desc: "Your screen is cracked." },
  knobValues: "B1 · friendly · medium",
  earResultLatest: { heard: "de verdad", flagged: false },
});

// The picker's charter slice, at the size the row will actually ship it.
const scenarioCatalog = (n = 26) =>
  Array.from({ length: n }, (_, i) => ({
    id: `scenario-${i}`,
    title: `Scenario ${i}`,
    desc: `A situation the learner can practice, number ${i}.`,
  }));

describe("context diet — the charter's slices are transcribed, not guessed", () => {
  it("covers every row that ships a contextSlice today", () => {
    for (const key of ["practiceSkills", "picker", "guidedChat", "allData"]) {
      expect(CONTEXT_SLICES[key].length).toBeGreaterThan(0);
    }
  });

  it("routes every charter key into exactly one of the two families", () => {
    const known = new Set([...PAGE_STATE_KEYS, ...LEARNER_HISTORY_KEYS]);
    for (const [row, keys] of Object.entries(CONTEXT_SLICES)) {
      for (const key of keys) {
        // bibleGlobal is the knowledge doc's job, not the context slice's.
        if (key === "bibleGlobal") continue;
        expect(known.has(key), `${row}.${key} is not in any lane's diet`).toBe(true);
      }
    }
  });

  it("declares a diet for every lane the router can return except OFF_SCOPE", () => {
    for (const lane of LANES) {
      if (lane === "OFF_SCOPE") continue; // short-circuits before the main call
      expect(LANE_DIET[lane], `no diet for ${lane}`).toBeTruthy();
    }
  });
});

describe("context diet — the lane chooses what reaches the expensive model", () => {
  it("PATTERNS gets the aggregates and the learner model", () => {
    const { context, stats } = selectContext({ lane: "PATTERNS", context: allDataContext() });
    expect(Object.keys(context)).toEqual([
      "historyAggregates",
      "learnerModelFull",
      "streaks",
      "perTypeAccumulatives",
    ]);
    expect(context.historyAggregates.stubborn[0].ipa).toBe("ɜr");
    expect(stats.present).toBe(true);
    expect(stats.dropped).toEqual([]);
  });

  it("PATTERNS does NOT get the passage in the box", () => {
    const { context, stats } = selectContext({
      lane: "PATTERNS",
      context: { ...allDataContext(), ...practiceSkillsContext() },
    });
    expect(context).not.toHaveProperty("referenceText");
    expect(context).not.toHaveProperty("azureResultLatest");
    expect(context).toHaveProperty("historyAggregates");
    expect(stats.skipped).toBeGreaterThan(0); // off-diet keys are counted, not smuggled
  });

  it("EXPLAIN gets the immediate page state — the passage and the take", () => {
    const { context } = selectContext({ lane: "EXPLAIN", context: practiceSkillsContext() });
    expect(context.referenceText).toContain("birch canoe");
    expect(context.azureResultLatest.worstPhonemes[0].ipa).toBe("ɜr");
    expect(context.partIndex).toBe(0);
  });

  it("EXPLAIN gets the scene the guided-chat coach can see", () => {
    const { context } = selectContext({ lane: "EXPLAIN", context: guidedChatContext() });
    expect(context.lastThreeTurns).toHaveLength(2);
    expect(context.characterCard.label).toBe("Daniela");
    expect(context.scenario.title).toBe("At the Phone Store");
  });

  it("EXPLAIN gets the picker's catalog, so two scenarios can be compared", () => {
    const { context } = selectContext({
      lane: "EXPLAIN",
      context: { scenarioCatalog: scenarioCatalog(4), knobValues: "B1 · friendly" },
    });
    expect(context.scenarioCatalog).toHaveLength(4);
    expect(context.knobValues).toBe("B1 · friendly");
  });

  it("EXPLAIN does NOT get last month's history", () => {
    const { context } = selectContext({
      lane: "EXPLAIN",
      context: { ...practiceSkillsContext(), ...allDataContext() },
    });
    expect(context).not.toHaveProperty("historyAggregates");
    expect(context).not.toHaveProperty("learnerModelFull");
  });

  it("NAV_HELP and CREATOR_INFO take the knowledge doc instead of any page state", () => {
    for (const lane of ["NAV_HELP", "CREATOR_INFO"]) {
      const { context, stats } = selectContext({ lane, context: allDataContext() });
      expect(context).toBeNull();
      expect(stats.present).toBe(true); // the page DID send one; we chose not to read it
      expect(stats.skipped).toBe(4);
      expect(laneWantsKnowledge(lane)).toBe(true);
    }
  });

  it("LANGUAGE_GENERAL gets the learner profile only — no context, no doc", () => {
    const { context } = selectContext({ lane: "LANGUAGE_GENERAL", context: allDataContext() });
    expect(context).toBeNull();
    expect(laneWantsKnowledge("LANGUAGE_GENERAL")).toBe(false);
  });

  it("ROUTE_TO_PAGE gets page state, on a tighter budget than EXPLAIN", () => {
    const { context } = selectContext({ lane: "ROUTE_TO_PAGE", context: practiceSkillsContext() });
    expect(context.referenceText).toContain("birch canoe");
    expect(LANE_DIET.ROUTE_TO_PAGE.maxChars).toBeLessThan(LANE_DIET.EXPLAIN.maxChars);
  });

  it("an unknown lane eats the default diet: nothing", () => {
    const { context } = selectContext({ lane: "VIBES", context: allDataContext() });
    expect(context).toBeNull();
    expect(laneWantsKnowledge("VIBES")).toBe(false);
  });

  it("emits keys in the diet's priority order, not the payload's", () => {
    const scrambled = {
      perTypeAccumulatives: { practice: { attempts: 1 } },
      streaks: { current: 1 },
      historyAggregates: { totals: { attempts: 1 } },
    };
    const { context } = selectContext({ lane: "PATTERNS", context: scrambled });
    expect(Object.keys(context)).toEqual(["historyAggregates", "streaks", "perTypeAccumulatives"]);
  });
});

describe("context diet — an absent or unusable context", () => {
  it("reports absence rather than inventing an empty object", () => {
    for (const context of [undefined, null, {}, [], "nope", 7]) {
      const picked = selectContext({ lane: "PATTERNS", context });
      expect(picked.context).toBeNull();
      expect(picked.note).toBe("");
      expect(picked.stats.present).toBe(false);
    }
  });

  it("sends nothing when the page's keys are all off this lane's diet", () => {
    const picked = selectContext({ lane: "PATTERNS", context: practiceSkillsContext() });
    expect(picked.context).toBeNull();
    expect(picked.stats.present).toBe(true);
    expect(picked.stats.kept).toEqual([]);
  });
});

describe("context diet — bounding", () => {
  it("caps the picker's 26-scenario catalog and says so", () => {
    const { context, note, stats } = selectContext({
      lane: "EXPLAIN",
      context: { scenarioCatalog: scenarioCatalog(26) },
    });
    expect(context.scenarioCatalog.length).toBeLessThanOrEqual(SHRINK_LADDER[0].maxItems);
    expect(note).toContain("scenarioCatalog: showing");
    expect(note).toContain("of 26");
    expect(stats.truncated).toBe(true);
  });

  it("never exceeds the lane's budget, however big the payload", () => {
    for (const lane of ["EXPLAIN", "PATTERNS", "ROUTE_TO_PAGE"]) {
      const { context } = selectContext({
        lane,
        context: {
          scenarioCatalog: scenarioCatalog(500),
          referenceText: "x".repeat(50000),
          lastThreeTurns: Array.from({ length: 400 }, (_, i) => ({ role: "user", text: `t${i}` })),
          historyAggregates: { stubborn: scenarioCatalog(500), totals: { attempts: 9 } },
          learnerModelFull: { categories: scenarioCatalog(500) },
          streaks: { current: 3 },
          perTypeAccumulatives: { practice: { attempts: 1 } },
          savedItems: scenarioCatalog(500),
        },
      });
      const size = JSON.stringify(context || {}).length;
      expect(size, `${lane} blew its budget at ${size}`).toBeLessThanOrEqual(
        LANE_DIET[lane].maxChars
      );
    }
  });

  it("clips a long string instead of dropping the key", () => {
    const { context, note } = selectContext({
      lane: "EXPLAIN",
      context: { referenceText: "word ".repeat(500) },
    });
    expect(context.referenceText.length).toBeLessThanOrEqual(SHRINK_LADDER[0].maxStringChars + 1);
    expect(context.referenceText.endsWith("…")).toBe(true);
    expect(note).toContain("referenceText: text shortened");
  });

  it("drops the keys that no longer fit, names them, and keeps the rest whole", () => {
    // Every key here is fat enough that the tightest rung still costs real bytes,
    // so the small ROUTE_TO_PAGE budget must run out partway down the diet.
    const fat = (n) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`field${i}`, "y".repeat(600)]));
    const { context, note, stats } = selectContext({
      lane: "ROUTE_TO_PAGE",
      context: {
        referenceText: "the passage on screen",
        azureResultLatest: fat(20),
        lastThreeTurns: [fat(20), fat(20), fat(20)],
        characterCard: fat(20),
        scenario: fat(20),
        knobValues: "B1 · friendly · medium",
      },
    });

    expect(context.referenceText).toBe("the passage on screen"); // first in, kept whole
    expect(stats.dropped.length).toBeGreaterThan(0);
    expect(note).toContain("omitted (too large)");
    for (const key of stats.dropped) expect(context).not.toHaveProperty(key);
    expect(JSON.stringify(context).length).toBeLessThanOrEqual(LANE_DIET.ROUTE_TO_PAGE.maxChars);
  });

  it("spends the budget front to back, so the tail is what goes", () => {
    // referenceText comes first in PAGE_STATE_KEYS; savedItems comes near the end.
    const { stats } = selectContext({
      lane: "ROUTE_TO_PAGE",
      context: {
        savedItems: scenarioCatalog(200),
        referenceText: "the passage on screen",
      },
    });
    expect(stats.kept[0]).toBe("referenceText");
  });

  it("is deterministic — same input, same bytes", () => {
    const build = () => ({ scenarioCatalog: scenarioCatalog(40), referenceText: "z".repeat(900) });
    const a = selectContext({ lane: "EXPLAIN", context: build() });
    const b = selectContext({ lane: "EXPLAIN", context: build() });
    expect(JSON.stringify(a.context)).toBe(JSON.stringify(b.context));
    expect(a.note).toBe(b.note);
  });

  it("keeps nulls — 'not enough history to say' is not zero", () => {
    const { context } = selectContext({
      lane: "PATTERNS",
      context: { historyAggregates: { arc: { delta: null, direction: "unknown" } } },
    });
    expect(context.historyAggregates.arc.delta).toBeNull();
  });

  it("collapses nesting past the depth cap rather than walking forever", () => {
    let deep = { leaf: "bottom" };
    for (let i = 0; i < 12; i++) deep = { nest: deep };
    const { context } = selectContext({ lane: "PATTERNS", context: { learnerModelFull: deep } });
    expect(JSON.stringify(context)).toContain("…");
  });
});

describe("context diet — shapeValue", () => {
  const rung = SHRINK_LADDER[0];

  it("passes small scalars through untouched", () => {
    expect(shapeValue("hi", rung)).toBe("hi");
    expect(shapeValue(42, rung)).toBe(42);
    expect(shapeValue(false, rung)).toBe(false);
    expect(shapeValue(null, rung)).toBeNull();
  });

  it("nulls a non-finite number rather than serializing NaN", () => {
    expect(shapeValue(Number.NaN, rung)).toBeNull();
    expect(shapeValue(Infinity, rung)).toBeNull();
  });

  it("cuts arrays from the front and records the cut", () => {
    const cuts = [];
    const out = shapeValue([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], rung, 0, "list", cuts);
    expect(out).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(cuts).toContain("list: showing 8 of 10");
  });

  it("caps how many fields one object can carry", () => {
    const wide = {};
    for (let i = 0; i < 60; i++) wide[`k${i}`] = i;
    const cuts = [];
    const out = shapeValue(wide, rung, 0, "wide", cuts);
    expect(Object.keys(out)).toHaveLength(rung.maxKeys);
    expect(cuts).toContain(`wide: showing ${rung.maxKeys} of 60 fields`);
  });

  it("shrinks strictly at every rung of the ladder", () => {
    for (let i = 1; i < SHRINK_LADDER.length; i++) {
      const prev = SHRINK_LADDER[i - 1];
      const next = SHRINK_LADDER[i];
      expect(next.maxItems).toBeLessThan(prev.maxItems);
      expect(next.maxStringChars).toBeLessThan(prev.maxStringChars);
      expect(next.maxKeys).toBeLessThan(prev.maxKeys);
      expect(next.maxDepth).toBeLessThanOrEqual(prev.maxDepth);
    }
  });
});
