// api/convo-turn.js
export const config = {
  api: { bodyParser: true, externalResolver: true },
};

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function buildSystemPrompt({ title, desc }, knobs) {
  const tone = knobs?.tone || "friendly";
  const stress = knobs?.stress || "low";
  const pace = knobs?.pace || "normal";

  return `
You are roleplaying a realistic American English conversation scenario.

Scenario:
- Title: ${title}
- Description: ${desc}

Style knobs (follow them strongly):
- Tone: ${tone}
- Stress level: ${stress}
- Pace: ${pace}

Rules:
- Keep the conversation natural and practical (adult real-world).
- Use standard American English.
- Be concise (1–4 short paragraphs). Avoid lectures.
- Ask a follow-up question often so the conversation continues.
- Provide 3 suggested user replies that feel natural in this situation.
- Suggested replies must be phrases the user can comfortably speak aloud.

Output JSON ONLY with:
{
  "assistant": "assistant message text",
  "suggested_replies": ["...", "...", "..."]
}
`.trim();
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  try {
    const { scenario, knobs, messages } = req.body || {};
    if (!scenario?.title) return res.status(400).json({ error: "Missing scenario" });

    const { OpenAI } = await import("openai");
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const sys = buildSystemPrompt(scenario, knobs);

    const safeMsgs = Array.isArray(messages) ? messages : [];
    const trimmed = safeMsgs
      .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .slice(-24);

    const rsp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.7,
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: sys }, ...trimmed],
    });

    const raw = rsp?.choices?.[0]?.message?.content || "{}";
    let json;
    try { json = JSON.parse(raw); }
    catch { json = { assistant: raw, suggested_replies: [] }; }

    return res.status(200).json({
      ok: true,
      assistant: json.assistant || "",
      suggested_replies: Array.isArray(json.suggested_replies) ? json.suggested_replies : [],
    });

  } catch (err) {
    console.error("convo-turn error", err);
    return res.status(500).json({ error: "Server error" });
  }
}
