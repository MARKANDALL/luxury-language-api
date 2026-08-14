# I SPY v8 — handover after A, B, C, D

Everything below is measured on cold scans with a fresh image key, not
estimated. Both branches pushed and green.

- frontend `feat/image-vocab-game` → `229f3586`
- backend `feat/image-vocab-game` → `451ea87`

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
| `30edb04` | A8b, first playable | backend |
| `18b7153b` | A8b, pool grows mid-round | frontend |
| `451ea87` | B, exclude list | backend |
| `cd60d504` | B, history + disjoint deals | frontend |
| `ba306b01` | C, mic pre-warm + level meter | frontend |
| `229f3586` | D, the arrow marker | frontend |

## Latency, cold, fresh key

| scene | Stage 0 | A8a total | **to playable** | full pool |
|---|---|---|---|---|
| calling-1 B1 | 30.3 s | 15.0 s | **13.2 s** | 17.6 s |
| networking-1 C2 | 22.2 s | 17.3 s | **15.2 s** | 31.4 s |
| networking-2 C2 | 30.0 s | 33.4 s | **13.8 s** | 33.3 s |

Cached: sub-second, one DB read, no model call. Unchanged.

First-playable's floor is locate (5-8 s) + the wave's crop checks (2-3 s) + the
wave's enrich (3-5 s). Nothing gets under that without making locate cheaper.

## The top-up, and why it stopped mattering

It still costs 10-13 s and still fires whenever crop verification leaves fewer
than `MIN_TARGETS` (5) survivors. Two caps were aimed at it: 12 located targets
instead of 8, then 16 at C1/C2 (a high band names parts and materials, and a
stud earring's box fails a crop check far more often than a blazer's). The
second took networking-1 from 29.8 s to 17.3 s. Neither saved networking-2,
where the picture holds fewer nameable things and the model returns a short list
however large a cap it is offered.

A8b is what settles it. That scan is still 33 s end to end, but the learner is
playing at 13.8 s and the top-up happens underneath them. The remaining work on
latency is optional; the wait is no longer the thing standing between a press
and a round.

## Flags added

| key | unset means | other value |
|---|---|---|
| `K_ISPY_PREFETCH` | scan on lightbox open | `false` to stop |
| `K_ISPY_MARKER` | the arrow | `"dot"` restores the pre-v8 marker |

`K_ISPY_PLAYED` holds the played-word history, per image, by head word.

## Not started

Stages E, F, G, H, I.

## Not verified by eye

Nothing visual in A7, C or D has been watched rendering: the browser pane
reports `document.hidden` and does not composite. That covers the notify line
and toast motion, the pip entrance, the microphone level meter, and the whole
appearance of the arrow marker. Each has its geometry or its DOM state checked
mechanically instead, and each commit says so.

Press-to-recording (Stage C's under-150ms target) is NOT measured: the pane
blocks microphone access, and a synthetic stream measures the harness rather
than the device. What is proven is that a press after warming makes no
getUserMedia call at all.

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
6. **The crop mock was missing `releaseSource`**, so the route threw on every
   contract-test request AFTER the response had gone out. The suite passed while
   the router logged a 500 nobody was reading.
