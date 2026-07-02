// features/convo/ear/mouth.js
// The Mouth — ratified 2026-06-12 ("full blessings").
// Buckets are INTENTS with constraints and register seeds, never line banks.
// The Ear picks the bucket deterministically; the character model renders
// the surface form in voice. Seeds are few-shots; verbatim reuse forbidden.

export const REPAIR_BUCKETS = {
  R1: {
    id: "R1",
    name: "open",
    burden: 3,
    intent: "Full-utterance repair. Get a clean second take without locating fault.",
    constraints: [
      "Blame the environment, never the learner.",
      "Max once per session. Never twice consecutively.",
      "Slower on your next line, never louder.",
    ],
    seeds: {
      friendly: ["Sorry, what was that? It gets loud back here.", "Ah, say that one more time for me?"],
      neutral: ["Sorry, what was that?", "One more time? Machine's going."],
      busy: ["Sorry, missed that.", "Say again real quick?"],
    },
  },
  R2: {
    id: "R2",
    name: "partial-echo-gap",
    burden: 1,
    intent: "Echo what landed, leave the missed slot open. Learner re-produces one word, not a sentence.",
    constraints: [
      "Echo only words you are confident of.",
      "The gap is casual, never a quiz.",
    ],
    seeds: {
      friendly: ["A medium... what, sorry?", "One of the... say the drink again?"],
      neutral: ["A... what was the drink?", "Medium what, sorry?"],
      busy: ["A medium... which one?", "The... what?"],
    },
  },
  R3: {
    id: "R3",
    name: "candidate-offer",
    burden: 1,
    intent: "Offer a category or a guess. Converts recall into recognition.",
    constraints: [
      "The candidate must be wrong-tolerant: a 'no' costs nothing.",
      "Offer a category before a specific item when possible.",
    ],
    seeds: {
      friendly: ["Is it one of the espresso ones, like a latte?", "Something iced, or hot?"],
      neutral: ["One of the coffees, or a tea?", "Like a latte?"],
      busy: ["Espresso drink?", "Hot or iced?"],
    },
  },
  R4: {
    id: "R4",
    name: "slow-confirm",
    burden: 2,
    intent: "Ask for one more pass while your own speech slows. The never-louder law made flesh.",
    constraints: [
      "Pair with a slowed render of your next line.",
      "Warmth up, volume flat.",
    ],
    seeds: {
      friendly: ["One more time for me? No rush at all.", "Run that by me again, take your time."],
      neutral: ["One more time for me?", "Once more, no rush."],
      busy: ["One more time, sorry.", "Again for me?"],
    },
  },
  R5: {
    id: "R5",
    name: "environment-assist",
    burden: 0,
    intent: "The room joins the conversation: menu, cups, the case. Production burden near zero.",
    constraints: [
      "Only when a physical referent genuinely exists in the scene's furniture.",
      "Gesture plus short question, not a tour.",
    ],
    seeds: {
      friendly: ["Which one are we thinking?", "This size, or this one?"],
      neutral: ["Which one?", "This one or this one?"],
      busy: ["Point me at it?", "This or this?"],
    },
  },
  R6: {
    id: "R6",
    name: "generated-individualized",
    burden: 1,
    intent:
      "Escalation terminus at recurrence three. A response that could only happen in THIS conversation, assembled from the learner's own words, the prior repair attempts, and the scene. Resolving it should land the correct model once, as conversation, not correction.",
    constraints: [
      "Never seeded. Use the failure history and context anchors in the directive.",
      "If you resolve the meaning, name the thing naturally so the correct form is heard.",
      "Relief, not triumph. No teaching energy.",
    ],
    seeds: null,
  },
};

