// routes/pronunciation-gpt/translate.js
// ONE-LINE: Translation helper for section L1 fields using OpenAI mini model (JSON in/out).

export async function translateMissing({ openai, forceJson, langs, TRANSLATE_MODEL, isEs = false }, arr, lang) {
  const need = arr.filter((s) => !s.l1);
  if (!need.length || lang === "universal") return;

  console.log(`[AI Coach] Translating ${need.length} sections to ${lang}...`);

  // es-MX flip: the source strings are Spanish when coaching Spanish. Label the
  // source accurately so the model translates from the right language. When
  // !isEs this is byte-identical to the original "English strings" prompt.
  const sourceLangName = isEs ? "Mexican Spanish" : "English";
  const prompt = `Translate these ${sourceLangName} strings into *${langs[lang] || lang}*. Return JSON object { "items": ["..."] }.`;
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