# MiBot — Autonomous Review-and-Build Prompt

> Paste the block below to drive the full review → spec → autonomous-build pipeline.
> It is grounded in MiBot's real architecture (flat `src/*.ts`, no `mihomes`, no
> gateways/tenancy). Three specs get produced in sequence, each feeding the next:
> `hardening-spec.md` (line-level bugs) → `architecture-spec.md` (design), then a
> `build-loop.md` harness builds both.

---

## Subsystem map (MiBot's real modules — use these, not invented ones)

| Subsystem | Files | Concern |
|-----------|-------|---------|
| **Join / automation** | `playbook.ts` (Playwright + Camofox engines), `camofox.ts`, `selectors.ts` | Two parallel playbook engines driving join flows |
| **Meeting lifecycle** | `meeting.ts`, `signals.ts` | Participant tracking, leave logic, speaker detection, chat/reaction/handraise/screenshare capture |
| **Audio pipeline** | `audio.ts`, `recorder.ts`, `webrtc-capture.ts` | WebRTC hook + ffmpeg recording |
| **Transcription** | `transcribe.ts` | AudioScript→DeepScript integration, speaker labeling |
| **Data / config** | `db.ts` (better-sqlite3, WAL), `config.ts` | Persistence + runtime config |
| **Calendar** | `calendar.ts` | MS365 sync, upcoming-meeting scheduling |
| **CLI / orchestration** | `index.ts` (CLI), `bot.ts` (orchestrator), `control.ts` (Unix socket), `log.ts` | Entry points, process lifecycle, live debugging |

Cross-cutting seams to watch across ALL subsystems: browser lifecycle (the
Playwright/Camofox duplication is the single biggest one), config access, logging,
error handling, DB access/transactions, and child-process / zombie management.

---

## PHASE 0 — Produce `tasks/hardening-spec.md` (line-level bug/hardening pass)

Fan out **fable** subagents, one per subsystem above, each acting as a staff engineer
hunting line-level defects — NOT design smells (those come in Phase 1). Look for:
races and unawaited promises, zombie/leaked child processes and unclosed browsers,
resource leaks (DB handles, sockets, ffmpeg), swallowed errors, missing input
validation, WAL/transaction misuse, selector-scrape crashes on missing DOM, timeout
and retry gaps, and the silent-failure class this codebase is prone to (a capture
loop that quietly stops).

For each finding: `[subsystem] file:line — the bug, the failure it causes (concrete
repro/trigger), the fix, a proposed severity (P0 blocker → P3 polish), effort (S/M/L),
and a regression-test sketch (what must fail before the fix and pass after).`

Fold all findings into `tasks/hardening-spec.md`, grouped by subsystem then severity.
Promote shared root causes to cross-cutting refactors **R1–Rn** (e.g. "unify browser
lifecycle teardown," "one error type across engines," "single child-process reaper").
End with an **Open Questions** section for anything needing a decision.

## PHASE 1 — Produce `tasks/architecture-spec.md` (design pass)

**STEP 1 — Fan out architectural review (fable, staff software architect).**
Review each subsystem in parallel with a fable subagent. **Read `hardening-spec.md`
first and do NOT duplicate its findings** — reference a hardening item where an
architectural fix subsumes the tactical one. Ground every finding in real code
(`file:line`) — no generic advice. Per subsystem, look for:

- **Dependency injection / inversion** — hardwired singletons and direct SDK/CLI
  construction (e.g. the Camofox REST client, `better-sqlite3` opened inline, ffmpeg
  spawned directly), global engine/db access, untestable seams.
- **API & boundary design** — the two playbook engines' interface (do they share a
  contract?), consistent error types across layers, CLI↔orchestrator↔module layering
  violations (fat `bot.ts`, business logic in the CLI).
- **Extensibility — YAGNI-gated.** Only where a concrete second use case already
  exists: multi-platform join (already 3 platforms), the two browser backends,
  multiple transcription providers. Flag speculative generality as a **NEGATIVE**
  finding — don't invent extension points.
- **Cohesion / coupling / duplication** — `bot.ts` at 671 lines doing orchestration +
  monitoring + speaker queries; the near-duplicate Playwright vs Camofox playbook
  engines; meeting.ts/signals.ts overlap.
- **Cross-cutting concerns** — config, logging (`log.ts`), error handling, DB access,
  browser/process lifecycle — consistent or ad hoc per module.

Per finding: `[subsystem] file:line — the design smell, why it costs us (concrete),
the recommended pattern/refactor, effort (S/M/L), blast radius.` Group by subsystem
then theme, rank by leverage (impact ÷ effort). Fold into `tasks/architecture-spec.md`.

