# I SPY v8 — handover after A6, A7, A8 (split half)

Everything below is measured on cold scans with a fresh image key, not
estimated. Both branches pushed and green.

- frontend `feat/image-vocab-game` → `595e6596`
- backend `feat/image-vocab-game` → `067b7b3`

## Lane

Both worktrees clean. Backend runs from `.scratch/v8/serve.mjs` (there is no
`vercel` CLI installed, so `launch.json`'s `ispy-api-3004` entry does not work
as written). Frontend runs from `launch.json`'s `ispy-vite` on 5593.

```bash
node .scratch/v8/serve.mjs 3004
```

```bash
node .scratch/v8/mkbody.mjs networking-1 C2 en > .scratch/v8/body.json && node .scratch/probe.mjs .scratch/v8/body.json
```

**Restart the server between levers, and check it actually bound.** It does not
hot-reload, and `pkill -f` does NOT kill it on this machine: one measurement in
this run was taken against a stale server that had survived a `pkill` while the
new one died on `EADDRINUSE`, and it reported the *old* pipeline's timings.
Kill by PID:

```bash
netstat -ano | grep ':3004.*LISTENING'
```

Scratch scripts to delete: `.scratch/v8/split-prompt.py`,
`split-validator.py`, `fix-tests.py`, `fix-tests2.py`, `fix-tests3.py`,
`old-prompt.txt`, `removed-enumerate.txt`.

## Commits

| commit | stage | repo |
|---|---|---|
| `420a147` | 0, stopwatch | backend |
| `132e340` | A, source once + twelve targets | backend |
| `8446046` | A, nano judged and rejected | backend |
| `a57f3f96` | A6, prefetch on lightbox open | frontend |
| `06af95f9` | A7, the notify pattern | frontend |
| `595e6596` | cameo probe fix | frontend |
| `067b7b3` | A8, locate → check → enrich | backend |

## Latency, cold, fresh key

| scene | Stage 0 | now | top-up |
|---|---|---|---|
| calling-1 B1 | 30.3 s | **15.0 s** | no |
| networking-1 C2 | 22.2 s | **17.3 s** | no |
| networking-2 C2 | 30.0 s | 33.4 s | **fired** |

Cached: sub-second, one DB read, no model call. Unchanged.

Phase shape of a clean 15 s scan (calling-1 B1): locate 5.3 s, crop checks
4.1 s wall, relocalize 1.7 s, enrich 5.2 s, DB 0.3 s.

## The one thing still in the way

**The top-up.** It costs 10–13 s, it is serial, and it fires whenever crop
verification leaves fewer than `MIN_TARGETS` (5) survivors. Every scan that hits
the bar avoids it; every scan that misses the bar is one that fired it.

Two things already tried against it, both real but neither sufficient:

- 12 located targets instead of 8 (`132e340`).
- 16 at C1/C2 (`067b7b3`), because a high band names parts and materials, and a
  stud earring's box fails a crop check far more often than a blazer's. Took
  networking-1 from 29.8 s to 17.3 s. Did **not** save networking-2, where the
  picture genuinely holds fewer nameable things and the model returns a short
  list however large a cap it is offered.

**First-playable serving is the answer to it and is NOT built.** It is the
remaining half of A8. The learner does not need the whole pool to start: three
verified targets is a round. Serve at three, let the rest arrive by follow-up,
and a top-up firing behind the scenes stops being 10 s of dead time and becomes
pool growth the learner never waits for.

Sketch, both repos:
1. Backend: once 3 targets pass their crop check, respond `{ targets, partial:
   true, scanId }` and let the rest finish. Cache the full row when it lands.
2. Backend: `GET`/`POST` follow-up on `scanId` (or the image key) returning the
   completed set.
3. Frontend: `ispy-scan.js` already owns the record and the subscribe seam.
   `startScan` would keep its promise open and announce a second time; `deals`
   grow mid-round. New pips enter with a small animation, motion law applies.

## Not started

Stages B, C, D, E, F, G, H, I. Note `MAX_TARGETS` is already 12 (16 at high
bands), so Stage B's pool-cap item is done.

## Test state

Backend `npx vitest run`: 3 failures, all `coach-page.knowledge.test.js`,
Windows path separators. Route contract suite **100/100**.

Frontend `npx vitest run`: 3 failures (`convo-core`, `_api/coach-page`,
`_api/util`) plus 7 files vitest cannot load because they are `node --test`
suites run by `npm run test:ear`. All pre-existing.

## Things found that the brief did not know

1. **The crop checks were already parallel** in v7, and were never the bulk of
   the wait.
2. **There was no heavyweight model to downgrade from**; everything ran
   `gpt-4.1-mini`. nano was measured and rejected: 3 s faster, one target
   stricter, and that one target re-fires the 13 s top-up.
3. **`cropRegion` re-decoded the whole image per crop**, synchronously, which
   was serializing the pool it ran inside.
4. **The cameo's probe never asked anything.** `fetchISpyTargets` took no
   `imageKey`, so the call returned on its `if (!src)` guard and the tease dot
   landed in its fallback corner on every picture, forever. Fixed in `595e6596`
   along with the band it probes under.
5. **rAF does not run in a hidden document**, and A7 actively invites the
   learner to switch tabs. The notify line's entrance is a forced reflow.
