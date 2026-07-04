// lib/expenses/fetchers/index.js
// One-line: Registry of automated expense fetchers, keyed by source slug.
//
// SHARED FETCHER CONTRACT
// -----------------------
// Each vendor module lives in one file and exports:
//
//   async function fetchSource(source) -> result
//
// `source` is the expense_sources row (id, slug, notes, ...). The result the
// refresh orchestrator understands:
//
//   {
//     ok: boolean,                 // true = a snapshot should be written
//     skipped?: boolean,           // true = intentionally wrote nothing this run
//     fetch_mode_effective: 'auto' | 'manual',  // what actually happened
//     method?: 'auto',             // snapshot.method when ok
//     amount_usd?: number | null,  // dollars for amount_usd (null = unknown)
//     period_start?: 'YYYY-MM-DD',
//     period_end?: 'YYYY-MM-DD',
//     raw?: object,                // stored verbatim in snapshot.raw
//     note?: string,               // human-readable one-liner for the UI/result
//   }
//
// A fetcher must NEVER crash the run for an expected, recoverable condition
// (e.g. a missing key). It returns { ok:false, skipped:true, fetch_mode_effective:'manual', note }
// instead. Genuinely unexpected errors may throw; the orchestrator isolates them
// per-source.
//
// Vendor modules are registered below as they land (openai, elevenlabs, ...).

import { fetchSource as openai } from "./openai.js";

const FETCHERS = {
  openai,
  // elevenlabs: registered in the ElevenLabs fetcher commit
};

export function getFetcher(slug) {
  return FETCHERS[slug] || null;
}

export function hasFetcher(slug) {
  return Boolean(FETCHERS[slug]);
}

export function registeredSlugs() {
  return Object.keys(FETCHERS);
}