export const CHECK_COSTUMES = {
  C1: {
    id: "C1",
    name: "binary-exposure",
    free: false,
    intent: "Expose the interpretation as a falsifiable either/or the character can speak naturally.",
    constraints: ["Both candidates must be speakable in-scene without absurdity."],
    seeds: {
      friendly: ["Is that with a V, or a B? I wanna get it right.", "Sorry — nonfat, or the two percent?"],
      neutral: ["With a V or a B?", "Nonfat or low-fat?"],
      busy: ["V or B?", "Nonfat or two percent?"],
    },
  },
  C2: {
    id: "C2",
    name: "environment-binary",
    free: false,
    intent: "Run the either/or through objects. Zero production burden, zero spotlight.",
    constraints: ["Requires physical referents in the scene."],
    seeds: {
      friendly: ["For sure — which size, this one or this one?"],
      neutral: ["Which size — this or this?"],
      busy: ["This size or this?"],
    },
  },
  C3: {
    id: "C3",
    name: "free-spell",
    free: true,
    intent: "Names and read-backs: socially costless confirmation. Baristas ask everyone. Costs no budget; quietly the best data harvester in the set.",
    constraints: ["Spelling questions only for slots where real staff genuinely ask."],
    seeds: {
      friendly: ["Is that T-A-O, or with an H?", "Vero — V or B on the cup?"],
      neutral: ["Spell that for me?", "With a V?"],
      busy: ["Spelling?", "V or B?"],
    },
  },
};

export const ECHO_WEAVES = {
  E1: {
    id: "E1",
    name: "woven-confirm",
    intent: "Fold the heard value into forward motion. The sting-proof workhorse.",
    seeds: {
      friendly: ["One medium oat latte, coming up."],
      neutral: ["Medium oat latte, sure."],
      busy: ["Medium oat latte."],
    },
  },
  E2: {
    id: "E2",
    name: "read-back",
    intent:
      "Full-ledger recital at order close. Free-check class. The canonical tripwire where a MISHEAR is caught.",
    seeds: {
      friendly: ["Okay: medium nonfat latte, light foam, and a walnut scone."],
      neutral: ["So that's a medium nonfat latte, light foam, walnut scone."],
      busy: ["Medium nonfat latte, light foam, walnut scone — yeah?"],
    },
  },
};

export const MISHEAR_MOVES = {
  M1: {
    id: "M1",
    name: "act-line",
    intent:
      "Confident normalcy, value-silent. You believe what you heard; do not surface or confirm the value this turn. The read-back owns the reveal.",
    seeds: { friendly: ["You got it."], neutral: ["Sure thing."], busy: ["Got it."] },
  },
  M2: {
    id: "M2",
    name: "amend",
    intent: "One turn. Own it, fix it, move on. No dwelling, no doubling down.",
    seeds: {
      friendly: ["Ah, no foam at all — my bad. Fixed."],
      neutral: ["No foam at all, got it. Fixed."],
      busy: ["Zero foam. Fixed."],
    },
  },
  M3: {
    id: "M3",
    name: "social-repair",
    intent:
      "Conditional: only if the learner apologizes or flusters. Normalize, deflect to process, never reference their English unprompted.",
    seeds: {
      friendly: ["You're totally good — that's what the read-back's for."],
      neutral: ["All good, that's why I read it back."],
      busy: ["You're fine."],
    },
  },
};

/* ── Global laws (constitution layer) — enforced by Ear + renderer ── */
export const MOUTH_LAWS = [
  "Never louder; slower and paraphrase instead.",
  "Blame the room, never the learner.",
  "No teacher energy. No meta-language about pronunciation mid-scene, ever.",
  "No REPAIR bucket repeats within a session; recurrence three lands on R6.",
  "No verbatim line reuse within a session (lines_rendered log).",
  "Render through persona and register; seeds are few-shots, never scripts.",
  "Uncaught mishear: if the read-back sails by, the wrap-up owns the reveal as the session headline.",
];

/** Deterministic REPAIR bucket pick per ratified ladder policy. */
export function pickRepairBucket({ used = [], recurrence = 1, referents = false }) {
  if (recurrence >= 3) return "R6";
  // Canon order (HG-2): recognition-over-recall is always the second move,
  // even with referents in the scene; the room joins the ladder after.
  const ladder = referents ? ["R1", "R3", "R5", "R4", "R2"] : ["R1", "R3", "R4", "R2"];
  for (const id of ladder) if (!used.includes(id)) return id;
  return "R6";
}

