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
    role: "You are a warm, supportive American English tutor. Use emojis occassionally (✨, 👏). You are a careful balance of friendly but honest about where improvements could be implemented. You strive to use clear language that's not too technical, but you do insert some slightly higher level themes, concepts or terms from time to time.",
    style: "Encouraging, gentle, constructive."
  },
  drill: {
    role: "You are a strict Drill Sergeant. DO NOT use emojis. Rarely give praise, unless it is really justified. State the error bluntly. Command the user to repeat. IMPORTANT: Only write in all caps when warranted. Use normal sentence case most of the time.",
    style: "Direct, imperative, concise, and brutally honest. Sentence case by default. You may use ALL CAPS only for very short command phrases and at most twice per response, to simulate shouting."
  },
  linguist: {
    role: "You are a technical Speech Pathologist. Use IPA symbols. Focus on tongue position (alveolar ridge, bilabial, etc), voicing, and airflow. But you're also aware at times that you might not be accessible to the average language learner and you make little efforts to ensure they're following you after a possibly confusing technical deepdive",
    style: "Clinical, precise, academic, and explanatory."
  }
};

// Extra guardrails specifically for Drill Sergeant casing behavior
const DRILL_CASING_GUARDRAILS = `
Casing rules (Drill Sergeant):
- Write in normal sentence case by default.
- DO NOT write the whole response in ALL CAPS.
- ALL CAPS is allowed only for short commands (≤4 words), max 2 per response.
- If you use an ALL CAPS command, put it on its own line.
`;

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

  // Model selection
  const QUICK_MODEL = process.env.LUX_AI_QUICK_MODEL || "gpt-4.1-mini";  // fast, non-reasoning
  const DEEP_MODEL  = process.env.LUX_AI_DEEP_MODEL  || "gpt-4.1";       // strongest non-reasoning

  // Optional: only if you want DeepDive to sometimes use a reasoning model
  const DEEP_REASONING_MODEL  = process.env.LUX_AI_DEEP_REASONING_MODEL || "";
  const DEEP_REASONING_EFFORT = process.env.LUX_AI_DEEP_REASONING_EFFORT || "medium";

  const TRANSLATE_MODEL = process.env.LUX_AI_TRANSLATE_MODEL || "gpt-4o-mini";

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
      model: TRANSLATE_MODEL, // Cheap model for translation (configurable)
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

  // 4b. Optional History Summary Helper (DB-computed, guarded)
  function safeNum(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function extractPronScore(summary) {
    if (!summary || typeof summary !== "object") return null;
    // tolerant: support a few likely shapes
    const direct =
      safeNum(summary.pron) ??
      safeNum(summary.pronunciation) ??
      safeNum(summary.pronScore) ??
      safeNum(summary.PronunciationScore);

    if (direct != null) return direct;

    const scores = summary.scores && typeof summary.scores === "object" ? summary.scores : null;
    if (scores) {
      return safeNum(scores.pron) ?? safeNum(scores.pronunciation) ?? safeNum(scores.pronScore) ?? null;
    }
    return null;
  }

  async function computeHistorySummaryIfNeeded({ mode, chunk, includeHistory, attemptId, uid }) {
    // Only for DeepDive and only on chunk 1
    if (mode === "simple") return null;
    if ((Number(chunk) || 1) !== 1) return null;
    if (!uid) return null;

    const attemptNum = safeNum(attemptId);
    const includeByRule =
      includeHistory === true ||
      (attemptNum != null && attemptNum % 3 === 0);

    if (!includeByRule) return null;

    // Best-effort DB access (Supabase). If your project uses a different DB client,
    // keep the shape and swap the implementation.
    const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
    const supabaseKey =
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.SUPABASE_SERVICE_KEY ||
      process.env.SUPABASE_ANON_KEY ||
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
      "";

    if (!supabaseUrl || !supabaseKey) return null;

    try {
      const mod = await import("@supabase/supabase-js");
      const createClient = mod.createClient;
      const supabase = createClient(supabaseUrl, supabaseKey);

      // Pull last ~40 summaries for the user
      const { data, error } = await supabase
        .from("lux_attempts") // public.lux_attempts
        .select("summary, created_at")
        .eq("uid", uid)
        .order("created_at", { ascending: false })
        .limit(40);

      if (error) {
        console.warn("[AI Coach] History query error:", error);
        return null;
      }

      const rows = Array.isArray(data) ? data : [];
      if (!rows.length) return null;

      // Aggregate summary.lows phoneme counts + summary.words counts
      const phonemeCounts = {};
      const wordCounts = {};
      const pronScores = [];

      for (const row of rows) {
        const summary = row?.summary || null;

        // lows: { "θ": 3, "ɹ": 2, ... }
        const lows = summary?.lows;
        if (lows && typeof lows === "object" && !Array.isArray(lows)) {
          for (const [k, v] of Object.entries(lows)) {
            const n = safeNum(v) || 0;
            if (!k) continue;
            phonemeCounts[k] = (phonemeCounts[k] || 0) + n;
          }
        }

        // words: can be { "word": 2 } OR ["word1","word2"] OR [{word,count}]
        const words = summary?.words;
        if (words && typeof words === "object") {
          if (Array.isArray(words)) {
            for (const item of words) {
              if (typeof item === "string") {
                wordCounts[item] = (wordCounts[item] || 0) + 1;
              } else if (item && typeof item === "object") {
                const w = item.word || item.text || item.w || "";
                const c = safeNum(item.count) || 1;
                if (w) wordCounts[w] = (wordCounts[w] || 0) + c;
              }
            }
          } else {
            for (const [k, v] of Object.entries(words)) {
              const n = safeNum(v) || 0;
              if (!k) continue;
              wordCounts[k] = (wordCounts[k] || 0) + n;
            }
          }
        }

        const ps = extractPronScore(summary);
        if (ps != null) pronScores.push(ps);
      }

      const topTroublePhonemes = Object.entries(phonemeCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([k]) => k);

      const topTroubleWords = Object.entries(wordCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([k]) => k);

      // pronDeltaLast5: avg(last 5) - avg(prev 5)
      let pronDeltaLast5 = null;
      if (pronScores.length >= 6) {
        const last5 = pronScores.slice(0, 5);
        const prev5 = pronScores.slice(5, 10);
        const avg = (arr) => arr.reduce((s, x) => s + x, 0) / Math.max(1, arr.length);
        pronDeltaLast5 = Number((avg(last5) - avg(prev5)).toFixed(2));
      }

      return {
        topTroublePhonemes,
        topTroubleWords,
        pronDeltaLast5,
      };
    } catch (e) {
      console.warn("[AI Coach] History summary unavailable:", e);
      return null;
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
      persona = "tutor",

      // NEW: for speed + paging + history
      uid = "",
      attemptId = null,
      tipIndex = 0,
      tipCount = 3,
      includeHistory = undefined
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
    // Primary Logic Model: Deep model (high quality, non-reasoning by default)
    let model = DEEP_MODEL;
    let maxTokens = 1800;

    const selectedPersona = PERSONAS[persona] || PERSONAS.tutor;

    // History summary (only if DeepDive, chunk 1, and rule says include)
    const historySummary = await computeHistorySummaryIfNeeded({
      mode,
      chunk,
      includeHistory,
      attemptId,
      uid
    });

    // --- COST CONTROL / CHUNKING LOGIC ---
    if (mode === "simple") {
      // FAST MODE: exactly ONE quick tip (2–4 sentences) + tip pager
      console.log("[AI Coach] Mode: Simple");

      const qCount = Math.max(2, Math.min(6, Number(tipCount) || 3));
      const qIndex = Math.max(0, Math.min(qCount - 1, Number(tipIndex) || 0));
      const variantKind = ["phoneme", "words", "prosody"][qIndex % 3];

      model = QUICK_MODEL;     // never reasoning for QuickTips
      maxTokens = 220;         // small output cap = faster
      targetSections = [{ title: "QuickTip", en: "string", emoji: "⚡" }];

      systemPrompt = `
${selectedPersona.role}
Tone: ${selectedPersona.style}
${persona === "drill" ? DRILL_CASING_GUARDRAILS : ""}

Write exactly 2 to 4 sentences in ONE paragraph.
No bullets. No markdown. No headings.
Structure: 1 quick praise + 1 correction + 1 micro-drill.
Stay under ~75 words.

You are generating tip variant ${qIndex + 1}/${qCount} (kind: ${variantKind}).

Return pure JSON ONLY:
{
  "sections":[{"title":"QuickTip","en":"string","emoji":"⚡"}],
  "meta":{"tipIndex":${qIndex},"tipCount":${qCount},"variantKind":"${variantKind}"}
}
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

      // Optional: let DeepDive sometimes use reasoning (but not QuickTips)
      // NOTE: This only switches models; if you want to pass reasoning_effort, do so via your chosen API surface.
      if (DEEP_REASONING_MODEL && String(DEEP_REASONING_MODEL).trim()) {
        const worthIt = (Number(chunk) || 1) >= 2 || !!historySummary;
        if (worthIt) {
          model = String(DEEP_REASONING_MODEL).trim();
          console.log(`[AI Coach] DeepDive upgraded to reasoning model (effort=${DEEP_REASONING_EFFORT})`);
        }
      }

      systemPrompt = `
        ${selectedPersona.role}
        Tone: ${selectedPersona.style}
        ${persona === "drill" ? DRILL_CASING_GUARDRAILS : ""}
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

      // Optional history injection for DeepDive (kept compact)
      history: historySummary || undefined,
    });

    const draft = await openai.chat.completions.create({
      model, // QUICK_MODEL for simple, DEEP_MODEL (or optional reasoning) for deep
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

    // Translate (skip for QuickTips)
    if (mode !== "simple") {
      await translateMissing(finalSections, langCode);
    }

    return res.status(200).json({
      sections: finalSections,
      meta: {
        mode,
        chunk: Number(chunk) || 1,
        tipIndex: Number(tipIndex) || 0,
        tipCount: Number(tipCount) || 3,
        usedModel: model
      }
    });

  } catch (err) {
    console.error("[pronunciation-gpt] Fatal Error:", err);
    return res.status(200).json({
      fallbackSections: [{ title: "Error", en: "Could not generate feedback.", emoji: "⚠️" }]
    });
  }
}
