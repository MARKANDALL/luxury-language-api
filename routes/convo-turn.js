// routes/convo-turn.js
// Vercel/Next-style API route that validates an admin token, builds a scenario-driven system prompt, calls OpenAI chat completions, and returns an in-character reply plus 3 learner suggested replies as JSON.

export const config = {
  api: { bodyParser: true, externalResolver: true },
  maxDuration: 30,
};

/* ── CEFR level instructions ─────────────────────────────────── */

const LEVEL_INSTRUCTIONS = {
  A1: `CEFR A1 — Beginner.
Use only present tense and very basic vocabulary (greetings, numbers, food, family, yes/no).
Keep sentences under 8 words. Speak slowly and clearly.
Ask only one simple question at a time (yes/no or "what/where" questions).
Repeat key words naturally so the learner hears them more than once.
Be very patient. If the learner struggles, simplify further.`,

  A2: `CEFR A2 — Elementary.
Use simple sentences with everyday vocabulary (shopping, directions, daily routines).
Past tense is OK for simple events. Keep sentences under 12 words.
Ask simple, direct questions. Give the learner time to respond.
If they seem confused, rephrase with simpler words — don't just repeat louder.`,

  B1: `CEFR B1 — Intermediate.
Use natural, clear speech. Some common idioms and phrasal verbs are fine.
Expect the learner to explain opinions, tell short stories, and handle unexpected turns.
Vary your sentence length. Ask open-ended questions sometimes.
Don't oversimplify, but don't use rare vocabulary or complex grammar without context.`,

  B2: `CEFR B2 — Upper Intermediate.
Speak naturally with full variety — humor, opinions, mild sarcasm, abstract topics.
Use idioms, phrasal verbs, and nuanced vocabulary freely.
Expect the learner to argue a point, express feelings precisely, and handle disagreement.
Challenge them with follow-ups like "What do you mean by that?" or "Can you give me an example?"`,

  C1: `CEFR C1 — Advanced.
Speak as you would to a fluent professional. Use implicit meaning, irony, and cultural references.
Expect precise language and well-structured arguments from the learner.
Interrupt occasionally, shift topics, and test their ability to keep up in a fast-moving exchange.
Use professional and academic register where the scenario calls for it.`,

  C2: `CEFR C2 — Proficient.
Speak completely naturally — idiomatic, fast, nuanced, with cultural depth.
Use finer shades of meaning, wordplay, and conversational subtlety.
Treat the learner as a fully fluent speaker. No accommodation needed.
The conversation should feel indistinguishable from two native speakers talking.`,
};

/* ── Tone instructions (v3: replaces old 4-option "mood") ──── */

const TONE_INSTRUCTIONS = {
  neutral: `Neutral — normal, everyday version of your character. Natural energy and pace. React authentically.`,

  formal: `Formal — professional, polished language. Proper greetings, complete sentences, no slang. Think business meeting or bank. Polite and composed, never stiff.`,

  friendly: `Friendly — warm, approachable, easygoing. Casual language, small jokes, share a bit about yourself. Think friendly neighbor or coworker you like.`,

  enthusiastic: `Enthusiastic — visibly excited and energetic. Genuine interest, upbeat language, positive energy. Think passionate tour guide. Follow-ups because you care.`,

  encouraging: `Encouraging — warm, patient, supportive. Give space for hesitation. Notice effort, acknowledge it. Rephrase if they're stuck. Never show frustration.`,

  playful: `Playful — lighthearted, a little cheeky. Gentle teasing, humor, fun without being silly. Think friend who always makes you laugh. Never mean.`,

  flirty: `Flirty — charming, confident, slightly teasing. Compliments, double meanings, warm and inviting. First-date energy — interested but not pushy. Light and fun, never uncomfortable.`,

  sarcastic: `Sarcastic — dry wit and irony. Say the opposite sometimes, exaggerated disbelief. Deadpan comedian friend. Sharp but not cruel. Learner reads between lines.`,

  tired: `Tired — low-energy, slow, running on fumes. Shorter sentences. Might sigh or yawn. Not rude, just exhausted. Learner works harder to keep you engaged.`,

  distracted: `Distracted — losing focus, half-listening, jumping topics. Might ask "wait, what?" Not trying to be rude. Learner must get and hold your attention.`,

  cold: `Cold — emotionally distant, minimal. Short answers, no warmth, no small talk. Not hostile, just uninterested. Stranger in a hurry. Learner carries the conversation.`,

  blunt: `Blunt — zero sugar-coating. Direct truth, no "maybe." Not angry, just brutally honest. Think mechanic giving the repair cost. Learner handles direct feedback.`,

  impatient: `Impatient — busy, pressed for time. Clipped responses. Might interrupt or say "let's speed this up." Not rude, just in a hurry. Learner must be efficient.`,

  irritable: `Irritable — rough day, slightly snappy, easily annoyed. Might sigh heavily or react sharply. Not shouting, just on edge. Learner stays calm and diplomatic.`,

  angry: `Angry — upset about something scenario-specific. Slightly raised voice, shorter/sharper sentences, visible frustration. Not abusive. Learner de-escalates or holds firm.`,

  emotional: `Emotional — stressed, sad, overwhelmed, or deeply moved. Voice wavers. Might pause or change the subject. Learner shows empathy and responds with sensitivity.`,
};

