/* =============================================================================
   FILE: routes/tts/ssml.js
   ONE-LINE: Pure SSML/string helpers for TTS (no network, no env, no side effects).
============================================================================= */

const STYLE_ALIASES = {
  "customer-service": "customerservice",
  customerservice: "customerservice",
  assistant: "chat",
  // newscast variants tried below
  newscaster: "newscast",
  news: "newscast",
};

export function normalizeStyle(s) {
  if (!s) return "";
  const t = String(s).trim();
  return STYLE_ALIASES[t] || t;
}

export function buildProsody(openRatePct, openPitchSt) {
  const r = Number.isFinite(openRatePct) ? Math.round(openRatePct) : 0;
  const p = Number.isFinite(openPitchSt) ? Math.round(openPitchSt) : 0;
  const rateAttr = r === 0 ? "" : ` rate="${r > 0 ? `+${r}%` : `${r}%`}"`;
  const pitchAttr = p === 0 ? "" : ` pitch="${p > 0 ? `+${p}st` : `${p}st`}"`;
  if (!rateAttr && !pitchAttr) return null; // no prosody wrapper needed
  return { open: `<prosody${rateAttr}${pitchAttr}>`, close: `</prosody>` };
}

export function safeXml(s = "") {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Derive the xml:lang locale for the SSML from the Azure voice name (e.g.
// "es-MX-DaliaNeural" → "es-MX"). Every English voice stays pinned to en-US so the
// English TTS path is byte-identical to today; only a non-English (es-MX flip) voice
// adopts its own locale. Unparseable / missing voice → null (caller falls back).
export function localeFromVoice(voice) {
  const m = /^([a-z]{2}-[A-Z]{2})-/.exec(String(voice || ""));
  if (!m) return null;
  const loc = m[1];
  if (loc.startsWith("en-")) return "en-US";
  return loc;
}

export function baseSpeakTag({ voice, inner, withMstts = false, lang }) {
  // xml:lang: explicit `lang` wins; otherwise derive from the voice; default en-US.
  // English voices always resolve to en-US, so pack=en output is unchanged. The
  // es-MX flip works because the frontend sends an es-MX voice for Spanish.
  const xmlLang = lang || localeFromVoice(voice) || "en-US";
  // Put mstts on <speak> for max compatibility; keep xml:lang on both speak & voice
  const ns = withMstts
    ? `xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${xmlLang}"`
    : `xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${xmlLang}"`;
  return `<speak version="1.0" ${ns}><voice name="${voice}" xml:lang="${xmlLang}">${inner}</voice></speak>`;
}

// helper to build inner XML for a given style/role combo
export function innerFor({
  textXml,
  prosody,
  role,
  styledegree,
  styleName,
  includeRole = true,
  includeDegree = true,
}) {
  const roleAttr = includeRole && role ? ` role="${role}"` : "";
  const degreeAttr =
    includeDegree && Number.isFinite(styledegree) && styledegree > 0 ? ` styledegree="${styledegree}"` : "";
  const content = prosody ? `${prosody.open}${textXml}${prosody.close}` : textXml;
  if (!styleName) return content; // neutral path
  return `<mstts:express-as style="${styleName}"${degreeAttr}${roleAttr}>${content}</mstts:express-as>`;
}
