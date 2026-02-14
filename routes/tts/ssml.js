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

export function baseSpeakTag({ voice, inner, withMstts = false }) {
  // Put mstts on <speak> for max compatibility; keep xml:lang on both speak & voice
  const ns = withMstts
    ? `xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="en-US"`
    : `xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US"`;
  return `<speak version="1.0" ${ns}><voice name="${voice}" xml:lang="en-US">${inner}</voice></speak>`;
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
