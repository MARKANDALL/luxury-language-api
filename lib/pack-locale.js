// Pack/locale resolution for Azure Speech endpoints.
// Frontend persists lux.pack = "en" | "es"; backend expects the same field
// (or an explicit "lang"/"locale") on the request and maps to an Azure locale.
// Default is en-US when nothing is supplied so existing English clients keep working.

export const PACK_TO_LOCALE = {
  en: "en-US",
  es: "es-MX",
};

export const DEFAULT_LOCALE = "en-US";

export function resolveLocale(input) {
  if (!input || typeof input !== "object") return DEFAULT_LOCALE;

  const pickFirst = (v) => (Array.isArray(v) ? v[0] : v);

  // Explicit BCP-47 locale wins (e.g. "en-US", "es-MX").
  const rawLang = pickFirst(input.lang ?? input.locale);
  if (typeof rawLang === "string") {
    const lang = rawLang.trim();
    if (/^[a-z]{2}-[A-Z]{2}$/.test(lang)) return lang;
  }

  const rawPack = pickFirst(input.pack);
  const pack = typeof rawPack === "string" ? rawPack.trim().toLowerCase() : "";
  return PACK_TO_LOCALE[pack] || DEFAULT_LOCALE;
}
