// api/pronunciation-gpt.js
// Lightweight CORS first, heavy stuff only for POST

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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Only POST allowed" });
  }

  // 3) Load Heavy Deps
  const [{ OpenAI }, { jsonrepair }] = await Promise.all([
    import("openai"),
    import("jsonrepair"),
  ]);

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // -------------- helpers -------------
  const universallyHard = new Set(["θ", "ð", "ɹ"]);
  const langs = {
    es: "Spanish", fr: "French", pt: "Portuguese", zh: "Chinese",
    ja: "Japanese", ko: "Korean", ar: "Arabic", ru: "Russian",
    de: "German", hi: "Hindi", mr: "Marathi", universal: "Universal",
  };
  const alias = { dh: "ð", th: "θ", r: "ɹ" };
  const norm = (s) => alias[s] || s;

  function worstPhoneme(json) {
    const tally = {};
    json?.NBest?.[0]?.Words?.forEach((w) =>
      w.Phonemes?.forEach((p) => {
        if (p.AccuracyScore < 85) {
          const k = norm(p.Phoneme);
          tally[k] = (tally[k] || 0) + 1;
        }
      })
    );
    return Object.entries(tally).sort((a, b) => b[1] - a[1])[0]?.[0] || "";
  }

  function worstWords(json, n = 3) {
    return (json?.NBest?.[0]?.Words || [])
      .filter((w) => w.AccuracyScore < 70)
      .sort((a, b) => a.AccuracyScore - b.AccuracyScore)
      .slice(0, n)
      .map((w) => w.Word);
  }

  function forceJson(str) {
    if (!str || typeof str !== "string") throw new Error("No string to parse");
    str = str
      .trim()
      .replace(/^```json?\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/```$/, "")
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'");
    const first = str.indexOf("{");
    const last = str.lastIndexOf("}");
    if (first === -1 || last === -1) throw new Error("No JSON braces found");
    return JSON.parse(str.slice(first, last + 1));
  }

  async function translateMissing(arr, lang) {
    const need = arr.filter((s) => !s.l1);
    if (!need.length || lang === "universal") return;

    const prompt = `Translate these English strings into *${langs[lang]}*. Return JSON array of strings.`;

    const rsp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      response_format: { type: "json_object" },
      max_tokens: 1000,
      messages: [
        { role: "system", content: prompt },
        { role: "user", content: JSON.stringify({ items: need.map((s) => s.en) }) },
      ],
    });

    try {
      const parsed = forceJson(rsp.choices[0].message.content);
      const translations = Array.isArray(parsed.items) ? parsed.items : Object.values(parsed);
      need.forEach((sec, i) => {
        sec.l1 = translations[i] || "";
      });
    } catch (e) {
      console.warn("Translation parse fail", e);
    }
  }

  try {
    const {
      referenceText = "",
      azureResult = {},
      firstLang = "",
      mode = "detailed" // Default to detailed for legacy compat
    } = req.body || {};

    const langRaw = firstLang.trim().toLowerCase();
    const langCode =
      langRaw === ""
        ? "universal"
        : langRaw.startsWith("zh")
        ? "zh"
        : langRaw;

    const worst = worstPhoneme(azureResult);
    const badList = worstWords(azureResult);
    const universal = universallyHard.has(worst);

    // --- Mode Selection ---
    const isSimple = mode === "simple";
    const model = isSimple ? "gpt-4o-mini" : "gpt-4o";
    const maxTokens = isSimple ? 600 : 1800;

    let SYSTEM;
    if (isSimple) {
        // FAST PATH: 1 concise section
        SYSTEM = `You are a concise pronunciation coach.
Return pure JSON: { "sections": [ { "title": "Quick Coach", "en": "string", "emoji": "⚡" } ] }
Provide 3 bullet points on the user's worst phoneme /${worst}/ or worst words. Max 50 words total. No markdown.`;
    } else {
        // DETAILED PATH: 6 sections
        const sections = [
            { emoji: "🎯", en: "Quick Coaching", min: 80, max: 120 },
            { emoji: "🔬", en: "Phoneme Profile", min: 70, max: 110 },
            { emoji: "🪜", en: "Common Pitfalls", min: 80, max: 120 },
            { emoji: "⚖️", en: "Comparisons", min: 90, max: 130 },
            { emoji: "🌍", en: "Did You Know?", min: 80, max: 130 },
            { emoji: "🤝", en: "Reassurance", min: 40, max: 70 },
        ];
        const ranges = sections.map((s, i) => `${i + 1}. ${s.emoji} ${s.en} — ${s.min}-${s.max} EN words`).join("\n");
        SYSTEM = `You are the world's leading bilingual pronunciation coach.
Return pure JSON exactly like: { "sections":[ {"title":"","titleL1":"","en":"","l1":""} ] }
Follow the 6 sections in order:
${ranges}
If langCode === "universal" leave "l1" blank. No markdown.`;
    }

    const USER = JSON.stringify({
      worstPhoneme: worst,
      worstWords: badList,
      sampleText: referenceText,
      universal,
      langCode,
    });

    const draft = await openai.chat.completions.create({
      model: model,
      temperature: 0.6,
      response_format: { type: "json_object" },
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: USER },
      ],
    });

    let gptRaw = draft.choices[0].message.content || "";
    let data;

    try {
      data = forceJson(gptRaw);
    } catch (e1) {
      try {
        // Auto-repair if JSON is bad (usually only happens on complex models)
        const fix = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          temperature: 0,
          response_format: { type: "json_object" },
          max_tokens: 900,
          messages: [
            { role: "system", content: "Fix JSON syntax." },
            { role: "user", content: gptRaw.slice(0, 4000) },
          ],
        });
        data = forceJson(fix.choices[0].message.content || "");
      } catch (e2) {
        data = JSON.parse(jsonrepair(gptRaw));
      }
    }

    if (!Array.isArray(data.sections)) {
      throw new Error("Bad sections array");
    }

    // Only translate if L1 is set
    await translateMissing(data.sections, langCode);

    return res.status(200).json({ sections: data.sections });
  } catch (err) {
    console.error("[pronunciation-gpt]", err);
    return res.status(200).json({
      fallbackSections: [
        {
          title: "AI Busy",
          en: "Could not generate feedback right now. Please try again.",
          emoji: "⚠️"
        },
      ],
    });
  }
}