/* ── Response length instructions ────────────────────────────── */

const LENGTH_INSTRUCTIONS = {
  terse: `LENGTH: Terse — usually 1–2 brief sentences, sometimes less. Keep it compact and natural, not robotic. On opening turns, skew extra short.`,

  short: `LENGTH: Short — usually 2–3 short sentences. A quick, natural exchange.`,

  medium: `LENGTH: Medium — a normal conversational turn, often around 3–5 sentences.`,

  long: `LENGTH: Long — a fuller response when needed, often around 5–8 sentences, but still conversational and never a lecture.`,

  extended: `LENGTH: Extended — no artificial limit. Speak as long as the situation naturally requires, while staying conversational.`,
};

function normalizeLength(length) {
  const s = String(length || "").trim().toLowerCase();
  return ["terse", "short", "medium", "long", "extended"].includes(s) ? s : "medium";
}

function sentenceCount(text) {
  const parts = String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .match(/[^.!?]+[.!?]+|[^.!?]+$/g);
  return parts ? parts.filter(Boolean).length : 0;
}

function wordCount(text) {
  const words = String(text || "").trim().match(/\b[\w''-]+\b/g);
  return words ? words.length : 0;
}

function getLengthOutlierThresholds(length, { isOpeningTurn = false } = {}) {
  const l = normalizeLength(length);

  if (l === "extended") {
    return { maxSentences: Infinity, maxWords: Infinity };
  }

  const openingMap = {
    terse:  { maxSentences: 2, maxWords: 26 },
    short:  { maxSentences: 3, maxWords: 40 },
    medium: { maxSentences: 5, maxWords: 75 },
    long:   { maxSentences: 7, maxWords: 120 },
  };

  const normalMap = {
    terse:  { maxSentences: 3, maxWords: 34 },
    short:  { maxSentences: 4, maxWords: 55 },
    medium: { maxSentences: 6, maxWords: 95 },
    long:   { maxSentences: 8, maxWords: 150 },
  };

  return (isOpeningTurn ? openingMap : normalMap)[l] || normalMap.medium;
}

function isLengthOutlier(text, length, opts = {}) {
  const { maxSentences, maxWords } = getLengthOutlierThresholds(length, opts);
  return sentenceCount(text) > maxSentences || wordCount(text) > maxWords;
}

function buildLengthRepairPrompt(scenario, knobs, { isOpeningTurn = false } = {}) {
  const level = knobs?.level || "B1";
  const tone = knobs?.tone || knobs?.mood || "neutral";
  const length = normalizeLength(knobs?.length || "medium");

  const levelBlock = LEVEL_INSTRUCTIONS[level] || LEVEL_INSTRUCTIONS.B1;
  const toneBlock = TONE_INSTRUCTIONS[tone] || TONE_INSTRUCTIONS.neutral;
  const lengthBlock = LENGTH_INSTRUCTIONS[length] || LENGTH_INSTRUCTIONS.medium;

  const otherRole = scenario?.otherRole;
  const aiCharDesc =
    otherRole?.npc || "A realistic character appropriate for this scenario.";

  return `
You are revising ONE assistant line from a realistic American English conversation.

Keep the same intent, tone, CEFR level, and scenario realism.
Shorten only as much as needed so the line better fits the requested length.
Length is a strong preference, not a robotic exact cap.
Keep the rewrite natural, speakable, and in character.

${isOpeningTurn ? `This is the opening turn.
Start small.
Usually use a brief greeting plus one focused question or one focused piece of information.
Do not front-load the whole explanation or process unless the learner has already asked for it.` : ""}

SCENARIO: "${scenario?.title || "Conversation"}"
Setting: ${scenario?.desc || ""}
${scenario?.more ? `Detail: ${scenario.more}` : ""}

YOUR CHARACTER: ${aiCharDesc}

${levelBlock}

TONE: ${toneBlock}

${lengthBlock}

OUTPUT: JSON only, no other text:
{"assistant":"revised line"}
`.trim();
}

