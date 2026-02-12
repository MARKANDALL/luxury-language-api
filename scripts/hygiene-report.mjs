// scripts/hygiene-report.mjs
// One-line: Repo hygiene scanner (big files, risky sinks, TODOs) — READ-ONLY; prints a report.

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const argv = process.argv.slice(2);

// Flags:
//   --active  => ignore archive/legacy trash (actionable surface area)
//   --all     => scan everything (default)
// Root arg can be provided as the first non-flag argument.
const ACTIVE_ONLY = argv.includes("--active");
const rootArg = argv.find(a => a && !a.startsWith("--"));
const ROOT = rootArg ? path.resolve(rootArg) : process.cwd();

// Always-ignored dirs (almost always junk/noise for hygiene)
const IGNORE_DIRS = new Set([
  "node_modules", ".git",
  "dist", "build", "coverage",
  ".vercel", ".next",
  ".cache", ".turbo", ".svelte-kit", ".vite",
  "out",
  // common backend junk
  ".nyc_output", ".pnpm-store", ".yarn", ".npm"
]);

// Optionally ignore “historical” areas when you want actionable results
const ACTIVE_IGNORE_DIRS = new Set([
  "_ARCHIVE", "_OLD", "_LEGACY"
]);

const EXTS = new Set([
  ".js", ".mjs", ".cjs", ".ts", ".tsx",
  ".json", ".md",
  ".html", ".css"
]);

const PATTERNS = [
  // frontend-ish XSS sinks (still useful if you render templates / admin pages)
  { name: "innerHTML", re: /\binnerHTML\b/g },
  { name: "insertAdjacentHTML", re: /\binsertAdjacentHTML\b/g },
  { name: "outerHTML", re: /\bouterHTML\b/g },
  { name: "document.write", re: /\bdocument\.write\b/g },

  // backend-relevant “code execution / injection” sinks
  { name: "eval", re: /\beval\s*\(/g },
  { name: "new Function", re: /\bnew\s+Function\s*\(/g },
  { name: "child_process.exec", re: /\bchild_process\.exec\b/g },
  { name: "child_process.execSync", re: /\bchild_process\.execSync\b/g },
  { name: "child_process.spawn", re: /\bchild_process\.spawn\b/g },
  { name: "child_process.spawnSync", re: /\bchild_process\.spawnSync\b/g },
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

function shouldIgnoreDirName(name) {
  if (IGNORE_DIRS.has(name)) return true;
  if (ACTIVE_ONLY && ACTIVE_IGNORE_DIRS.has(name)) return true;
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

async function main() {
  const files = [];
  await walk(ROOT, files);

  const rows = [];
  const totals = Object.fromEntries(PATTERNS.map(p => [p.name, 0]));
  let todoTotal = 0;

  for (const f of files) {
    const r = rel(f);
    if (r === SELF_REL) continue;

    let text;
    try {
      text = await fs.readFile(f, "utf8");
    } catch {
      continue;
    }

    const row = {
      file: r,
      loc: loc(text),
      todo: countMatches(text, TODO_RE),
      hits: {}
    };

    for (const p of PATTERNS) {
      const n = countMatches(text, p.re);
      row.hits[p.name] = n;
      totals[p.name] += n;
    }
    todoTotal += row.todo;

    rows.push(row);
  }

  rows.sort((a, b) => b.loc - a.loc);

  const topLOC = rows.slice(0, 25);

  const bySink = (sinkName) =>
    rows
      .filter(r => (r.hits[sinkName] || 0) > 0)
      .sort((a, b) => (b.hits[sinkName] || 0) - (a.hits[sinkName] || 0))
      .slice(0, 25);

  // path smell: repeated segment like features/features
  const repeatedSeg = rows
    .map(r => r.file)
    .filter(p => /(^|\/)([^\/]+)\/\2(\/|$)/.test(p))
    .slice(0, 50);

  console.log(`\n=== Hygiene Report ===`);
  console.log(`Root: ${ROOT}`);
  console.log(`Mode: ${ACTIVE_ONLY ? "ACTIVE (ignores _ARCHIVE/_OLD/_LEGACY)" : "ALL (includes everything)"} `);
  console.log(`Files scanned: ${rows.length}\n`);

  console.log(`-- Totals --`);
  for (const [k, v] of Object.entries(totals)) console.log(`${k}: ${v}`);
  console.log(`TODO/FIXME/HACK: ${todoTotal}`);

  console.log(`\n-- Top 25 by LOC --`);
  for (const r of topLOC) {
    console.log(`${String(r.loc).padStart(5)}  ${r.file}`);
  }

  for (const p of PATTERNS) {
    const top = bySink(p.name);
    if (!top.length) continue;
    console.log(`\n-- Top files by ${p.name} usage --`);
    for (const r of top) {
      console.log(`${String(r.hits[p.name]).padStart(4)}  ${r.file}`);
    }
  }

  const todoHeavy = rows
    .filter(r => r.todo > 0)
    .sort((a, b) => b.todo - a.todo)
    .slice(0, 25);

  if (todoHeavy.length) {
    console.log(`\n-- Top files by TODO/FIXME/HACK --`);
    for (const r of todoHeavy) {
      console.log(`${String(r.todo).padStart(4)}  ${r.file}`);
    }
  }

  if (repeatedSeg.length) {
    console.log(`\n-- Path smells (repeated folder segment) --`);
    for (const p of repeatedSeg) console.log(p);
  }

  console.log(`\nDone.\n`);
}

main().catch((err) => {
  console.error("hygiene-report failed:", err);
  process.exit(1);
});
