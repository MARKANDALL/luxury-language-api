// api/pronunciation-gpt.js
// ------------------------------------------------------------
//  BILINGUAL PRONUNCIATION-COACH ENDPOINT
//  returns { sections:[ … ] }  for the front-end
// ------------------------------------------------------------

export const config = { api: { bodyParser: true, externalResolver: true } };

/* ────────────────────────────────────────────────────────── */
/*  DEPENDENCIES                                             */
/* ────────────────────────────────────────────────────────── */
import { OpenAI }          from "openai";
import { countTokens }     from "gpt-tokenizer";    // simple 1-call wrapper

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ---------- constants ---------- */
const MAX_MODEL_TOKENS = { "gpt-4o": 8192, "gpt-4o-mini": 4096 };

/* ────────────────────────────────────────────────────────── */
/*  HELPER: safe max-tokens for translate model              */
/* ────────────────────────────────────────────────────────── */
function safeMax(model, prompt) {
  const used  = countTokens(prompt, model);
  const room  = MAX_MODEL_TOKENS[model] - used - 50;     // 50-token buffer
  return Math.max(100, Math.min(900, room));
}

/* ---------- pronunciation analytics helpers ---------- */
const universallyHard = new Set(["θ", "ð", "ɹ"]);
const langMap = {
  es:"Spanish", fr:"French", pt:"Portuguese", zh:"Chinese", ja:"Japanese",
  ko:"Korean",  ar:"Arabic", ru:"Russian",    de:"German",  hi:"Hindi",
  mr:"Marathi", universal:"Universal", "":"Universal"
};
const alias = { dh:"ð", th:"θ", r:"ɹ" };
const norm  = (s) => alias[s] || s;

function worstPhoneme(json) {
  const tally = {};
  json?.NBest?.[0]?.Words?.forEach(w =>
    w.Phonemes?.forEach(p => {
      if (p.AccuracyScore < 85) {
        const k = norm(p.Phoneme);
        tally[k] = (tally[k] || 0) + 1;
      }
    })
  );
  return Object.entries(tally).sort((a,b)=>b[1]-a[1])[0]?.[0] || "";
}

function worstWords(json, n = 3) {
  return (json?.NBest?.[0]?.Words || [])
    .filter(w => w.AccuracyScore < 70)
    .sort((a,b)=>a.AccuracyScore - b.AccuracyScore)
    .slice(0,n)
    .map(w=>w.Word);
}

/* ---------- section spec ---------- */
const sectionMeta = [
  { emoji:"🎯", en:"Quick Coaching",   min:80, max:120 },
  { emoji:"🔬", en:"Phoneme Profile",  min:70, max:110 },
  { emoji:"🪜", en:"Common Pitfalls",  min:80, max:120 },
  { emoji:"⚖️", en:"Comparisons",      min:90, max:130 },
  { emoji:"🌍", en:"Did You Know?",    min:80, max:130 },
  { emoji:"🤝", en:"Reassurance",      min:40, max: 70 }  // shorter encouragement
];

/* ────────────────────────────────────────────────────────── */
/*  MAIN HANDLER                                             */
/* ────────────────────────────────────────────────────────── */
export default async function handler(req, res) {

  /* ----- CORS ----- */
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type");
  res.setHeader("Content-Type","application/json; charset=utf-8");
  if (req.method==="OPTIONS") return res.status(200).end();
  if (req.method!=="POST")    return res.status(405).json({ error:"Only POST allowed" });

  try {
    /* ----- inputs ----- */
    const { referenceText, azureResult, firstLang = "" } = req.body;
    const langCode  = firstLang.trim().toLowerCase();
    const l1Label   = langMap[langCode] || "Universal";

    const worst      = worstPhoneme(azureResult);
    const badWords   = worstWords(azureResult);
    const universal  = universallyHard.has(worst);

    /* ----- build prompts ----- */
    const rangesStr = sectionMeta
      .map((s,i)=>`${i+1}. ${s.emoji} ${s.en} — ${s.min}-${s.max} EN words`).join("\n");

    const systemPrompt = `
You are the world's leading bilingual pronunciation coach.

Output EXACTLY:
{
  "sections":[
    {"title":"","titleL1":"","en":"","l1":""}
  ]
}

Provide 6 sections *in this order*:
${rangesStr}

• "title":   emoji + English title (fixed)
• "titleL1": title translated to learner’s L1 (no emoji)
• "en":      English advice — respect word-limits above
• "l1":      same advice translated to learner’s L1 (leave blank if Universal)

Respond in pure JSON. NO code fences, NO markdown. `.trim();

    const userPrompt = JSON.stringify({
      worstPhoneme: worst,
      worstWords : badWords,
      sampleText : referenceText,
      universal,
      langCode,
      l1Label
    });

    /* =====================================================
       MODEL A ─ generate full English + L1 draft
       ===================================================== */
    const draft = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.6,
      max_tokens: 1800,
      response_format:{ type:"json_object" },
      messages: [
        { role:"system", content:systemPrompt },
        { role:"user",   content:userPrompt }
      ]
    });

    /* ----- SANITISE & PARSE JSON SAFELY ----- */
    let raw = draft.choices[0].message.content.trim();

    // 1. strip ```json fences
    if (raw.startsWith("```")) {
      raw = raw.replace(/^```[a-z]*\s*/i,"").replace(/```$/,"");
    }
    // 2. replace smart quotes
    raw = raw.replace(/[“”]/g,'"').replace(/[‘’]/g,"'");
    // 3. keep up to last }
    const lastBrace = raw.lastIndexOf("}");
    if (lastBrace !== -1) raw = raw.slice(0,lastBrace+1);

    let payload;
    try {
      payload = JSON.parse(raw);
    } catch (e) {
      console.error("GPT raw output failed to parse:", raw.slice(0,400));
      throw new Error("Malformed JSON from GPT.");
    }

    /* minimal sanity */
    if (!Array.isArray(payload.sections) || payload.sections.length !== 6)
      throw new Error("Invalid sections array.");

    /* =====================================================
       SUCCESS
       ===================================================== */
    return res.status(200).json({ sections: payload.sections });

  } catch (err) {
    console.error("pronunciation-gpt error:", err);
    return res.status(500).json({ error: err.message || "AI feedback failed." });
  }
}