**STEP 2 — Adversarial + gap pass (fresh fable subagents, blind to Step 1's reasoning).**
Re-review `src/` AND the drafted architecture spec together. Two jobs:
- **(a) Prune** — challenge each finding: real? is the pattern actually better here, or
  would it over-engineer MiBot (a single-operator meeting bot, not a platform)?
  Downgrade/remove false positives.
- **(b) Extend** — find higher-altitude issues visible only once the obvious ones are
  named: a missing seam several findings point at, an abstraction that collapses N
  findings into one (the browser-backend abstraction is the prime candidate).

Edit the spec in place — correct, prune, add. Promote shared root causes to single
cross-cutting refactors. Output: one verified, deduped, leverage-ranked
`architecture-spec.md`, deduped against `hardening-spec.md`.

## PHASE 2 — Resolve open questions (both specs)

For every open question / "decide later" item in either spec: enumerate ALL options,
state the recommended one with trade-offs, blast radius, and effort, write the
decision into the spec, and adopt it as canon. No open question survives unresolved.

## PHASE 3 — Author `tasks/build-loop.md` (autonomous build harness)

Design a loop system that builds BOTH specs end-to-end with no hand-holding. Define
each loop explicitly — trigger, one iteration's steps, exit condition:

- **Inner loop:** implement ONE task → write/run its regression test (must FAIL before
  the fix, PASS after) → self-review ("would a staff engineer approve?") → `npx tsup`
  build + `npx tsc --noEmit` → commit.
- **Outer loop:** pick the next ready task off the DAG (respect dependencies +
  P0→P3 sequencing + Rn-refactors-first), run the inner loop, mark done, re-evaluate
  readiness.
- **Meta loop:** after each task or on any correction/failure, append to
  `tasks/lessons.md` (mistake → rule, corrections/failures only — it must compound)
  and update the spec/DAG if reality diverged.
- **Full-suite regression loop:** after each P-tier (or every N tasks), run the ENTIRE
  `npx vitest run`, not just the new test — catch cross-task breakage at the tier
  boundary.
- **Smoke/integration loop:** once per tier, actually exercise the real thing — boot
  the CLI (`node dist/index.js config`, `... meetings`), run a control-socket command,
  and dry-run one playbook parse — this spec's silent-failure bugs won't show in unit
  tests.
- Add any other loop only if it genuinely helps (e.g. a re-plan loop when a task goes
  sideways) — justify each.

**Gates & special handling:**
- **Critical-path extra-gate (schema/DB):** any task touching `db.ts` schema or a
  migration must additionally prove the DB opens clean, a round-trip write/read
  succeeds, and existing rows still parse — everything persists through here, so if
  it's wrong the rest builds on sand.
- **Poison-task ceiling:** after 3 failed attempts, park the task as `blocked`, log
  why, continue the rest of the DAG, surface all blocked tasks in the end report.
  Autonomous must TERMINATE with a report, never spin forever.
- **Resumability:** the DAG + `todo.md` checkboxes + per-task commits ARE the resume
  mechanism — re-running the loop is idempotent (picks up incomplete, skips done).

**Graphs to include:**
- Task DAG (nodes = spec items, edges = dependencies, grouped by refactors R1–Rn).
- A per-task lifecycle state machine: `ready → in-progress → tested → committed / blocked`.
- A dependency/impact map for any DB-schema-touching change.

**Stop condition (compound — ALL must hold):**
```
DONE = every DAG node complete (or explicitly blocked-and-logged)
       AND `npx vitest run` fully green
       AND both specs have no unaddressed item
       AND the branch builds (`npx tsup`) and the CLI boots clean.
```
Per-task green is NOT sufficient — the final full-suite gate catches fix #40 breaking
fix #12. On any blocked/failing task: stop, re-plan, log to `lessons.md` — NEVER mark
done on red.

**Insight discipline (exactly three artifacts — log to files, don't narrate):**
- `tasks/lessons.md` — mistake → rule, on corrections/failures only.
- `tasks/opportunities.md` — deferred-work sink. During the build, newly-found
  OPTIMIZATIONS are logged one line each and NOT acted on (no failing test → acting
  violates the verification bar). Newly-found BUGS are captured as candidate tasks
  with proposed severity — never silently fixed outside the DAG. Sole exception: a fix
  impossible without a minimal refactor may include that refactor (as Rn anticipate).
  This file is the curated input to the NEXT loop.
- End-of-run report — built / deferred / blocked / final test status.

Mirror the task list into `tasks/todo.md` with checkable items.

## PHASE 4 — Execute (fully autonomous to completion)

Work on a branch (not `main`). Under Opus, run `/loop tasks/build-loop.md` and build
both specs to completion following the harness. Commit per task; keep `todo.md`,
`lessons.md`, `opportunities.md` current. Run until the compound stop condition holds,
then emit the end-of-run report. Do NOT stop for review at any intermediate tier —
build end-to-end.

**What this locks in:**
- Phase 0 generates the hardening spec MiBot doesn't have yet, so the architecture
  pass has something concrete to dedupe against (the original assumed it existed).
- Compound stop condition (all four clauses), not "all tasks done" — the full-suite
  gate is what catches a late fix breaking an early one.
- Poison-task ceiling so "autonomous to completion" terminates with a report.
- Full-suite regression + smoke/integration tier-loops — the latter catches MiBot's
  silent-failure class (a capture loop that quietly dies) that units miss.
- DB/schema critical-path gate replaces the original's project-specific reconciliation
  migration — `db.ts` is MiBot's everything-persists-through-here chokepoint.
- Resumability as an idempotency property riding on the DAG/todo/commit trail.
- Three-artifact insight discipline with `opportunities.md` as the deferred sink.
- No intermediate review stop — fully autonomous.
