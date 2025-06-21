// /api/pronunciation-gpt.js  (L1-bilingual version)

export const config = { api: { bodyParser: true, externalResolver: true } };

import { OpenAI } from "openai";
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/*──────────────── helpers ────────────────*/
const universallyHard = new Set(["θ","ð","ɹ"]);

const code2name = {
  ko:"Korean", ar:"Arabic", pt:"Portuguese", ja:"Japanese",
  fr:"French", ru:"Russian", de:"German", es:"Spanish",
  zh:"Mandarin Chinese", hi:"Hindi", mr:"Marathi", universal:"Universal"
};

const alias={dh:"ð",th:"θ",r:"ɹ"};
const norm=s=>alias[s]||s;

function worstPhoneme(res){
  const tally={};
  res?.NBest?.[0]?.Words?.forEach(w=>w.Phonemes?.forEach(p=>{
    if(p.AccuracyScore<85){
      const k=norm(p.Phoneme);
      tally[k]=(tally[k]||0)+1;
    }
  }));
  return Object.entries(tally).sort((a,b)=>b[1]-a[1])[0]?.[0]||"";
}
function worstWords(res,n=3){
  return (res?.NBest?.[0]?.Words||[])
    .filter(w=>w.AccuracyScore<70)
    .sort((a,b)=>a.AccuracyScore-b.AccuracyScore)
    .slice(0,n).map(w=>w.Word);
}

/*───────── handler ─────────*/
export default async function handler(req,res){
  res.setHeader("Content-Type","application/json; charset=utf-8");
  if(req.method==="OPTIONS"){
    res.setHeader("Access-Control-Allow-Origin","*");
    res.setHeader("Access-Control-Allow-Methods","POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers","Content-Type");
    return res.status(200).end();
  }
  if(req.method!=="POST") return res.status(405).json({error:"Only POST"});

  try{
    const { referenceText, azureResult, firstLang="" } = req.body;

    const worst   = worstPhoneme(azureResult);
    const badList = worstWords(azureResult);
    const isUniversal = universallyHard.has(worst);

    const L1name = code2name[firstLang] || firstLang || "Unspecified";
    const L1code = firstLang || "en";

    /*──── system prompt ────*/
    const systemPrompt = `
You are a top-tier American-English pronunciation coach.

Learner’s first language (L1): **${L1name}** (code: ${L1code})

OUTPUT FORMAT
1. Write EXACTLY seven markdown sections with these headings:

   ## 🎯 Quick Coaching  
   ## 🔬 Phoneme Profile  
   ## 🤝 Reassurance  
   ## 🪜 Common Pitfalls for ${L1name}  
   ## 💪 ${L1name} Super-Power  
   ## 🧠 Did You Know?  
   ## 🌍 ${L1name} Spotlight  

2. **Bilingual rule**  
   • If L1 ≠ “Universal” and L1 is recognised, write every sentence or bullet **first in ${L1name}**, then on the next line repeat it in *italic English*.  
   • If L1 is “Universal” or unknown, output only English.

3. Keep total **L1 text ≤ 180 words** (English echoes don’t count).

Content rules (same as previous version, but L1-aware):
- Quick Coaching: ≤2 tips naming ★<worst phoneme>★ & worst words.
- Phoneme Profile: 3-4 plain sentences (IPA, class, mouth cues, example).
- Reassurance: If isUniversallyDifficult → “This sound is difficult for most learners worldwide…”. Else → “Many ${L1name} speakers…”.
- Common Pitfalls for ${L1name}: 2-3 bullets typical to L1.
- ${L1name} Super-Power: 1-2 sentences about any pronunciation advantage this L1 grants.
- Did You Know?: ≤2 fun facts.
- ${L1name} Spotlight: ≤20-word fact about ${L1name} or its phonetics.
`.trim();

    /*──── user message ────*/
    const userMsg = `
JSON:
{
  "firstLang"            : "${L1name}",
  "worstPhoneme"         : "${worst}",
  "worstWords"           : ${JSON.stringify(badList)},
  "sampleText"           : ${JSON.stringify(referenceText)},
  "isUniversallyDifficult": ${isUniversal}
}
`.trim();

    const completion = await openai.chat.completions.create({
      model:"gpt-4o",
      temperature:0.7,
      max_tokens:550,
      messages:[
        {role:"system",content:systemPrompt},
        {role:"user",content:userMsg}
      ]
    });

    res.status(200).json({feedback:completion.choices[0].message.content});
  }catch(err){
    console.error("pronunciation-gpt error:",err);
    res.status(500).json({error:"AI feedback failed"});
  }
}