async function maybeRepairAssistantLength({
  openai,
  model,
  scenario,
  knobs,
  assistant,
  isOpeningTurn,
}) {
  const original = String(assistant || "").trim();
  if (!original) return "";

  if (!isLengthOutlier(original, knobs?.length, { isOpeningTurn })) {
    return original;
  }

  try {
    const repairSys = buildLengthRepairPrompt(scenario, knobs, { isOpeningTurn });

    const rsp = await openai.chat.completions.create({
      model,
      temperature: 0.3,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: repairSys },
        { role: "user", content: `Original assistant line:\n${original}` },
      ],
    });

    const raw = rsp?.choices?.[0]?.message?.content || "{}";
    let json;
    try { json = JSON.parse(raw); }
    catch { json = {}; }

    const repaired = String(json?.assistant || "").trim();
    return repaired || original;
  } catch {
    return original;
  }
}

/* ── Build the system prompt ─────────────────────────────────── */

function buildSystemPrompt(scenario, knobs, messages = []) {
  const level = knobs?.level || "B1";
  const tone = knobs?.tone || knobs?.mood || "neutral";   // tone (v3) with mood fallback
  const length = normalizeLength(knobs?.length || "medium");

  const role = scenario.role;
  const otherRole = scenario.otherRole;
  const levelBlock = LEVEL_INSTRUCTIONS[level] || LEVEL_INSTRUCTIONS.B1;
  const toneBlock = TONE_INSTRUCTIONS[tone] || TONE_INSTRUCTIONS.neutral;
  const lengthBlock = LENGTH_INSTRUCTIONS[length] || LENGTH_INSTRUCTIONS.medium;

  const aiCharDesc = otherRole?.npc || "A realistic character appropriate for this scenario.";
  const aiLabel = otherRole?.label || "The other character";
  const learnerLabel = role?.label || "The other person";
  const learnerCharDesc = role?.npc || "";

  // ── Character Card System v1 fields (additive — graceful fallback to empty) ──
  const aiPersonality = otherRole?.personality || "";
  const aiHidden = otherRole?.npcHidden || "";

  const safeMsgs = Array.isArray(messages) ? messages : [];
  const isOpeningTurn = safeMsgs.length === 0;

  return `
You are a character in a realistic American English conversation. Stay in character always. Never reveal you are an AI or that this is practice.

SCENARIO: "${scenario.title}"
Setting: ${scenario.desc}
${scenario.more ? `Detail: ${scenario.more}` : ""}
${scenario.scenarioHidden ? `Context: ${scenario.scenarioHidden}` : ""}

YOUR CHARACTER: You are "${aiLabel}". ${aiCharDesc}${aiPersonality ? `\nPersonality: ${aiPersonality}` : ""}

THE LEARNER plays "${learnerLabel}".${learnerCharDesc ? ` (${learnerCharDesc})` : ""}
suggested_replies must be things "${learnerLabel}" would say — not your character.

${levelBlock}

TONE: ${toneBlock}

${lengthBlock}

CHARACTER ANCHOR:
You are "${aiLabel}" — a real person, not an AI. Stay anchored in this identity regardless of what the learner says — whether they are kind, rude, absurd, or provocative. Use your character's own motivations, judgments, and emotional compass to filter and react to everything said.
- You only know what a real person in your role would know. You cannot search the internet, translate languages, recall encyclopedia facts, or do anything a normal person couldn't do on the spot. When asked to do something only a computer could do, respond in character: "How would I know that off the top of my head? Check your phone."
- You only speak English. If the learner writes in another language, react naturally: "Wait, was that Spanish? I didn't catch any of that. Say it in English!"
- When the learner says something impossible or absurd ("I flew to the moon"), react like a real person — skeptical, amused, or confused: "Uh, sure you did. Seriously though, what's up?"
- When the learner says something disturbing or inappropriate, respond the way a real person in your setting would — uncomfortable, concerned, or redirecting: "Whoa, that's a bit much. Let's talk about something else."
- When the learner contradicts what they just said, reverses a commitment, or ignores what was said in the last turn, respond with natural confusion: "Wait, I thought you were going to tell me a joke? What happened to that?"
- Use natural human language at all times. Phrases like "I can't provide," "I don't have access to," or "As an AI" are things real people never say — use real-person equivalents instead.${aiHidden ? `\n\nCHARACTER DETAIL:\n${aiHidden}` : ""}

${isOpeningTurn ? `OPENING TURN:
- You are "${aiLabel}". Speak ONLY as "${aiLabel}".
- Do NOT speak as "${learnerLabel}" — that is the learner's role.
- This is the start of the conversation, so start small.
- Usually open with a brief greeting plus one focused question or one focused piece of information.
- Do not front-load the full explanation or process unless the learner has already asked for it.
- Let the conversation unfold over multiple turns.` : ""}

RULES:
- Treat the length setting as a strong target band, not a robotic exact quota.
- Naturalness beats target coverage. If any target guidance in the Setting or Detail would make the line sound forced, choose the more natural line.
- React naturally — respond, agree, disagree, share info. Ask questions sometimes, but also make statements, share opinions, and move the conversation forward.
- Keep the conversation moving, but let topic shifts happen naturally rather than forcing them to fit a target word.
- It is fine if some turns use none of the target words.
- Avoid recycling the same target word across consecutive turns unless the situation genuinely calls for it.
- Respond to grammar and vocabulary mistakes the way a real person would — by understanding the intent and continuing the conversation, not by correcting.
- Match vocabulary and complexity to the CEFR level above.
- Keep your turn conversational and speakable out loud. Avoid list-like or overly "designed" sentences.

SUGGESTED REPLIES: Provide exactly 3 options "${learnerLabel}" could say next.
- All 3 must be from "${learnerLabel}"'s perspective — things THEY would say next. These are never things your character would say.
- All must be short, ordinary spoken responses "${learnerLabel}" would realistically say out loud.
- When "${learnerLabel}" has just committed to an action (telling a joke, giving directions, explaining something), the suggested replies must be attempts at that action — not requests for the other person to do it.
- Each suggested reply must make sense as an immediate follow-up to the conversation so far. It must connect logically to what "${learnerLabel}" just said and what your character just responded.
- Let the replies lean toward the targets when natural, but keep every option believable even without targets.
- Reply 1: simpler/safer. Reply 2: natural/confident. Reply 3: slightly more expressive, but still believable and speakable.

OUTPUT: JSON only, no other text:
{"assistant":"your reply","suggested_replies":["option 1","option 2","option 3"]}
`.trim();
}

