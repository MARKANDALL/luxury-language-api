// api/pronunciation-gpt.js
// Phase F: Structured Output + Personas + Hybrid Models (4o Logic / Mini Translation)
// STATUS: Complete (All helpers + Chunking + Personas restored)

export const config = {
  api: {
    bodyParser: true,
    externalResolver: true,
  },
};

// -- PERSONA DEFINITIONS --
const PERSONAS = {
  tutor: {
    role: "You are a warm, supportive American English tutor. Use emojis (✨, 👏). Always start with one positive thing before the correction.",
    style: "Encouraging, gentle, constructive."
  },
  drill: {
    role: "You are a strict Drill Sergeant. DO NOT use emojis. DO NOT give praise. State the error bluntly. Command the user to repeat.",
    style: "Direct, imperative, harsh, concise. Use ALL CAPS for key commands."
  },
  linguist: {
    role: "You are a technical Speech Pathologist. Use IPA symbols. Focus on tongue position (alveolar ridge, bilabial, etc), voicing, and airflow.",
    style: "Clinical, precise, academic. No fluff."
  }
};

export default async function handler(req, res) {
  // 1. CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  // 2. Imports & Init
  let OpenAI, jsonrepair;
  try {
    const modAI = await import("openai");
    const modRepair = await import("jsonrepair");
    OpenAI = modAI.OpenAI;
    jsonrepair = modRepair.jsonrepair;
  } catch (e) {
    console.error("Import error", e);
    return res.status(500).json({ error: "Server Init Error" });
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // 3. Helpers (Restored)
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

  // 4. Translation Helper (Using Mini)
  async function translateMissing(arr, lang) {
    const need = arr.filter((s) => !s.l1);
    if (!need.length || lang === "universal") return;
    
    console.log(`[AI Coach] Translating ${need.length} sections to ${lang}...`);

    const prompt = `Translate these English strings into *${langs[lang] || lang}*. Return JSON object { "items": ["..."] }.`;
    const rsp = await openai.chat.completions.create({
      model: "gpt-4o-mini", // Cheap model for translation
      temperature: 0,
      response_format: { type: "json_object" },
      max_tokens: 1000,
      messages: [
        { role: "system", content: prompt },
        { role: "user", content: JSON.stringify({ items: need.map((s) => s.en || s.content) }) },
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

  // 5. Main Handler
  try {
    const {
      referenceText = "",
      azureResult = {},
      firstLang = "",
      mode = "detailed",
      chunk = 1,
      persona = "tutor" // New Default
    } = req.body || {};

    const langRaw = firstLang.trim().toLowerCase();
    const langCode = langRaw === "" ? "universal" : (langRaw.startsWith("zh") ? "zh" : langRaw);
    const worst = worstPhoneme(azureResult);
    const badList = worstWords(azureResult);

    // --- SECTIONS DEFINITION (Restored) ---
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
    // Primary Logic Model: GPT-4o (High Quality)
    let model = "gpt-4o"; 
    let maxTokens = 1800;

    const selectedPersona = PERSONAS[persona] || PERSONAS.tutor;

    // --- COST CONTROL / CHUNKING LOGIC ---
    if (mode === "simple") {
      // FAST MODE: 1 section
      console.log("[AI Coach] Mode: Simple");
      maxTokens = 600;
      targetSections = [{ title: "Quick Coach", en: "string", emoji: "⚡" }];
      
      systemPrompt = `
        ${selectedPersona.role}
        Tone: ${selectedPersona.style}
        Return pure JSON: { "sections": [ { "title": "Quick Coach", "en": "string", "emoji": "⚡" } ] }
        Provide 3 bullet points on the user's worst phoneme /${worst}/ or worst words. Max 50 words total. No markdown.
      `;

    } else {
      // DETAILED MODE: Chunked
      const chunkIdx = Math.max(1, Math.min(3, Number(chunk) || 1)) - 1;
      const start = chunkIdx * 2;
      const end = start + 2;
      
      targetSections = ALL_SECTIONS.slice(start, end);
      
      console.log(`[AI Coach] Mode: Deep (Chunk ${chunkIdx + 1} of 3) -> Generates ${targetSections.length} sections`);

      maxTokens = 1000; 

      const ranges = targetSections
        .map((s, i) => `${i + 1}. ${s.emoji} ${s.en} — ${s.min}-${s.max} EN words`)
        .join("\n");

      systemPrompt = `
        ${selectedPersona.role}
        Tone: ${selectedPersona.style}
        Return pure JSON exactly like: { "sections":[ {"title":"","titleL1":"","en":"","l1":""} ] }
        Follow these ${targetSections.length} sections in order:
        ${ranges}
        If langCode === "universal" leave "l1" blank. No markdown.
      `;
    }

    const userPrompt = JSON.stringify({
      worstPhoneme: worst,
      worstWords: badList,
      sampleText: referenceText,
      universal: universallyHard.has(worst),
      langCode,
    });

    const draft = await openai.chat.completions.create({
      model, // gpt-4o for intelligence
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
      data = JSON.parse(jsonrepair(gptRaw));
    }

    const finalSections = Array.isArray(data.sections) ? data.sections : [];
    
    // Fill gaps
    while (finalSections.length < targetSections.length) {
        finalSections.push({ title: "Note", en: "Additional feedback unavailable.", emoji: "📝" });
    }

    // Translate (using Mini)
    await translateMissing(finalSections, langCode);

    return res.status(200).json({ sections: finalSections });

  } catch (err) {
    console.error("[pronunciation-gpt] Fatal Error:", err);
    return res.status(200).json({
      fallbackSections: [{ title: "Error", en: "Could not generate feedback.", emoji: "⚠️" }]
    });
  }
}
