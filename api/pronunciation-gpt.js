// api/pronunciation-gpt.js
// Mode + Chunk support enabled.

export const config = {
  api: {
    bodyParser: true,
    externalResolver: true,
  },
};

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

  const [{ OpenAI }, { jsonrepair }] = await Promise.all([
    import("openai"),
    import("jsonrepair"),
  ]);

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // --- Helpers ---
  const universallyHard = new Set(["θ", "ð", "ɹ"]);
  const langs = {
    es: "Spanish", fr: "French", pt: "Portuguese", zh: "Chinese",
    ja: "Japanese", ko: "Korean", ar: "Arabic", ru: "Russian",
    de: "German", hi: "Hindi", mr: "Marathi", universal: "Universal",
  };
  const norm = (s) => (({ dh: "ð", th: "θ", r: "ɹ" })[s] || s);

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
    str = str.trim().replace(/^```json?\s*/i, "").replace(/^```\s*/i, "").replace(/```$/, "");
    return JSON.parse(str.slice(str.indexOf("{"), str.lastIndexOf("}") + 1));
  }

  async function translateMissing(arr, lang) {
    const need = arr.filter((s) => !s.l1);
    if (!need.length || lang === "universal") return;
    
    const prompt = `Translate these English strings into *${langs[lang]}*. Return JSON object { "items": ["..."] }.`;
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
      const translations = parsed.items || Object.values(parsed);
      need.forEach((sec, i) => { sec.l1 = translations[i] || ""; });
    } catch (e) {
      console.warn("Translation parse fail", e);
    }
  }

  try {
    const {
      referenceText = "",
      azureResult = {},
      firstLang = "",
      mode = "detailed",
      chunk = 1
    } = req.body || {};

    const langRaw = firstLang.trim().toLowerCase();
    const langCode = langRaw === "" ? "universal" : (langRaw.startsWith("zh") ? "zh" : langRaw);
    const worst = worstPhoneme(azureResult);
    const badList = worstWords(azureResult);

    // --- MILESTONE 2: CHUNKING LOGIC ---
    
    const ALL_SECTIONS = [
      { emoji: "🎯", en: "Quick Coaching", min: 80, max: 120 },
      { emoji: "🔬", en: "Phoneme Profile", min: 70, max: 110 },
      { emoji: "🪜", en: "Common Pitfalls", min: 80, max: 120 },
      { emoji: "⚖️", en: "Comparisons", min: 90, max: 130 },
      { emoji: "🌍", en: "Did You Know?", min: 80, max: 130 },
      { emoji: "🤝", en: "Reassurance", min: 40, max: 70 },
    ];

    let targetSections = [];
    let systemPrompt = "";
    let model = "gpt-4o";
    let maxTokens = 1800;

    if (mode === "simple") {
      // FAST MODE: gpt-4o-mini, 1 section
      model = "gpt-4o-mini";
      maxTokens = 600;
      targetSections = [{ title: "Quick Coach", en: "string", emoji: "⚡" }];
      
      systemPrompt = `You are a concise pronunciation coach.
Return pure JSON: { "sections": [ { "title": "Quick Coach", "en": "string", "emoji": "⚡" } ] }
Provide 3 bullet points on the user's worst phoneme /${worst}/ or worst words. Max 50 words total. No markdown.`;

    } else {
      // DETAILED MODE: gpt-4o, chunked
      // Chunk 1: indices 0, 1
      // Chunk 2: indices 2, 3
      // Chunk 3: indices 4, 5
      const chunkIdx = Math.max(1, Math.min(3, Number(chunk) || 1)) - 1;
      const start = chunkIdx * 2;
      const end = start + 2;
      
      targetSections = ALL_SECTIONS.slice(start, end);
      
      // Calculate max tokens based on chunk size (saving money)
      maxTokens = 1000; 

      const ranges = targetSections
        .map((s, i) => `${i + 1}. ${s.emoji} ${s.en} — ${s.min}-${s.max} EN words`)
        .join("\n");

      systemPrompt = `You are the world's leading bilingual pronunciation coach.
Return pure JSON exactly like: { "sections":[ {"title":"","titleL1":"","en":"","l1":""} ] }
Follow these ${targetSections.length} sections in order:
${ranges}
If langCode === "universal" leave "l1" blank. No markdown.`;
    }

    const userPrompt = JSON.stringify({
      worstPhoneme: worst,
      worstWords: badList,
      sampleText: referenceText,
      universal: universallyHard.has(worst),
      langCode,
    });

    const draft = await openai.chat.completions.create({
      model,
      temperature: 0.6,
      response_format: { type: "json_object" },
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    let gptRaw = draft.choices[0].message.content || "";
    let data;

    try {
      data = forceJson(gptRaw);
    } catch (e1) {
      // Only repair if strictly necessary
      data = JSON.parse(jsonrepair(gptRaw));
    }

    const finalSections = Array.isArray(data.sections) ? data.sections : [];
    
    // Fill gaps if model hallucinations dropped a section
    while (finalSections.length < targetSections.length) {
        finalSections.push({ title: "Note", en: "Additional feedback unavailable.", emoji: "📝" });
    }

    await translateMissing(finalSections, langCode);

    return res.status(200).json({ sections: finalSections });

  } catch (err) {
    console.error("[pronunciation-gpt]", err);
    return res.status(200).json({
      fallbackSections: [{ title: "Error", en: "Could not generate feedback.", emoji: "⚠️" }]
    });
  }
}
