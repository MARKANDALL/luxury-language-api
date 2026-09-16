// lib/scan-timing.js
// Per-phase stopwatch for the I SPY scan, so "the cold load takes ~50 seconds"
// becomes a table saying WHICH call took them.
//
// AsyncLocalStorage rather than a timer threaded through every signature: the
// crop checks run inside a worker pool several frames below the handler, and
// passing a timer down to them would mean changing the shape of every function
// between here and there to measure something. The store follows the async
// context on its own.
//
// Spans record absolute start and end, not just a duration, because the whole
// question in v8 is what OVERLAPS. A phase whose calls total 30s of model time
// but occupies 6s of wall clock is working correctly; one whose total and its
// wall clock are the same number is serial, and that is the bug.

import { AsyncLocalStorage } from "node:async_hooks";

const als = new AsyncLocalStorage();

/** On unless explicitly silenced, so a slow scan in the wild leaves evidence. */
function enabled() {
  return process.env.LUX_SCAN_TIMING !== "0";
}

/**
 * Run `fn` with a fresh span collector bound to it. Returns whatever fn returns.
 */
export function withTiming(label, fn) {
  if (!enabled()) return fn();
  return als.run({ label, t0: Date.now(), spans: [] }, fn);
}

/**
 * Run `fn` with every span inside it named `<prefix>.<name>`.
 *
 * A nested store rather than a mutable prefix on the current one, because in
 * v8 the top-up is meant to run CONCURRENTLY with the first pass: a single
 * mutable prefix would relabel the first pass's still-open crop checks as
 * top-up work the moment the top-up started, and the table would lie about
 * exactly the thing it was built to show.
 */
export function withPhase(prefix, fn) {
  const store = als.getStore();
  if (!store) return fn();
  return als.run({ ...store, prefix: store.prefix ? `${store.prefix}.${prefix}` : prefix }, fn);
}

/** Open a span; call the returned function to close it. Safe with no store. */
export function span(name) {
  const store = als.getStore();
  if (!store) return () => {};
  name = store.prefix ? `${store.prefix}.${name}` : name;
  const start = Date.now();
  let closed = false;
  return (note) => {
    if (closed) return;
    closed = true;
    store.spans.push({ name, start, end: Date.now(), note });
  };
}

/** Time an awaited call in one expression. */
export async function timed(name, fn) {
  const end = span(name);
  try {
    return await fn();
  } finally {
    end();
  }
}

/**
 * Roll the spans up by name and print. `total` is model/CPU time summed across
 * calls; `wall` is the clock time the group actually occupied. total >> wall
 * means the group ran concurrently, which is the whole point of the exercise.
 */
export function report(extra = "") {
  const store = als.getStore();
  if (!store || !store.spans.length) return null;
  const groups = new Map();
  for (const s of store.spans) {
    const g = groups.get(s.name) || { name: s.name, n: 0, total: 0, first: Infinity, last: 0, max: 0 };
    g.n += 1;
    g.total += s.end - s.start;
    g.max = Math.max(g.max, s.end - s.start);
    g.first = Math.min(g.first, s.start);
    g.last = Math.max(g.last, s.end);
    groups.set(s.name, g);
  }
  const rows = [...groups.values()].sort((a, b) => a.first - b.first);
  const overall = Date.now() - store.t0;
  const lines = rows.map((g) => {
    const wall = g.last - g.first;
    return (
      `  ${g.name.padEnd(22)} n=${String(g.n).padStart(2)}  ` +
      `total=${String(g.total).padStart(6)}ms  wall=${String(wall).padStart(6)}ms  ` +
      `max=${String(g.max).padStart(5)}ms  @+${String(g.first - store.t0).padStart(6)}ms`
    );
  });
  const text =
    `[scan-timing] ${store.label} ${overall}ms${extra ? ` ${extra}` : ""}\n` + lines.join("\n");
  console.log(text);
  return { overall, rows, text, spans: store.spans, t0: store.t0 };
}

/** The raw spans, for a harness that wants to write its own table. */
export function spans() {
  return als.getStore()?.spans || null;
}
