// scripts/hygiene-report.mjs
// One-line: Repo hygiene scanner (big files, risky sinks, TODOs) — READ-ONLY; prints a report.

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const argv = process.argv.slice(2);

// Flags:
//   (default) ACTIVE mode => ignores _ARCHIVE/_OLD/_LEGACY + skips lockfiles (actionable surface area)
//   --active    => explicit ACTIVE mode (same as default)
//   --all       => scan everything (includes historical + lockfiles)
//   --no-vendor => ignore vendor/minified assets (less noise)
//   --no-html   => exclude .html/.css (logic-only view; sometimes useful)
// Root arg can be provided as the first non-flag argument.
const FORCE_ALL = argv.includes("--all");
const ACTIVE_ONLY = !FORCE_ALL; // default ACTIVE unless --all
const NO_VENDOR = argv.includes("--no-vendor");
const NO_HTML = argv.includes("--no-html");

const rootArg = argv.find((a) => a && !a.startsWith("--"));
const ROOT = rootArg ? path.resolve(rootArg) : process.cwd();

// Always-ignored dirs (almost always junk/noise for hygiene)
const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".vercel",
  ".next",
  ".cache",
  ".turbo",
  ".svelte-kit",
  ".vite",
  "out",
  // common backend junk (harmless here; keep it)
  ".nyc_output",
  ".pnpm-store",
  ".yarn",
  ".npm",
]);

// Optionally ignore “historical” areas when you want actionable results
const ACTIVE_IGNORE_DIRS = new Set(["_ARCHIVE", "_OLD", "_LEGACY"]);

// Optional vendor/minified ignore (cuts false positives + noise)
const VENDOR_IGNORE_DIRS = new Set([
  "vendor", // e.g., public/vendor
]);

const EXTS_BASE = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".json",
  ".md",
  ".html",
  ".css",
]);

const EXTS = new Set(
  [...EXTS_BASE].filter((ext) => {
    if (!NO_HTML) return true;
    return ext !== ".html" && ext !== ".css";
  })
);

// Lockfiles dominate LOC and are usually not actionable.
// In ACTIVE mode we skip them; in --all we include them.
const LOCKFILES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "npm-shrinkwrap.json",
]);

