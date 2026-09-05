# I SPY v8 — handover, A through I complete

Everything below is measured on this machine, not estimated. Both branches are
merged with current `main`, pushed, and green apart from the six known
environmental failures.

Stages A, B, C, D are described in the previous revision of this file and in
their own commits. This revision covers E through I and the state of the lane.

## Lane

Both worktrees clean. Backend runs from `.scratch/v8/serve.mjs` (there is no
`vercel` CLI installed, so `launch.json`'s `ispy-api-3004` entry does not work as
written). Frontend runs from `launch.json`'s `ispy-vite` on 5593.

```bash
node .scratch/v8/serve.mjs 3004
```

**Restart the server between levers, and check it actually bound.** It does not
hot-reload, and `pkill -f` does NOT kill it on this machine. Kill by PID:

```bash
netstat -ano | grep ':3004.*LISTENING'
```

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
| `411d3a32` | **E, completion keepsake** | frontend |
| `bc1eab4` | **F, recap route** | backend |
| `0c56ce60` | **F, recap in the summary** | frontend |
| `0474de28` | **G, Lightning** | frontend |
| `c0ba4d0` | **H, preference list** | backend |
| `51ae0657` | **H, three ties** | frontend |
| `940c778b` | **I, keepsake carries its scan key** | frontend |

## Latency, cold, fresh key, as of the final commit

Measured through `.scratch/v8/probe-final.mjs` and `.scratch/v8/probe-ab.mjs`.
**n = 1 per cell.** These are single cold scans, not averages, and the spread
between two runs of the same scene is larger than most of the differences in
this table.

| scene | to playable | pool | note |
|---|---|---|---|
| calling-1 B1 | **11.7 s** | 3, then grows | split fired, `partial=true` |
| calling-1 B1 (bare control) | **12.7 s** | 3, then grows | split fired |
| networking-1 C2 | 33.9 s | 6 | no split: see below |
| networking-1 C2 (bare control) | 29.8 s | 4 | no split |
| networking-2 C2 | 32.0 s | 5 | no split |

Cached, key-only probe: **231 ms**, one DB read, no model call. Unchanged.

Scene recap (stage F), measured separately across four cases including en B1,
en C2, es A2 and one with no scene description at all: **0.9 to 1.3 s**, and
every case used every word it was given except one, which dropped "a hair bun".

### Why some rows say "no split"

First-playable only splits when generation LOCATES more than five targets
(`FIRST_WAVE + 1`). Below that the route serves the complete set, because
serving four and chasing one costs an extra enrich call to save nothing. That is
the pre-existing rule, unchanged by any stage here.

What varies run to run is how many things the model finds worth naming. calling-1
located enough to split on both of its runs. The two C2 networking scenes located
four to six, so they did not split and paid the top-up serially, which is exactly
the behaviour the Stage A handover already described for networking-2 and the
reason it said the remaining latency work was optional.

**Stage H's preference list is not the cause, and that was checked rather than
assumed.** `probe-ab.mjs` runs the same scene twice on a fresh key, bare and with
the list, changing nothing else: calling-1 went 12.7 s bare and 11.7 s with it,
splitting both times; networking-1 went 29.8 s bare with four targets and 33.9 s
with the list and SIX targets, which is more work done and more found, not a
regression. The earlier full-table run also sent `misses` and `exclude`, which is
why its calling-1 row disagrees with the A/B; treat the A/B as the controlled
comparison.

## What E through I added

**E, the completion keepsake.** Play every mode a picture can offer through to
its end and it offers to keep a labelled copy: the photograph with each settled
word pinned where the thing is. One tap, never automatic. It rides the existing
keepsake path as a one-image set with its own conversation id, so it appears in
the album and opens in the gallery like any other kept photo, and since stage I
it carries the scan key, pack and band as well.

**F, the spoken scene recap.** `routes/ispy-recap.js`, registered as `ispy-recap`
and admin-gated with the rest. One cheap text-only call: two sentences at the
round's band using every word found, shown in the summary, spoken through the
existing TTS path, with a replay button. Failure is soft everywhere; the box
removes itself.

**G, Lightning.** A fourth chip, sixty seconds, rapid Name It off the pool, a
streak counter and the clean-sweep star at a streak of three. Offered only when
the pool holds six or more askable targets. It writes nothing to the board or to
the played-word history, structurally.

**H, three ties.** A `prefer` list of saved and previously-missed head words,
into generation AND the top-up. Revealed words resurface first via a new `owed`
list per picture, with a prominent Add to My Words at the reveal. A found-chime
and a spotlight whoosh, synthesized, gated on the page's auto-speak setting.

**I, reconcile.** Both merges of `origin/main` were textually clean. The one real
reconciliation was the keepsake's scan key: see `940c778b`.

## Flags

| key | unset means | other value |
|---|---|---|
| `K_ISPY_PREFETCH` | scan on lightbox open | `false` to stop |
| `K_ISPY_MARKER` | the arrow | `"dot"` restores the pre-v8 marker |

`K_ISPY_PLAYED` holds the played-word history per image, and now also the `owed`
list per image.

There is no flag for Lightning, the recap, the keepsake or the sounds. The sounds
follow the existing auto-speak toggle; the other three are offers the learner can
decline by not touching them.

## Test state

Backend `npx vitest run`: **507 passing, 3 failing**, all
`coach-page.knowledge.test.js`, Windows path separators. Pre-existing.

Frontend `npx vitest run`: **956 passing, 3 failing** (`convo-core`,
`_api/coach-page`, `_api/util`) plus 7 files vitest cannot load because they are
`node --test` suites run by `npm run test:ear`. All pre-existing.

Those six failures are the same six the lane started with.

## NOT verified by eye or by ear

The browser pane in this session reports `document.hidden` and does not
composite, so nothing below has been watched or heard. Every commit says so
individually; this is the whole list in one place.

- The keepsake OFFER in the summary, and the saved copy appearing in the album.
- The scene recap: its copy, its rhythm against the rest of the summary, and the
  spoken version.
- Lightning: the chip, the draining bar, whether 700 ms is readable, whether
  sixty seconds is the right length.
- The found-chime and the spotlight whoosh. Nothing has been heard at all.
- The highlighted Add to My Words at a reveal.
- Everything already listed as unverified in stages A7, C and D.

One thing WAS looked at, by a route around the pane rather than through it: the
keepsake's label layout. `planLabels` was run over a real conversation photograph
at 520 px and 1280 px and rasterized with the repo's `sharp`, painting the same
leaders, dots, chips and type the canvas path draws. The layout in those renders
is the layout the canvas will produce, because it is the same function's output.
What that does NOT prove is the canvas engine's own glyph metrics:
`ctx.measureText` will differ a little from the rasterizer's, so a chip may be a
few pixels wider or narrower than the ones I looked at.

## Scratch files in this repo

`.scratch/` is untracked and has never been committed. Nothing in it ships.
Delete freely:

- `.scratch/v8/probe-final.mjs` — the final latency table
- `.scratch/v8/probe-ab.mjs` — the prefer-list A/B
- `.scratch/v8/probe-recap.mjs` — recap timing across four cases
- `.scratch/v8/serve.mjs`, `mkbody.mjs`, `probe-fp.mjs` — the harness, worth keeping
- everything else under `.scratch/` — earlier stages

The python scripts the previous handover listed for deletion are gone.

## What is NOT done

Nothing from the brief is outstanding. What remains is Mark's playtest, which is
the merge gate: both PRs are open and neither has been merged.
