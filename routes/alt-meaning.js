// routes/alt-meaning.js
// Tiny on-demand meanings/examples for alternate pronunciations (stress-shift, noun/verb, etc.)

export const config = {
  api: {
    bodyParser: true,
    externalResolver: true,
  },
};

export default async function handler(req, res) {
  // 1) CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-token");

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
  const word = (body.word || "").toString().trim().slice(0, 80);
  const sentence = (body.sentence || "").toString().trim().slice(0, 280);
  const pronsIn = Array.isArray(body.prons) ? body.prons : [];
  const prons = pronsIn
    .map((p) => (p || "").toString().trim())
    .filter(Boolean)
    .slice(0, 6);

  if (!word || prons.length < 2) {
    return res.status(400).json({
      ok: false,
      error: "bad_request",
      detail: "word required and prons must contain at least 2 items",
    });
  }

  // 5) Prompt (strictly short, aligned to prons)
  const system = `
You generate ultra-short meaning hints for English words with multiple pronunciation variants.
You will be given:
- a target word
- the sentence context it came from (may be empty)
- a list of ARPAbet pronunciations (alts)

Your job:
Return JSON with a single key "alts" whose value is an array with EXACTLY the same length and order as the pronunciations list.
Each element must be an object:
- "pos": one of ["noun","verb","adjective","adverb","other","unknown"]
- "def": a single short definition (<= 12 words)
- "example": a single short example sentence (<= 12 words)
Optional:
- "note": only if needed, <= 12 words

Rules:
- If the pronunciation variants do NOT imply a meaning change (just dialect/phone variation), set pos="unknown",
  and use def like "Same meaning; pronunciation variant" and a simple example with the word.
- If context helps choose a noun vs verb sense, use it; otherwise keep it generic and honest.
- Keep everything very short and clean.
Output MUST be valid JSON only.
`.trim();

  const user = {
    word,
    sentence,
    pronunciations: prons,
  };

  // 6) Call model (cheap + deterministic)
  const MODEL =
    (process.env.LUX_AI_QUICK_MODEL || "").toString().trim() ||
    (process.env.LUX_AI_MODEL || "").toString().trim() ||
    "gpt-4o-mini";

  try {
    const resp = await openai.chat.completions.create({
      model: MODEL,
      temperature: 0.1,
      max_tokens: 350,
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

    // 7) Normalize output to guarantee array length
    const out = Array.isArray(parsed?.alts) ? parsed.alts : [];
    const fixed = prons.map((_, i) => {
      const it = out[i] || {};
      const pos = ["noun", "verb", "adjective", "adverb", "other", "unknown"].includes(it.pos)
        ? it.pos
        : "unknown";
      const def = (it.def || "").toString().trim().slice(0, 120);
      const example = (it.example || "").toString().trim().slice(0, 120);
      const note = (it.note || "").toString().trim().slice(0, 120);

      // minimal fallback if model gave blanks
      const safeDef = def || "Same meaning; pronunciation variant";
      const safeEx = example || `I said "${word}" clearly.`;

      const obj = { pos, def: safeDef, example: safeEx };
      if (note) obj.note = note;
      return obj;
    });

    return res.status(200).json({ ok: true, alts: fixed });
  } catch (e) {
    console.error("alt-meaning error", e);
    return res.status(500).json({ ok: false, error: "alt_meaning_failed" });
  }
}
