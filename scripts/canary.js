#!/usr/bin/env node
// scripts/canary.js
// One-line: Proves the attempt save path works end to end against production —
// POSTs one attempt, reads it back, prints one PASS or FAIL line, exits 0 or 1.
//
// WHY
// ---
// Every learner-facing number in Lux is derived from rows in lux_attempts. If
// the save path breaks, nothing on screen says so: the app keeps drawing, the
// history simply stops growing, and the loss is only visible days later when
// the Progress page is thin. This turns that silence into one line at
// breakfast.
//
// It is deliberately NOT wired to a scheduler and has no dependencies beyond
// Node 18+ built-ins, so it runs from a clean checkout with no npm install.
//
// WHAT IT CHECKS, IN ORDER
//   1. POST /api/attempt returns 200 with an id            — the write ran
//   2. GET  /api/admin-recent finds that exact id          — the row is really there
//   3. The row's summary carries the derived scores        — toSummaryFromAzure ran
//   4. The row's summary carries stats.phonemes            — the full-phoneme capture is live
//
// Step 4 is the one that can fail for a reason other than an outage: it is
// absent on a deployment older than the capture-fixes change, and the FAIL line
// says so rather than crying outage.
//
// WHAT IT LEAVES BEHIND
// One row per run, under uid "canary-probe" and passage_key "canary". They are
// real rows in the real table: they appear in the admin cohort dashboard as a
// user called canary-probe, and can be filtered out there by passage. Nothing
// deletes them — this script never removes production data.
//
// RUN IT (PowerShell, from the repo root):
//   $env:ADMIN_KEY_PRIVATE = '<the key from Vercel>'; node scripts/canary.js
//
// Optional: LUX_API_BASE to point at a preview deployment instead of production.

const BASE = (process.env.LUX_API_BASE || "https://luxury-language-api.vercel.app")
  .trim()
  .replace(/\/+$/, "");
const KEY = String(process.env.ADMIN_KEY_PRIVATE || "").trim().replace(/^["'](.*)["']$/, "$1");
const UID = "canary-probe";
const PASSAGE = "canary";
const TIMEOUT_MS = 20000;

// A fixed, tiny Azure result in the FLAT shape routes/attempt.js reads. /eɪ/
// twice at 55 and 75 is the point: it makes the derived summary checkable —
// lows must hold the 55, and stats.phonemes must hold occ 2, avg 65, low 2.
const AZURE = {
  RecognitionStatus: "Success",
  Offset: 500000,
  Duration: 9000000,
  DisplayText: "ray day",
  NBest: [
    {
      Confidence: 0.95,
      Lexical: "ray day",
      Display: "ray day",
      PronScore: 79,
      AccuracyScore: 79,
      FluencyScore: 88,
      CompletenessScore: 100,
      Words: [
        {
          Word: "ray",
          Offset: 500000,
          Duration: 4000000,
          AccuracyScore: 75,
          ErrorType: "None",
          Phonemes: [
            { Phoneme: "ɹ", Offset: 500000, Duration: 2000000, AccuracyScore: 95 },
            { Phoneme: "eɪ", Offset: 2500000, Duration: 2000000, AccuracyScore: 55 },
          ],
        },
        {
          Word: "day",
          Offset: 4500000,
          Duration: 4000000,
          AccuracyScore: 83,
          ErrorType: "None",
          Phonemes: [
            { Phoneme: "d", Offset: 4500000, Duration: 2000000, AccuracyScore: 90 },
            { Phoneme: "eɪ", Offset: 6500000, Duration: 2000000, AccuracyScore: 75 },
          ],
        },
      ],
    },
  ],
};

const stamp = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");

// Exactly one line, then out. The failure is named IN the line, because a line
// that only says FAIL sends you to the logs, which is the thing this exists to
// spare you.
function finish(ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${stamp()}  attempt-save  ${BASE}  ${detail}`);
  process.exit(ok ? 0 : 1);
}

async function call(path, init) {
  const url = `${BASE}${path}`;
  let res;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    const why = e?.name === "TimeoutError" ? `no response in ${TIMEOUT_MS / 1000}s` : String(e?.message || e);
    throw new Error(`${init?.method || "GET"} ${path} did not complete — ${why}`);
  }
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(
      `${init?.method || "GET"} ${path} returned HTTP ${res.status} with non-JSON: ${text.slice(0, 120)}`
    );
  }
  if (!res.ok) {
    throw new Error(
      `${init?.method || "GET"} ${path} returned HTTP ${res.status} — ${JSON.stringify(body).slice(0, 160)}`
    );
  }
  return body;
}

async function main() {
  if (!KEY) {
    finish(false, "ADMIN_KEY_PRIVATE is not set in this shell, so the read-back cannot authenticate");
  }

  // 1. Write.
  const posted = await call("/api/attempt", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      uid: UID,
      passageKey: PASSAGE,
      partIndex: 0,
      referenceText: "ray day",
      text: "ray day",
      sessionId: `canary-${stamp()}`,
      localTime: new Date().toISOString(),
      azureResult: AZURE,
      summary: { pron: 79, meta: { schema_version: "attempt.v2", mode: "canary" } },
    }),
  });

  if (posted?.ok !== true || !posted?.id) {
    throw new Error(`the write was accepted but returned no id — ${JSON.stringify(posted).slice(0, 160)}`);
  }
  const id = posted.id;

  // 2. Read back.
  const back = await call(`/api/admin-recent?uid=${encodeURIComponent(UID)}&limit=20`, {
    headers: { "x-admin-key": KEY },
  });

  const rows = Array.isArray(back?.rows) ? back.rows : [];
  const row = rows.find((r) => String(r?.id) === String(id));
  if (!row) {
    throw new Error(
      `POST /api/attempt returned id ${id} but the row is not in the table — ` +
        `admin-recent returned ${rows.length} row(s) for ${UID}`
    );
  }

  // 3. The derived summary.
  const summary = row.summary || {};
  if (summary.pron !== 79) {
    throw new Error(`row ${id} landed but summary.pron is ${JSON.stringify(summary.pron)}, expected 79`);
  }
  if (!Array.isArray(summary.lows) || !summary.lows.some(([p, s]) => p === "eɪ" && s === 55)) {
    throw new Error(
      `row ${id} landed but summary.lows lost the scored phonemes — got ${JSON.stringify(summary.lows)}`
    );
  }

  // 4. The full-phoneme capture.
  const ph = summary?.stats?.phonemes?.["eɪ"];
  if (!ph) {
    throw new Error(
      `row ${id} landed and scored correctly, but summary.stats.phonemes is missing — ` +
        `this deployment predates the full-phoneme capture, so Progress is still averaging the worst six`
    );
  }
  if (ph.occ !== 2 || ph.avg !== 65 || ph.low !== 2) {
    throw new Error(
      `row ${id} landed but stats.phonemes["eɪ"] is ${JSON.stringify(ph)}, expected {"occ":2,"avg":65,"low":2}`
    );
  }

  finish(true, `wrote and read back row ${id} with all 4 phonemes captured`);
}

main().catch((e) => finish(false, String(e?.message || e)));
