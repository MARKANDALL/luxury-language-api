# Lux Routine Fleet: A Synthesized Architecture for 27 → 100 Routines

Mark — this document is written directly to you. It is opinionated, dense, and assumes you will skim. The TL;DR is in the next paragraph; everything else justifies and operationalizes it.

**BLUF.** Your fleet is producing at a rate your attention budget cannot absorb, and the symptoms (150+ unmerged drafts, repeat findings, R16 silently broken for 8 days) are the same alert-fatigue pathology Google SRE, Charity Majors, and the CIA's PDB process all solved decades ago. Your five already-concluded principles are directionally correct but under-specified: severity tiering needs a *decision tree*, not just labels; "glanceable on top" needs a *forced word budget*; "alert quality" needs an *auto-suppression mechanism*, not just rules; auto-archive needs to be *aggressive* (Mark, your 14 days is too long — make it 72 hours for ADVISORY); brevity contracts need a *liveness probe* baked in so silent failures cannot persist. The architecture that scales to 100 is not "more routines" — it is a three-layer hierarchy (specialists → synthesizers → executive briefer) with a *single* daily human touchpoint, a 72-hour auto-close on un-promoted drafts, and meta-routines whose only job is to detect that other routines have gone quiet. Below: the framework, 13 specific changes, three copy-paste templates, the scale-tier plan, and a ranked reading list.

---

## Part 1 — Synthesized Framework

### 1.1 The diagnosis: you are running an unstaffed NOC

The Google SRE Book (Ch. 6, "Monitoring Distributed Systems") states the rule explicitly: "every page should be actionable… pages that are routinely ignored, or do not require human judgment, are a bug" (sre.google/sre-book/monitoring-distributed-systems/). Your `public/lux-popover.js:5` finding has been flagged four times with no action — by the SRE definition, that is a bug in the routine, not a fact about the code. Charity Majors's standard is harder still: Honeycomb's internal target is "no more than 1 alert a week outside of business hours" and being woken "no more than once a year" (software-engineering-unlocked.com interview with Charity Majors). You are getting ~27 routine outputs/day, so by Honeycomb's calculus your effective noise ratio is roughly 180× too high.

The deeper diagnostic from Gordo Rodriguez ("Alert Fatigue Is an Organizational Problem") applies directly: "When alerts fire frequently but nothing bad happens, people stop treating them as urgent. An alert that fires three times a week and always resolves itself trains engineers to ignore it" (gordorodriguez.com). That is exactly what `lux-popover.js:5` did to you. The fix is not better filtering downstream — it is forcing the routine to either escalate or self-suppress after N repetitions.

### 1.2 Severity is the spine — but it needs a decision tree, not labels

Your CRITICAL / HIGH / ADVISORY / INFO scheme is correct in shape. PagerDuty's published incident severity guidance (response.pagerduty.com/before/severity_levels/) and the consolidated SEV0–SEV4 frameworks (runframe.io/blog/incident-severity-levels, oneuptime.com) converge on a discriminator: **"Is there a workaround? Is the user blocked?"** Runframe's explicit rule is "The difference between SEV1 and SEV2? One question: Is there a workaround?" For a solo dev with no users on most surfaces yet, translate this to: *Does this block a shippable Lux feature, paying-user-visible regression, or future demo?* If yes → CRITICAL. If it degrades but doesn't block → HIGH. If it's a code-smell or theoretical bug → ADVISORY. If it's a metric/observation → INFO.

The Zenduty/Xurrent advice ("when in doubt, choose the lower number / higher severity and review in postmortem") is wrong for your situation because you have no postmortem cadence and your bias is already toward over-alerting. **Default the other way: when in doubt, ADVISORY.** This inverts the team-scale heuristic deliberately, because the failure mode for a one-person fleet is fatigue, not under-response.

Runframe's other rule survives translation: *"If you have a SEV5, you have too many levels. Teams end up arguing whether an issue is SEV4 or SEV5 instead of fixing it."* Your INFO tier is at risk of this — collapse INFO into "not surfaced at all; logged only" (see §1.5).

### 1.3 Agentic orchestration — and a real disagreement to resolve

There is a published, unresolved disagreement at the heart of agent-fleet design that bears directly on your architecture.

