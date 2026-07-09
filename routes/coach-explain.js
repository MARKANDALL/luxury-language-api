// routes/coach-explain.js
// Highlight-to-Explain — layered explanation of a phrase the learner selected
// in an AI conversation bubble. Cloned from the routes/alt-meaning.js skeleton:
// same CORS/OPTIONS + admin-token gate, same cheap-model config
// (LUX_AI_QUICK_MODEL -> LUX_AI_MODEL -> gpt-4.1-mini), same json_object +
// jsonrepair parsing.
//
// Contract:
//   POST { phrase, sentence, context[], lang, l1, level, persona, uid }
//   ->   { ok: true, layers: { simple, translation, why, deeper } }
//
// Layers:
//   simple      - plain-language explanation IN the target language, level-matched
//   translation - the phrase rendered in the learner's L1 (English if L1 unknown)
//   why         - why the speaker said it at this point in the conversation
//   deeper      - register, nuance, and what else a native might say

export const config = {
  api: {
    bodyParser: true,
    externalResolver: true,
  },
};

const PERSONAS = new Set(["tutor", "drill", "linguist"]);
const LEVELS = new Set(["A1", "A2", "B1", "B2", "C1", "C2"]);

export default async function handler(req, res) {
  // 1) CORS

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method Not Allowed" });

  // 2) ADMIN_TOKEN gate (cost-control)
  const token =
    (req.headers["x-admin-token"] || "").toString().trim() ||
    (req.query?.token || "").toString().trim();
  const expected = (process.env.ADMIN_TOKEN || "").toString().trim();
  if (!expected || token !== expected) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  // 3) Imports & init
  let OpenAI, jsonrepair;
  try {
    const modAI = await import("openai");
    const modRepair = await import("jsonrepair");
    OpenAI = modAI.OpenAI;
    jsonrepair = modRepair.jsonrepair;
  } catch (e) {
    console.error("Import error", e);
    return res.status(500).json({ ok: false, error: "Server Init Error" });
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // 4) Validate input
  const body = req.body || {};
  const isEs =
    (body.lang || "").toString().trim().toLowerCase() === "es" ||
    (body.pack || "").toString().trim().toLowerCase() === "es";
  const phrase = (body.phrase || "").toString().trim().slice(0, 280);
  const sentence = (body.sentence || "").toString().trim().slice(0, 600);
  const contextIn = Array.isArray(body.context) ? body.context : [];
  const context = contextIn
    .map((c) => (c || "").toString().trim().slice(0, 600))
    .filter(Boolean)
    .slice(0, 4);
  const l1 = (body.l1 || "universal").toString().trim().slice(0, 24);
  const level = LEVELS.has((body.level || "").toString().trim()) ? body.level.toString().trim() : "B1";
  const persona = PERSONAS.has((body.persona || "").toString().trim()) ? body.persona.toString().trim() : "tutor";

  if (!phrase) {
    return res.status(400).json({
      ok: false,
      error: "bad_request",
      detail: "phrase required",
    });
  }

  // 5) Prompt (layered, persona-flavored, strictly short)
  const targetName = isEs ? "Mexican Spanish" : "American English";
  const hasL1 = l1 && l1 !== "universal";
  const translationTarget = hasL1
    ? `the learner's first language (code: "${l1}")`
    : (isEs ? "English" : "plain, simpler English");

  const personaVoice = {
    tutor: "Warm, encouraging tutor. Friendly and clear.",
    drill: "Drill sergeant. Blunt, punchy, no fluff — but never insulting.",
    linguist: "Expert linguist. Precise and analytical, still accessible.",
  }[persona];

  const system = `
You are an AI language coach inside a speaking-practice app. A ${targetName} learner (CEFR ${level}) selected a phrase from an AI conversation partner's message because they did not fully understand it.

Voice: ${personaVoice}

You will be given:
- the selected phrase
- the full message it came from
- up to a few earlier turns of the conversation (may be empty)

Return JSON with exactly these keys, each a string:
- "simple": explain what the phrase means, in ${targetName}, in words a CEFR ${level} learner knows. 1-2 short sentences. This is the first thing the learner sees — make it instantly clear.
- "translation": render the selected phrase naturally in ${translationTarget}. Just the translation, no commentary.
- "why": why the speaker said this at this exact point in the conversation, in ${targetName}, 1-2 short sentences. Use the earlier turns if given.
- "deeper": register and nuance — is it formal, casual, idiomatic? What else might a native say instead? In ${targetName}, 2-3 short sentences max.

Rules:
- Stay in the coach voice described above in "simple", "why", and "deeper".
- Never exceed the sentence limits. Short and clean beats complete.
- If the phrase is a fragment mid-word or nonsense, still do your best with the surrounding message.
Output MUST be valid JSON only.
`.trim();

  const user = {
    phrase,
    message: sentence,
    earlier_turns: context,
  };

  // 6) Call model (cheap + deterministic)
  const MODEL =
    (process.env.LUX_AI_QUICK_MODEL || "").toString().trim() ||
    (process.env.LUX_AI_MODEL || "").toString().trim() ||
    "gpt-4.1-mini";

  try {
    const resp = await openai.chat.completions.create({
      model: MODEL,
      temperature: 0.3,
      max_tokens: 500,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(user) },
      ],
    });

    const raw = resp?.choices?.[0]?.message?.content || "{}";
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // repair then parse
      parsed = JSON.parse(jsonrepair(raw));
    }

    // 7) Normalize output — every layer a trimmed, capped string
    const cap = (v, n) => (v || "").toString().trim().slice(0, n);
    const layers = {
      simple: cap(parsed.simple, 400),
      translation: cap(parsed.translation, 400),
      why: cap(parsed.why, 400),
      deeper: cap(parsed.deeper, 600),
    };

    if (!layers.simple) {
      return res.status(502).json({ ok: false, error: "empty_answer" });
    }

    return res.status(200).json({ ok: true, layers });
  } catch (e) {
    console.error("coach-explain error", e);
    return res.status(500).json({ ok: false, error: "coach_explain_failed" });
  }
}