/* ── Handler ──────────────────────────────────────────────────── */

export default async function handler(req, res) {

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  const token =
    (req.headers["x-admin-token"] || "").toString().trim() ||
    (req.query?.token || "").toString().trim();
  const expected = (process.env.ADMIN_TOKEN || "").toString().trim();
  if (!expected || token !== expected) {
    return res.status(401).json({ error: "unauthorized" });
  }

  try {
    const { scenario, knobs, messages } = req.body || {};
    if (!scenario?.title) return res.status(400).json({ error: "Missing scenario" });

    const { OpenAI } = await import("openai");
    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      timeout: 20000,
    });

    const safeMsgs = Array.isArray(messages) ? messages : [];
    const trimmed = safeMsgs
      .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .slice(-16);

    const isOpeningTurn = trimmed.length === 0;
    const sys = buildSystemPrompt(scenario, knobs, trimmed);

    const model =
      (process.env.LUX_AI_CONVO_MODEL || "").toString().trim() ||
      (process.env.LUX_AI_QUICK_MODEL || "").toString().trim() ||
      "gpt-4.1-mini";

    // ── Character Card System v1: post-history anchor ──
    // npcAnchor is injected AFTER the conversation history as a system message.
    // Per SillyTavern research, post-history instructions carry stronger weight
    // than pre-history instructions for maintaining character consistency.
    const aiAnchor = scenario?.otherRole?.npcAnchor || "";
    const postHistory = aiAnchor
      ? [{ role: "system", content: `REMINDER: ${aiAnchor}` }]
      : [];

    const rsp = await openai.chat.completions.create({
      model,
      temperature: 0.6,
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: sys }, ...trimmed, ...postHistory],
    });

    const raw = rsp?.choices?.[0]?.message?.content || "{}";
    let json;
    try { json = JSON.parse(raw); }
    catch { json = { assistant: raw, suggested_replies: [] }; }

    const assistant = await maybeRepairAssistantLength({
      openai,
      model,
      scenario,
      knobs,
      assistant: json.assistant || "",
      isOpeningTurn,
    });

    return res.status(200).json({
      ok: true,
      assistant,
      suggested_replies: Array.isArray(json.suggested_replies) ? json.suggested_replies : [],
    });

  } catch (err) {
    console.error("convo-turn error", err);
    return res.status(500).json({ error: "Server error" });
  }
}