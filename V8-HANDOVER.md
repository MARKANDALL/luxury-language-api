# I SPY v8 — handover after Stage A (partial)

Written because the context ran long mid-Stage-A. Everything below is measured,
not estimated. Both branches are pushed and green.

- frontend `feat/image-vocab-game` → `62cb2a38`
- backend `feat/image-vocab-game` → `8446046`

## Lane state

Both worktrees clean, on `feat/image-vocab-game`, tips matching origin. Ports
3004 (backend) and 5593 (frontend) were free — no stale v7 holders to kill.
3006/5495 untouched. The frontend dev server was never needed and never started:
all of Stage A so far is backend.

**Measurement harness** (untracked, in `.scratch/v8/`):

```bash
node .scratch/v8/serve.mjs 3004          # mounts routes/ on :3004, loads .env
```

```bash
node .scratch/v8/mkbody.mjs networking-1 C2 en > .scratch/v8/body.json && node .scratch/probe.mjs .scratch/v8/body.json
```

`mkbody.mjs` mints a **fresh imageKey per run**, so every measurement is a cold
scan and never a cache hit. It reads the frontend's own stills, so
`networking-1` is the C2 picture from the playtest. Restart the server between
levers — it deliberately does not hot-reload, because the first cut cache-busted
the route but not the libs it imports and measured a half-reloaded tree.

## Keepsake dependency — resolved at Stage 0, as asked

The branch **was** cut before the keepsake work merged. Main was 14 commits
ahead (frontend) and 4 (backend), and that gap held the entire feature. The
merge was clean in both repos and was taken at Stage 0 rather than discovered at
Stage E. Stage E's save path is now present: `routes/keepsakes-upload.js`,
`keepsakes-set.js`, `keepsakes-promote.js`, `features/progress/keepsake-album/`.

## Test state

Backend `npx vitest run`: **3 failures**, all `coach-page.knowledge.test.js`,
Windows path separators. Frontend: **3 failures** (`convo-core`,
`_api/coach-page`, `_api/util`) plus **7 files vitest cannot load** because they
are `node --test` suites run by `npm run test:ear`. All six failures confirmed
pre-existing against the pre-merge tip. The route's own contract suite is
**100/100**.

## What shipped

| commit | what |
|---|---|
| `420a147` | Stage 0 — a stopwatch on every phase (`lib/scan-timing.js`) |
| `132e340` | Source written once; twelve targets instead of eight |
| `8446046` | Cheaper judge measured and turned down; seam kept |

## Measured, cold, fresh key

| scene | v7 | now | note |
|---|---|---|---|
| networking-1 (the C2 playtest photo) | 22.2 s | **16.4 s** | −26 % |
| networking-2 | 30.0 s | **25.7 s** | −14 %, top-up eliminated |
| calling-1 | 30.3 s | not re-measured | |

**The 15 s bar is not met.** Full Stage 0 table and per-lever numbers:
`.scratch/v8/stage0-latency.md`.

## Verdict on each planned speed lever

| # | lever | verdict |
|---|---|---|
| 1 | Parallelize crop checks | **already done in v7.** `pooled(jobs, VERIFY_CONCURRENCY)` — 5,521 ms of model time inside 1,327 ms of wall clock. Raised the cap 6 → 12 for the bigger pool. Crop checks are ~12 % of the wait, never the bulk. |
| 2 | Overlap the top-up | **moot.** Over-generating stopped it firing. It could not have been overlapped anyway — it is causally downstream, it only knows what to ask for after verification says what survived. |
| 3 | Cheaper model for binary judgments | **tried, measured, rejected.** See below. |
| 4 | Shrink payloads | **done** for the crop path. |
| 5 | First-playable serving | **not started** — this is the one that matters most now. |
| 6 | Prefetch on lightbox open | not started |
| 7 | The notify pattern | not started |

### Why nano was turned down

Nano is faster — enumeration 8.1→6.2 s, crop checks 3.5→1.4 s wall, about 3 s off
a 25.7 s scan. It is also stricter: on both scenes it kept **5 targets where mini
kept 6**, twice each. One target is not noise when the floor is five — a pool on
the floor is one bad crop from firing the 13 s top-up. networking-1 measured
**16.4 s on mini and 35.6 s on nano** for exactly that reason. Three seconds
saved, thirteen risked, and the risk landed. `pickCheckModel()` is the seam;
`LUX_AI_CHECK_MODEL` re-tests it without a code change.

## Where the remaining time is, and the one change that fixes it

After the levers above, a 22.7 s scan is:

| phase | time | share |
|---|---|---|
| **generate** | 14.0 s | **62 %** |
| **enumerate** | 6.2 s | **27 %** |
| crop checks (wall) | 1.4 s | 6 % |
| everything else | ~1 s | 5 % |

Two calls are 89 % of the wait, and no amount of concurrency touches either —
they are one call each, on the critical path, emitting a lot of tokens.

**The fix is to split generation.** Today one call produces, for each of twelve
targets: label, box, every instance's box, point, cloze, four choices, aliases,
an optional regional note, a riddle, and a difficulty. That is ~2,000 output
tokens, and it is paid **for all twelve targets before anything knows which ones
survive** — crop verification then drops about half. We are writing clozes,
distractors and riddles for targets that get thrown away.

Split it into:

1. **LOCATE** — all the existing selection rules (band, concrete, spread out,
   visually unambiguous, no surfaces, no person's body) plus the box rules and
   the COUNT CHECK, returning only `label`, `box`, `boxes`, `point`,
   `difficulty`. ~35 tokens per target instead of ~165. Estimated **~4 s**.
   Because the count check lives here, **this call absorbs what
   `enumerateInstances` does**, and the separate 6–8 s enumeration call goes
   away entirely.
2. **Crop verification** — unchanged.
3. **ENRICH** — one call over the *survivors* only, returning `cloze`,
   `choices`, `aliases`, `americanNote`, `riddle`. ~6 survivors, estimated
   **~5 s**, and it can be split in two parallel halves if that is not enough.

Estimated cold total **~12 s**, under the bar. And it makes **first-playable
serving** natural rather than bolted on: locate → crop-check → enrich the first
3 → **serve at ~7 s** → enrich and verify the rest into the follow-up request.

`sanitizeTarget` must be split to match — label/box/point/band rules at locate
time, cloze/choices/aliases validation at enrich time. That is the fiddly part;
today one function validates all of it and drops a target for missing any of it.

The contract suite supports this. Its model mock dispatches on message
**content** via `kindOf(req)`, not on call order, so a new `"enrich"` kind is an
extension rather than a rewrite. Tests that will need updating: `happy path: one
vision call…`, `sends the image as a vision content part at temperature 0`,
`LUX_AI_VISION_MODEL wins the model chain`.

## Note for Stage B

`MAX_TARGETS` is already **12** — Stage B's "raise the pool cap to ~12 using
Stage A's cheaper parallel checks" is half-done, and it was taken early because
the speed mission and the variety mission wanted the identical edit. The
remaining Stage B work (played-word history, disjoint mode deals, exclude lists
through generation and top-up) is untouched.

## Not started

Stages B, C, D, E, F, G, H, I.