/* ── Prompt renderer: hearing directive → block for the character model ──
   Injected into convo-turn postHistory as a system message. The character
   never sees scores or jargon; it receives a situation it can inhabit.   */
export function renderHearingBlock(d, { register = "neutral" } = {}) {
  if (!d || !d.action || d.action === "SLIDE") return null;
  const lines = ["HEARING (private stage direction — never mention this):"];
  const tgt = d.target ? `"${d.target.word}"` : "their last line";

  switch (d.action) {
    case "ECHO":
      lines.push(
        `You understood the learner, though ${tgt} came out unclear.`,
        `Fold the correct form of ${tgt} naturally into your reply (style: ${seedHint(ECHO_WEAVES.E1, register)}).`,
        `Do not comment on their speech in any way.`
      );
      break;
    case "CHECK": {
      const c = CHECK_COSTUMES[d.costume] || CHECK_COSTUMES.C1;
      lines.push(
        `You are not certain you caught ${tgt}${d.neighbor ? ` — it may have been "${d.neighbor.word}"` : ""}.`,
        `Confirm it the way real staff do — ${c.intent}`,
        `Style hint (do not copy verbatim): ${seedHint(c, register)}`,
        ...c.constraints
      );
      break;
    }
    case "REPAIR": {
      const b = REPAIR_BUCKETS[d.bucket] || REPAIR_BUCKETS.R1;
      if (d.omission) {
        const SLOT_LABELS = { size: "the size", drink: "the drink", milk: "the milk", foam: "the foam", food: "the food item" };
        const label = SLOT_LABELS[d.omission.slot] || "that part";
        if (d.bucket === "R1") {
          lines.push(
            `You did not catch what they said at all. Ask them to say it again.`,
            `Blame the environment, never the learner.`,
            `Do not guess anything. Do not repeat any part of their message.`,
            ...(b.seeds ? [`Style hint (do not copy verbatim): ${seedHint(b, register)}`] : []),
          );
        } else {
          lines.push(
            `Most of their line reached you, but you did NOT hear ${label}.`,
            `Their message as written may look complete. It is not, to your ears. The ${label.replace(/^the /, "")} never arrived.`,
            `Do not guess it. Do not repeat it. Do not confirm it. You do not know it.`,
            `This instruction outranks the message text.`,
            `Ask for just that part, naturally. ${b.intent}`,
            `Never mention pronunciation or hearing problems on their side; if anything, blame the room.`,
            ...(b.seeds ? [`Style hint (do not copy verbatim): ${seedHint(b, register)}`] : []),
            ...b.constraints,
          );
        }
      } else {
        lines.push(
          `You genuinely did not catch ${tgt}. ${b.intent}`,
          ...(b.seeds ? [`Style hint (do not copy verbatim): ${seedHint(b, register)}`] : []),
          ...b.constraints
        );
        if (d.bucket === "R6" && d.repairHistory) {
          lines.push(
            `This is the third attempt. Their earlier tries: ${d.repairHistory.join(" / ")}.`,
            `Use what THEY said plus the scene to resolve it. ${REPAIR_BUCKETS.R6.constraints[1]}`
          );
        }
      }
      break;
    }
    case "MISHEAR":
      lines.push(
        `You heard "${d.neighbor.word}" — to you that is simply what was said.`,
        MISHEAR_MOVES.M1.intent,
        `Proceed naturally (style: ${seedHint(MISHEAR_MOVES.M1, register)}).`
      );
      break;
    case "AMEND":
      lines.push(
        `You had "${d.wrongValue}" down; the learner just corrected it to "${d.rightValue}".`,
        MISHEAR_MOVES.M2.intent,
        `If they apologize or seem embarrassed: ${MISHEAR_MOVES.M3.intent}`
      );
      break;
    default:
      return null;
  }
  if (d.linesRendered && d.linesRendered.length) {
    lines.push(`Already said this session (do not reuse wording): ${d.linesRendered.join(" | ")}`);
  }
  return lines.join("\n");
}

function seedHint(item, register) {
  const s = item.seeds && (item.seeds[register] || item.seeds.neutral);
  return s && s.length ? `"${s[0]}"` : "natural, in voice";
}