const PATTERNS = [
  // XSS / DOM sinks
  { name: "innerHTML", re: /\binnerHTML\b/g },
  { name: "insertAdjacentHTML", re: /\binsertAdjacentHTML\b/g },
  { name: "outerHTML", re: /\bouterHTML\b/g },
  { name: "document.write", re: /\bdocument\.write\b/g },

  // code execution / injection sinks
  { name: "eval", re: /\beval\s*\(/g },
  { name: "new Function", re: /\bnew\s+Function\s*\(/g },

  // process execution (precise-only — avoids vendor false positives)
  { name: "node:child_process import", re: /\bfrom\s+["']node:child_process["']/g },
  { name: "child_process require", re: /\brequire\s*\(\s*["']child_process["']\s*\)/g },
  { name: "child_process.exec", re: /\bchild_process\.exec\b/g },
  { name: "child_process.execSync", re: /\bchild_process\.execSync\b/g },
  { name: "child_process.spawn", re: /\bchild_process\.spawn\b/g },
  { name: "child_process.spawnSync", re: /\bchild_process\.spawnSync\b/g },

  // dynamic module loading (not “bad”, but good to know)
  { name: "dynamic import(", re: /\bimport\s*\(\s*['"`]/g },
  { name: "require(", re: /\brequire\s*\(/g },

  // parsing/input hotspots
  { name: "JSON.parse(", re: /\bJSON\.parse\s*\(/g },
  { name: "formidable", re: /\bformidable\b/g },
  { name: "FormData", re: /\bFormData\b/g },

  // external calls / cost & reliability surfaces
  { name: "fetch(", re: /\bfetch\s*\(/g },
  { name: "openai.com", re: /\bapi\.openai\.com\b/g },
  { name: "openai", re: /\bopenai\b/g },
  { name: "supabase", re: /\bsupabase\b/g },

  // auth/gating & headers
  { name: "ADMIN_TOKEN", re: /\bADMIN_TOKEN\b/g },
  { name: "Authorization", re: /\bAuthorization\b/g },
  { name: "Bearer ", re: /\bBearer\b/g },
  { name: "Access-Control-Allow-Origin", re: /\bAccess-Control-Allow-Origin\b/g },
  { name: "Access-Control-Allow-Headers", re: /\bAccess-Control-Allow-Headers\b/g },
  { name: "Access-Control-Allow-Methods", re: /\bAccess-Control-Allow-Methods\b/g },
  { name: "Content-Type", re: /\bContent-Type\b/g },
  { name: "bodyParser:false", re: /\bbodyParser\s*:\s*false\b/g },

  // env/config surface (helps catch secret usage / config sprawl)
  { name: "process.env", re: /\bprocess\.env\b/g },
];

const TODO_RE = /\b(TODO|FIXME|HACK)\b/g;

// Exclude the scanner itself to avoid self-matching noise
const SELF_REL = "scripts/hygiene-report.mjs";

function countMatches(text, re) {
  const m = text.match(re);
  return m ? m.length : 0;
}

function loc(text) {
  if (!text) return 0;
  return text.split(/\r\n|\r|\n/).length;
}

function isMinifiedFile(relPath) {
  return /\.min\.(js|mjs|cjs|css)$/i.test(relPath);
}

function isHtmlLike(relPath) {
  const ext = path.extname(relPath).toLowerCase();
  return ext === ".html" || ext === ".css";
}

function shouldIgnoreDirName(name) {
  if (IGNORE_DIRS.has(name)) return true;
  if (ACTIVE_ONLY && ACTIVE_IGNORE_DIRS.has(name)) return true;

  if (NO_VENDOR && VENDOR_IGNORE_DIRS.has(name)) return true;

  if (NO_VENDOR) {
    const lowered = String(name || "").toLowerCase();
    if (lowered === "third_party" || lowered === "third-party" || lowered === "vendors") return true;
  }

  return false;
}

function shouldIgnoreFileRel(relPath) {
  const base = path.posix.basename(relPath);

  if (relPath === SELF_REL) return true;

  // Skip lockfiles only in ACTIVE (default)
  if (ACTIVE_ONLY && LOCKFILES.has(base)) return true;

  // If --no-vendor, also ignore minified files
  if (NO_VENDOR && isMinifiedFile(relPath)) return true;

  return false;
}

async function walk(dir, out) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const ent of entries) {
    const full = path.join(dir, ent.name);

    if (ent.isDirectory()) {
      if (shouldIgnoreDirName(ent.name)) continue;
      await walk(full, out);
      continue;
    }

    if (!ent.isFile()) continue;

    const ext = path.extname(ent.name).toLowerCase();
    if (!EXTS.has(ext)) continue;

    out.push(full);
  }
}

function rel(p) {
  return path.relative(ROOT, p).replaceAll("\\", "/");
}

function fmtBytes(n) {
  const v = Number(n || 0);
  if (!Number.isFinite(v) || v <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let x = v;
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i++;
  }
  const rounded = i === 0 ? String(Math.round(x)) : x.toFixed(x < 10 ? 2 : 1);
  return `${rounded} ${units[i]}`;
}

async function main() {
  const files = [];
  await walk(ROOT, files);

  const rows = [];
  const totals = Object.fromEntries(PATTERNS.map((p) => [p.name, 0]));
  let todoTotal = 0;

  for (const f of files) {
    const r = rel(f);
    if (shouldIgnoreFileRel(r)) continue;

    let text;
    let bytes = 0;

    try {
      const stat = await fs.stat(f);
      bytes = Number(stat.size || 0);
    } catch {
      // ignore stat failures
    }

    try {
      text = await fs.readFile(f, "utf8");
    } catch {
      continue;
    }

    const row = {
      file: r,
      loc: loc(text),
      bytes,
      todo: countMatches(text, TODO_RE),
      hits: {},
    };

    for (const p of PATTERNS) {
      const n = countMatches(text, p.re);
      row.hits[p.name] = n;
      totals[p.name] += n;
    }

    todoTotal += row.todo;
    rows.push(row);
  }

  const bySink = (sinkName) =>
    rows
      .filter((r) => (r.hits[sinkName] || 0) > 0)
      .sort((a, b) => (b.hits[sinkName] || 0) - (a.hits[sinkName] || 0))
      .slice(0, 25);

  // path smell: repeated segment like features/features
  const repeatedSeg = rows
    .map((r) => r.file)
    .filter((p) => /(^|\/)([^\/]+)\/\2(\/|$)/.test(p))
    .slice(0, 50);

  const rowsByLOC = [...rows].sort((a, b) => b.loc - a.loc);
  const rowsByBytes = [...rows].sort((a, b) => b.bytes - a.bytes);

  const htmlRows = rows.filter((r) => isHtmlLike(r.file));
  const nonHtmlRows = rows.filter((r) => !isHtmlLike(r.file));

  const topLOC = rowsByLOC.slice(0, 25);
  const topBytes = rowsByBytes.slice(0, 25);

  const topLOC_Html = [...htmlRows].sort((a, b) => b.loc - a.loc).slice(0, 25);
  const topLOC_NonHtml = [...nonHtmlRows].sort((a, b) => b.loc - a.loc).slice(0, 25);

  const topBytes_Html = [...htmlRows].sort((a, b) => b.bytes - a.bytes).slice(0, 25);
  const topBytes_NonHtml = [...nonHtmlRows].sort((a, b) => b.bytes - a.bytes).slice(0, 25);

  console.log(`\n=== Hygiene Report ===`);
  console.log(`Root: ${ROOT}`);
  console.log(
    `Mode: ${
      ACTIVE_ONLY
        ? "ACTIVE (default; ignores _ARCHIVE/_OLD/_LEGACY + skips lockfiles)"
        : "ALL (includes everything)"
    }${NO_VENDOR ? " + NO_VENDOR" : ""}`
  );
  console.log(`HTML/CSS: ${NO_HTML ? "EXCLUDED (--no-html)" : "INCLUDED (see split lists below)"}`);
  console.log(`Files scanned: ${rows.length}\n`);

  if (!NO_HTML) {
    console.log(`NOTE: Hygiene is mainly for actionable code hotspots (big logic files, risky sinks, TODO clusters).`);
    console.log(`      HTML/CSS are included because they matter (UI bloat/XSS surface), but they can dominate top lists.`);
    console.log(`      Use the split lists to keep your focus.\n`);
  }

  console.log(`-- Totals --`);
  for (const [k, v] of Object.entries(totals)) console.log(`${k}: ${v}`);
  console.log(`TODO/FIXME/HACK: ${todoTotal}`);

  console.log(`\n-- Top 25 by LOC (ALL) --`);
  for (const r of topLOC) console.log(`${String(r.loc).padStart(5)}  ${r.file}`);

  console.log(`\n-- Top 25 by BYTES (ALL) --`);
  for (const r of topBytes) console.log(`${fmtBytes(r.bytes).padStart(9)}  ${r.file}`);

  if (!NO_HTML) {
    console.log(`\n-- Top 25 by LOC (NON-HTML/CSS) --`);
    for (const r of topLOC_NonHtml) console.log(`${String(r.loc).padStart(5)}  ${r.file}`);

    console.log(`\n-- Top 25 by LOC (HTML/CSS) --`);
    for (const r of topLOC_Html) console.log(`${String(r.loc).padStart(5)}  ${r.file}`);

    console.log(`\n-- Top 25 by BYTES (NON-HTML/CSS) --`);
    for (const r of topBytes_NonHtml) console.log(`${fmtBytes(r.bytes).padStart(9)}  ${r.file}`);

    console.log(`\n-- Top 25 by BYTES (HTML/CSS) --`);
    for (const r of topBytes_Html) console.log(`${fmtBytes(r.bytes).padStart(9)}  ${r.file}`);
  }

  for (const p of PATTERNS) {
    const top = bySink(p.name);
    if (!top.length) continue;
    console.log(`\n-- Top files by ${p.name} usage --`);
    for (const r of top) console.log(`${String(r.hits[p.name]).padStart(4)}  ${r.file}`);
  }

  const todoHeavy = rows
    .filter((r) => r.todo > 0)
    .sort((a, b) => b.todo - a.todo)
    .slice(0, 25);

  if (todoHeavy.length) {
    console.log(`\n-- Top files by TODO/FIXME/HACK --`);
    for (const r of todoHeavy) console.log(`${String(r.todo).padStart(4)}  ${r.file}`);
  }

  if (repeatedSeg.length) {
    console.log(`\n-- Path smells (repeated folder segment) --`);
    for (const p of repeatedSeg) console.log(p);
  }

  console.log(`\nTips:`);
  console.log(`  - Default is ACTIVE mode. Use --all to include everything.`);
  console.log(`  - Use --no-vendor to cut vendor/minified noise.`);
  if (!NO_HTML) console.log(`  - Use --no-html for a logic-only scan.`);
  console.log(`  - You can pass a root path: node scripts/hygiene-report.mjs C:\\dev\\LUX_GEMINI`);
  console.log(`\nDone.\n`);
}

main().catch((err) => {
  console.error("hygiene-report failed:", err);
  process.exit(1);
});