**Anthropic's position** ("How we built our multi-agent research system," anthropic.com/engineering/multi-agent-research-system, Hadfield et al. 2025): orchestrator-worker with parallel subagents, each receiving "an objective, an output format, guidance on the tools and sources to use, and clear task boundaries." Lead agent saves plan to memory before context fills. Multi-agent systems consume ~15× tokens of a single chat but win on breadth-heavy, parallelizable tasks. Effort-scaling rules embedded in orchestrator: "1 agent for simple fact-finding, 2–4 subagents for direct comparisons, more than 10 for complex research."

**Cognition's position** ("Don't Build Multi-Agents," Walden Yan, cognition.ai): parallel subagents *without shared context* produce incoherent output for tasks that require unified state — particularly code generation. Their argument is that context engineering trumps parallelism.

**LangChain's reconciliation** (blog.langchain.com/how-and-when-to-build-multi-agent-systems/): "Multi-agent systems designed primarily for 'reading' tasks tend to be more manageable than those focused on 'writing' tasks." The split is read-heavy vs. write-heavy.

**Applied to Lux:** Your R01–R04 (development hygiene), R18/R20/R25–R27 (build/maintenance) are *write-leaning* — they produce PRs. Each one needs full repo context, and they should *not* be coordinated by a synthesizer in real time (Cognition's warning applies). Your R19/R21 are *read-leaning* synthesis — they aggregate findings. These are the Anthropic-style orchestrator targets and they will scale. **Recommendation: keep your specialist routines fully independent (Cognition mode); have your synthesis layer read their outputs asynchronously (Anthropic mode). Do not let synthesizers steer specialists in-flight.**

Anthropic's other transferable rule: subagents that "spawned 50 subagents for simple queries, scoured the web endlessly for nonexistent sources, and distracted each other with excessive updates" were fixed by *explicit effort-scaling instructions in the prompt*. Your routines need the same — a stated "stop condition" (see Recommendation 4).

### 1.4 The Presidential Daily Brief: your R19 has the wrong template

This is the most useful and most under-applied analogue in your toolkit.

The PDB is built daily, six days a week, by a CIA team that reads "hundreds of intelligence reports" overnight and selects items that fit "a single page" using "Bottom Line Up Front, in which the most critical information must appear in the first sentence" (govfacts.org/government/federal/presidency/about-the-presidents-daily-brief/). Lyndon Johnson explicitly demanded "the daily brief… be limited to one page" (heritage.org). Kennedy's version, the original PICL, was designed to fit in a breast pocket because the prior format "overwhelmed Kennedy" with "massive piles of reports" (millercenter.org/issues-policy/foreign-policy/presidential-daily-briefs).

Three lessons translate directly:

1. **Hard length cap, not a soft target.** The PDB is one page per article because that constraint forces the analyst to choose. R19 should be hard-capped at, say, 400 words total — and the constraint must be in the prompt as a fail-condition, not a guideline. If R19 cannot fit findings in 400 words, that is a signal that upstream routines emitted too much.
2. **Feedback loop is the product.** Per ABC News's PDB reporting, "At 9 a.m., CIA briefers return from their White House rounds and face immediate debriefing" — what did the president ask about? This drove next-day collection. Your R19 has no equivalent. *Build one.* See Recommendation 11.
3. **BLUF is non-negotiable.** Wikipedia's BLUF entry (en.wikipedia.org/wiki/BLUF_(communication)) and the U.S. Army Effective Writing program treat conclusion-first as the standard for "rapid decision making." Every R19 article, every specialist headline, every comment leads with the action, then the why. Your single-keystroke shortcut to R19 Issue #68 is fine; what gets shown when you tap it has to be PDB-grade.

### 1.5 PKM literature: weekly review is your real scaling bottleneck

David Allen's GTD identifies the *Weekly Review* as "the master key to GTD" — the single most-cited and most-skipped practice (fortelabs.com/blog/the-weekly-review-is-an-operating-system/, Tiago Forte). Allen's two-minute rule is widely misunderstood: it is a guideline, and forum discussion shows experienced practitioners use 30-second to 10-minute variants depending on time pressure (forum.gettingthingsdone.com). For you, the relevant version is the *30-second rule during weekday processing* and *2-minute rule during weekly review*.

Tiago Forte's PARA method (Projects/Areas/Resources/Archives, fortelabs.com; get-alfred.ai/blog/para-method) maps onto your fleet better than you might guess. Your routines are *Areas* (ongoing responsibilities). Findings are *Projects* (when promoted) or *Archives* (when not promoted within 72h). The PR backlog is currently mis-categorized — those are *unprocessed inbox items*, not *active projects*. The PARA discipline is: nothing sits in "inbox" past the weekly review.

The PKM frameworks disagree on cadence: GTD insists weekly; Cal Newport's *A World Without Email* argues for batch-processing into structured "office hours" rather than daily inbox-tending. **For your 1–2 hr/evening constraint, Newport wins.** A daily R19 read-and-decide ritual of ≤10 min plus a Sunday 45-min "fleet review" beats trying to keep up day-to-day.

### 1.6 HCI — Horvitz's mixed-initiative principles still apply

Eric Horvitz's "Principles of Mixed-Initiative User Interfaces" (CHI 1999, erichorvitz.com/chi99horvitz.pdf) is the foundational HCI work for agentic systems and is still cited 27 years later. The principles relevant to you:

- **Consider the expected utility of action vs. the cost of disrupting the user.** Horvitz formalizes this with an EVRI/EVDI calculus — show information only when expected value to the user exceeds the cost of attention. For you: a routine that escalates to a "you must read this" surface should have crossed an explicit utility threshold (CRITICAL severity + actionable + novel).
- **Infer goals and provide ways for the user to invoke and terminate.** Your single-keystroke to R19 #68 is good. You should *also* have a single-keystroke kill switch ("pause all routines for 24h") and "promote this draft to ready-for-review."
- **Maintain working memory of recent interactions.** Routines should not flag the same finding the user already dismissed. Today they do.
- **Minimize the cost of poor guesses about timing.** When uncertain, default to *quiet logging*, not surfacing. This is the same principle as Charity Majors's "if you're not sure it's actionable, don't page."

### 1.7 Solo dev agent fleets — closest analogues

This is the highest-uncertainty research question, and the honest answer is: **there is no established community for what you are doing at this scale.** The closest analogues:

- **Anthropic's own Claude Code Routines documentation** (dev.to/arshtechpro/claude-code-routines-put-your-ai-agent-on-autopilot, medium.com Routines articles): canonical example is "pull the top open bug from Linear every night at 2am, attempt a fix, and open a draft PR for the team to review in the morning." Your fleet is ~27× this — well beyond documented use cases.
- **Claude Code Agent View + `/goal`** (devtoolpicks.com/blog/claude-code-agent-view-launch-indie-hackers-2026): one-screen dashboard for active sessions, Running/Blocked/Done status. Not yet a fleet orchestrator. Boris Cherny (Anthropic) is on record that "automated multi-agent coordination is in a separate product path (Claude Managed Agents, beta)."
- **Loki Mode** (dev.to/asklokesh/how-i-built-an-autonomous-ai-startup-system-with-37-agents-using-claude-code): a single solo-dev's 37-agent skill with circuit-breaker patterns and dead-letter queues — closest published analogue to your scale. Notable: the author also concluded he needed circuit breakers, retry queues, and explicit failure paths. Translate this directly: **your fleet needs a circuit breaker per routine** (suspend after N silent runs or N consecutive identical findings).
- **The indie-hacker / "AI engineer" community** (Shawn Wang / swyx, Hamel Husain) is mostly writing about single-agent workflows and evaluations, not fleets. There is no established 50+ routine playbook in public.

**Conclusion: you are at the frontier and writing your own playbook. The translation work — porting SRE and PDB practices to a one-person fleet — is the actual research deliverable.**

### 1.8 Pressure-test of your five stated principles

| Your principle | Verdict | Modification |
|---|---|---|
| 1. Severity is the spine, escalate on repeat | **Keep, sharpen** | Add explicit "workaround?" discriminator (PagerDuty). Auto-suppress after 3 repeats *unless* severity escalates. |
| 2. Glanceable on top, deep on demand | **Keep, enforce** | Add hard word/line budgets per tier. Without a hard cap (PDB-style), routines will drift verbose. |
| 3. Alert quality: novel + actionable + urgent (Honeycomb) | **Keep, operationalize** | "Novel" needs a content hash + 14-day memory. "Actionable" needs a one-line "next action" field. "Urgent" needs a deadline or auto-downgrade. |
| 4. Auto-archive forces decisions (14 days) | **Keep, but aggress** | 14 days is team-scale. For solo: ADVISORY = 72h, HIGH = 7 days, CRITICAL = no auto-close. |
| 5. Brevity contracts | **Keep, extend with liveness** | Every routine must emit a heartbeat field (`status: ok` or `status: error: <reason>`). A meta-routine watches for missing heartbeats. This is what would have caught R16. |

---

## Part 2 — 13 Specific Changes to the Fleet

Each item: **what / why+source / expected impact.**

**1. Add a heartbeat contract to every routine.**
*What:* Every routine's GitHub tracker comment must end with a line `HEARTBEAT: {timestamp} | STATUS: ok|degraded|error | LAST_OUTPUT_HASH: {sha8}`. R21 (or a new R28 "Liveness Monitor") reads heartbeats daily and flags any routine whose heartbeat is >25h old or whose last 3 hashes are identical.
*Why:* Google SRE Ch. 6 "what's broken AND why" — symptom + cause. R16 silently broken for 8 days violates this. Charity Majors: monitoring should "tell you when it has a problem" without your having to check.
*Impact:* Silent failure detection drops from 8+ days to <25h. Catches R16-class bugs immediately.

**2. Add a content-hash dedup with 14-day memory to every specialist.**
*What:* Each routine maintains a file `routines/<id>/seen.json` mapping `sha256(finding_text)` → `{first_seen, count, last_seen}`. On a hit, the routine does *not* re-comment; it increments the count silently. On count ≥3, severity escalates one tier and the comment becomes "REPEATED FINDING (3×): please action or dismiss."
*Why:* SRE Ch. 6: "we aim to be alerted on and manually solve only new and exciting problems." Your `lux-popover.js:5` repeating 4× without action is the canonical anti-pattern.
*Impact:* Eliminates repeat-finding alert fatigue. Forces decision on persistent items.

**3. Insert a "stop condition" in every routine prompt.**
*What:* Every prompt ends with `STOP CONDITION: emit at most N findings this run, ranked by severity. If more than N candidates exist, emit only the top N and append "(+X suppressed)" to the tracker comment.` Suggested N: 3 for hygiene routines, 1 for build/maintenance, 5 for meta.
*Why:* Anthropic multi-agent post: "Early agents made errors like spawning 50 subagents for simple queries… prompt engineering was our primary lever." Effort-scaling rules in prompt = production fix.
*Impact:* Caps per-night output growth. Stops the +5/night PR drift.

**4. Auto-close draft PRs by severity tier, aggressively.**
*What:* GitHub Action (`actions/stale@v9`) with severity-derived labels: `sev:advisory` → close after 72h; `sev:high` → 7d; `sev:critical` → never auto-close. Routines must label their own PRs.
*Why:* freek.dev pattern, github.com/actions/stale docs. DEV community guidance (alanwest): "be more aggressive with PR cleanup than issue cleanup. A stale PR is almost never going to get merged as-is. The code has diverged, the review context is lost."
*Impact:* Backlog plateau within 14 days. Forces "promote or lose it" decision.

**5. Convert R19 from "summary of all routines" to PDB format with hard caps.**
*What:* R19 prompt change: produce *exactly* (a) a 1-line headline (≤15 words, BLUF), (b) up to 3 "articles" of ≤80 words each, sorted by severity, (c) a one-line meta-status (`Fleet: 25/27 healthy, R16/R22 degraded`). Total cap: 400 words. If R19 cannot fit, it logs an overflow event and emits only top 3.
*Why:* PDB process — "designed to fit on a single page" (govfacts.org); Kennedy's PICL was breast-pocket-sized because longer formats "overwhelmed" him (millercenter.org). BLUF (Wikipedia, U.S. Army Effective Writing).
*Impact:* Your morning read drops from "ugh, all of this" to a 60-second scan.

**6. Add an R19 feedback loop.**
*What:* R19 reads its own previous 7 days of issue #68 comments and looks for your reactions (👍/👎/comment). Items you 👍'd → promote that *type* of finding; items you 👎'd → suppress that type for 14 days.
*Why:* PDB process: "At 9 a.m., CIA briefers return from their White House rounds and face immediate debriefing… A casual presidential question about Chinese military exercises can trigger new collection requirements" (govfacts.org). Horvitz CHI 1999: "maintain working memory of recent interactions." Your fleet has none.
*Impact:* R19 becomes adaptive. Stops surfacing things you've already decided don't matter.

**7. Add a meta-routine: R28 "Suppression Auditor."**
*What:* Weekly routine (Sundays). Reads all routines' `seen.json` files and `seen >3 with no action` events. Emits a single PR titled "Weekly suppression candidates: <N>" listing routines that should be downscoped or retired.
*Why:* SRE Ch. 6: "Will I ever be able to ignore this alert, knowing it's benign?" — codified into the system. Tiago Forte weekly review.
*Impact:* Forces fleet pruning. Without this, you accrete routines forever.

**8. Demote INFO tier from "emitted" to "logged only."**
*What:* INFO findings do not generate tracker comments at all. They go to `routines/<id>/info.log` files in the repo. R19 may read these but does not surface unless they cross to ADVISORY.
*Why:* Runframe: "If you have a SEV5, you have too many levels." Charity Majors: anything that doesn't require action isn't an alert.
*Impact:* Removes ~30–40% of surfaced noise immediately.

**9. Standardize the three-tier output template across all routines** (see Part 3).
*Why:* Anthropic multi-agent post: subagents need "an objective, an output format, guidance on the tools and sources to use, and clear task boundaries." Without identical format, R19 cannot reliably aggregate.
*Impact:* R19 quality improves; you stop having to context-switch between routine formats.

**10. Replace per-routine GitHub issues with a single fleet-wide structured log.**
*What:* At ~50 routines this becomes essential. Use a single Issue per severity tier (4 issues total) where every routine appends with a fixed schema. Tracker comments on per-routine issues become a *fallback* not the primary surface.
*Why:* SRE Ch. 6: "a large system should be designed to aggregate signals and prune outliers… [not] requiring management of many individual components." Borgmon hierarchy pattern.
*Impact:* Mobile reading becomes feasible — 4 issues to scroll, not 100.

**11. Add an explicit "ASK MARK" escalation channel.**
*What:* New label `needs:human-decision`. Routines apply this only when they would otherwise loop. R19 surfaces these at the top with the question. Limit: max 2 per day per the BLUF top of the brief; rest queue.
*Why:* Horvitz mixed-initiative principles: "minimize the cost of poor guesses… consider uncertainty about user's goals." When the routine doesn't know, it should ask, not guess and re-flag.
*Impact:* Real ambiguity surfaces; routine "thrashing" stops.

**12. Move R21's "self-scout" output into R19 directly.**
*What:* R21's conclusion ("the bottleneck is now merge throughput on stacked PRs, not scout quality") was correct and important and you saw it. But it shouldn't be a separate routine emitting parallel to R19. Make R21 a *section* of R19 ("Meta-observation:") emitted only when R21 detects a *change* from the prior week.
*Why:* Cognition warning: separate read-tier agents create coordination overhead. Anthropic guidance: have one synthesizer, not two.
*Impact:* Reduces top-of-stack noise; R21 fires only when it has something new.

**13. Pin Opus 4.7 1M-context only to the synthesizers; downgrade specialists.**
*What:* R01–R04, R18, R20, R25–R27 (specialists) → Sonnet-class. R19, R21, R28 (synthesizers/meta) → Opus 4.7 1M.
*Why:* Anthropic multi-agent post: "Multi-agent systems consume ~15× more tokens than chat" and benefit most when the *orchestrator* is more capable than the *workers*. Code With Seb (codewithseb.com): "Lead agent (Orchestrator) — Opus 4… Subagents (Workers) — Sonnet 4." Your token bill at 100 routines will not be tolerable otherwise.
*Impact:* ~3–5× cost reduction at 100-routine scale with negligible quality loss on well-scoped specialists.

---

## Part 3 — Output Templates (Copy-paste markdown skeletons)

### Template A: Specialist routine — 1-line headline (top of every routine's tracker comment)

```markdown
[SEV:CRITICAL|HIGH|ADVISORY] [R##] <≤12-word action verb headline>
```

Constraints (put in routine prompt verbatim):
```
HEADLINE RULES:
- Start with [SEV:_] tag. Use the discriminator: blocks a user/shippable feature → CRITICAL; degrades but workaround exists → HIGH; code smell or theoretical → ADVISORY; else don't emit.
- Max 12 words after the tag.
- Lead with the action verb ("Fix", "Remove", "Investigate", "Confirm").
- No file paths in headline; those go in the detail block.
- If finding is identical to one in seen.json (any time in last 14 days), DO NOT emit headline; increment count silently. On count==3, escalate one severity tier and prefix "REPEAT(3×):".
```

### Template B: Synthesizer (R19) — 30-second glance (top of Issue #68 daily)

```markdown
# Lux Daily Brief — YYYY-MM-DD

**HEADLINE:** <≤15 words, BLUF, the one thing Mark must know today>

**Fleet status:** 25/27 healthy · 2 degraded (R##, R##) · 0 silent

**Top 3 (ranked by severity):**
1. [SEV:CRITICAL] [R##] <12-word headline> → <≤8-word next action>
2. [SEV:HIGH] [R##] <12-word headline> → <≤8-word next action>
3. [SEV:HIGH] [R##] <12-word headline> → <≤8-word next action>

**Meta-observation (only if changed from last week):** <≤20 words>

**Asks for Mark (max 2):**
- [R##] <question requiring decision, ≤20 words>

**Suppressed today:** 14 (8 repeats, 4 INFO, 2 below-threshold) · See drill-down ↓
```

Hard caps in R19 prompt:
```
DAILY BRIEF RULES:
- Total length ≤400 words. If you cannot fit, emit only top 3 and log overflow.
- BLUF: first line is the single most important thing Mark needs to know.
- Each "Top 3" line: severity tag + routine ID + ≤12-word symptom + → + ≤8-word action.
- If fewer than 3 items meet HIGH or CRITICAL, do not pad with ADVISORY.
- Meta-observation only if R21's weekly delta detected a *change*. Otherwise omit.
- Asks for Mark: only when a specialist's `needs:human-decision` label fires. Max 2.
- End with suppression count for transparency.
```

### Template C: Drill-down — full detail block (in the routine's own tracker comment, below the headline)

```markdown
[SEV:HIGH] [R##] <≤12-word headline>

**Next action (≤1 sentence):** <imperative; what Mark or another routine should do>

**Evidence:**
- Location: `path/to/file.ext:LINE` (or commit sha, or URL)
- Detection: <1-sentence why this routine flagged it>
- Repeat count: <N> (first seen YYYY-MM-DD)

**Proposed fix (if specialist has one):** <link to draft PR #NNN or "none — needs human">

**Blast radius:** <1 sentence: who/what is affected>

**Confidence:** high|medium|low — <≤10-word reason>

**Dismiss this finding:** comment `/suppress R##:<hash>` for 14 days

---
HEARTBEAT: 2026-05-16T14:32:00Z | STATUS: ok | LAST_OUTPUT_HASH: a1b2c3d4
```

The HEARTBEAT line is non-negotiable for Recommendation 1. Make it a literal regex check in R28.

---

## Part 4 — Scale-Tier Plan: 27 → 50 → 100

### Tier 1: 27 → 30 routines (today through ~6 weeks out)

**Goal:** stop the bleeding. The fleet is producing more than you can absorb; fix the absorption side first, then carefully add.

**Architecture:** flat — every routine writes (file + PR + tracker comment). R19 is the only synthesizer.

**New infrastructure:**
- GitHub Action `actions/stale@v9` configured with severity-derived rules (Rec 4).
- `seen.json` file convention per routine (Rec 2).
- HEARTBEAT line in every routine prompt (Rec 1). Retro-fit existing 27 first.
- R28 "Liveness Monitor" added as 28th routine. Single job: read all heartbeats, flag silent ones in R19.
- R19 prompt rewritten per Template B with hard 400-word cap (Rec 5).
- Single-keystroke shortcut: keep R19 #68. Add second keystroke: "pause-all" (calls Anthropic Routines API to disable all triggers for 24h). Per medium.com Routines article, `/fire` endpoint is API-callable; pause is the inverse.

**What changes:** PR backlog stops growing within ~10 days; ~50% of current 150 drafts auto-close within 2 weeks at 72h advisory horizon. Silent failures detectable within 25h.

**Cost:** marginal — you're adding 1 routine, removing noise from 27.

### Tier 2: 30 → 50 routines (~3–6 months out)

**Goal:** introduce a hierarchy. At 50, flat aggregation by R19 will fail Anthropic's effort-scaling rule ("more than 10 subagents for complex research" implies multi-tier above that).

**Architecture:** two-tier. Cluster routines into 5–6 *domains* (e.g., `lux-frontend`, `lux-voice`, `lux-platform`, `career`, `meta`, `tooling`). Each domain gets a *domain synthesizer* (Sonnet-class). R19 reads only the 5–6 domain synthesizers, not the 50 leaves.

**New infrastructure:**
- Domain synthesizer routines (R-DOM-FRONTEND, etc.). Each reads its cluster's tracker comments, applies Template B at domain scale (max 100 words per domain), emits its own daily summary issue.
- Severity is now consumed by domain synthesizer; only HIGH and CRITICAL propagate to R19.
- ADVISORY findings become domain-internal — visible if you drill into the domain issue, invisible to R19.
- Fleet-wide structured log per severity (Rec 10): 4 mega-issues replacing per-routine issues for the primary read path.
- Per-routine circuit breaker (Loki Mode pattern, dev.to/asklokesh): after 3 consecutive failed runs *or* 5 consecutive identical findings, routine self-suspends and posts to R28's queue for review.
- Sunday weekly review ritual: 30–45 min, you read R28's suppression candidates and approve/reject suspensions in batch. (GTD weekly review, Forte PARA maintenance ritual.)

**What changes:** Specialist proliferation no longer translates to surfacing proliferation. Your daily attention budget stays roughly constant from 30 → 50 routines.

**Cost:** +6 synthesizer routines (~+12% routine count). Synthesizer routines run cheap because they only read structured input — small token windows.

### Tier 3: 50 → 100 routines (12 months out, your stated target)

**Goal:** make the fleet capable of running for weeks without you reading it day-to-day, while still surfacing what matters within minutes when you do open it.

**Architecture:** three-tier. Specialists (Sonnet) → Domain synthesizers (Sonnet) → Executive briefer R19 (Opus 4.7 1M). Add a parallel "alert path" that bypasses domain synthesis for true CRITICAL events.

**New infrastructure:**
- **Severity bypass channel.** CRITICAL findings post directly to a dedicated Issue (Issue #1) and also trigger an out-of-band notification (email/SMS via the Anthropic Routines API webhook). All other findings flow through the hierarchy. This is the SRE pager vs. ticket distinction (Google SRE Ch. 10 Practical Alerting): "teams send their page-worthy alerts to their on-call rotation and their important but subcritical alerts to their ticket queues."
- **R19 acquires a "skip-day" capability.** If R19 detects a low-novelty day (no HIGH/CRITICAL, <2 ADVISORY changes), it emits "QUIET DAY" headline only and stops. Charity Majors: Honeycomb targets ≤1 alert/week outside business hours; a fleet at 100 should still be quiet most days.
- **Postmortem-lite cadence.** Monthly: R28 generates a "what changed in the fleet" report — which routines were added/retired, which findings were repeatedly suppressed, which routine had highest signal-to-action ratio. SRE postmortem culture (Ch. 15), translated to solo scale: 20 min once a month.
- **Eval harness for routines themselves.** Before adding a new routine, it runs in shadow mode for 7 days — emits to a private repo, does not propagate to R19. Anthropic post: "Evaluating agents that modify persistent state across multi-turn conversations presents unique challenges" — they specifically recommend end-state evals on a fixed set of inputs. Translate: every new routine ships with 3 golden findings it should detect from a known repo state.
- **Cost governance.** Per-domain monthly token budget. Domain synthesizer suspends specialists in its cluster if budget exhausted; emits "BUDGET" event to R19.
- **Single mobile-readable surface.** On phone, you only ever read R19 + Issue #1 (CRITICAL bypass). Desktop is for drill-down.

**What changes:** You become a part-time CEO of a 100-agent NOC. Daily commitment: 5–15 minutes on quiet days, up to 1 hr when CRITICAL fires. Sunday review: 45 min. Monthly: 20 min. Total: ~2–4 hr/week of human attention on the fleet.

**Cost:** Real money begins to matter. Without Rec 13 (Sonnet specialists), this tier is likely $500–$2000/month in tokens; with it, $100–$500.

**What you should NOT do at 100:** do not try to add multi-agent in-flight coordination between specialists. Cognition's warning ("Don't Build Multi-Agents," cognition.ai) applies — specialists writing PRs need full repo context independently, not coordinated. The hierarchy is for *reading*, not for *writing*.

---

## Part 5 — Reading List, Ranked by ROI for Your Specific Situation

1. **Google SRE Book, Chapter 6: "Monitoring Distributed Systems"** — sre.google/sre-book/monitoring-distributed-systems/. *Read first. Free. ~45 min. Highest direct applicability.* The list of "questions to ask of every alert" is your routine-design checklist. The Bigtable over-alerting case study (same chapter) is your fleet's exact pathology.

2. **Anthropic, "How we built our multi-agent research system"** — anthropic.com/engineering/multi-agent-research-system. *Read second. ~30 min.* The orchestrator-worker contract (objective / output format / tool guidance / boundaries) is the prompt-engineering spec for your specialists. Effort-scaling rules and prompt-engineering lessons translate verbatim.

3. **Walden Yan / Cognition, "Don't Build Multi-Agents"** — cognition.ai/blog. *Read third, paired with #2. ~15 min.* The counter-argument. Understanding why it doesn't fully apply to your read-heavy synthesis layer (and does apply to write-heavy specialists) clarifies your architecture.

4. **Eric Horvitz, "Principles of Mixed-Initiative User Interfaces" (CHI 1999)** — erichorvitz.com/chi99horvitz.pdf. *~25 min.* The HCI foundation. Skim for the 12 principles, especially #2 (expected utility of action vs. cost of attention), #6 (working memory of interactions), #9 (timing).

5. **GovFacts, "About the President's Daily Brief"** — govfacts.org/government/federal/presidency/about-the-presidents-daily-brief/. *~20 min.* The PDB production process explained better than the CIA's own materials. The 9 a.m. debrief feedback loop is the model for your Recommendation 6.

6. **Charity Majors, "observability" essay collection** — charity.wtf/category/observability/. *Skim 2–3 essays, ~30 min.* For tone-setting more than tactics. The "1 alert/week outside business hours" benchmark calibrates your fleet's noise floor.

7. **PagerDuty Incident Response — Severity Levels** — response.pagerduty.com/before/severity_levels/. *~10 min.* Canonical reference. Pair with runframe.io/blog/incident-severity-levels for the "workaround?" discriminator.

8. **Tiago Forte, "The Weekly Review is an Operating System"** — fortelabs.com/blog/the-weekly-review-is-an-operating-system/. *~15 min.* The mechanics of a 30-minute weekly review you'll actually do. Skip the rest of Building a Second Brain for now — the weekly-review essay is the load-bearing piece for your Sunday ritual.

9. **LangChain, "How and when to build multi-agent systems"** — blog.langchain.com/how-and-when-to-build-multi-agent-systems/. *~15 min.* Reconciles Anthropic vs. Cognition explicitly. The read-vs-write distinction is the architectural pivot in your Tier 2 → Tier 3 transition.

10. **Loki Mode writeup** — dev.to/asklokesh/how-i-built-an-autonomous-ai-startup-system-with-37-agents-using-claude-code. *~20 min.* The closest published peer — a solo dev running a similar-scale fleet. Take the circuit-breaker pattern and the dead-letter-queue idea; ignore the marketing.

Skip for now: Cal Newport's books (good ideas but you've already internalized the principles), Tyler Parris's *Chief of Staff* (team-scale, doesn't translate cleanly), David Allen's GTD book in full (Forte's weekly-review essay distills the relevant 5%).

---

**Final note, Mark.** Your instinct that "severity is the spine" was correct, and your principles 1–5 are the right axes. The gap between today and a 100-routine fleet is not more discipline or more routines — it is *forcing the fleet to triage itself before it reaches you*. Build the heartbeat (Rec 1), the dedup (Rec 2), and the stale bot (Rec 4) this week. Everything else can wait for your Sunday review.