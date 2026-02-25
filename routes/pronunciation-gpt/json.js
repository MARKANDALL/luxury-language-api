// routes/pronunciation-gpt/json.js
// ONE-LINE: JSON helpers for extracting a JSON object from model output and falling back to jsonrepair.

export function forceJson(str) {
  str = str.trim()
    .replace(/^```json?\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/, "");

  return JSON.parse(str.slice(str.indexOf("{"), str.lastIndexOf("}") + 1));
}

export function parseJsonWithRepair(raw, jsonrepairFn) {
  if (typeof jsonrepairFn !== "function") {
    throw new Error("parseJsonWithRepair requires a jsonrepair function");
  }
  return JSON.parse(jsonrepairFn(raw));
}