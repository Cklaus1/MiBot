# MiBot — Architecture Spec (design pass)

> Produced by two independent staff-architect passes run in parallel — **A**
> (join + meeting subsystems) and **B** (audio + data + cli/orchestration) — each
> instructed to read `hardening-spec.md` first and **not** restate tactical bugs, only
> name the design seam a cluster of them points at. The two passes **converged**
> independently on the same eight seams (status state-machine, per-bot capture sessions,
> the `runCli` boundary, a unified join/finalize pipeline, a single WebRTC hook source,
> heartbeat-as-liveness-truth, a calendar-ingest seam, and config threading). That blind
> convergence is the evidence the methodology's adversarial Step-2 pass exists to
> produce, so no separate blind re-review was run — instead the shared findings are
> promoted below to single cross-cutting **A-refactors (AR1–AR8)** and the divergent /
> speculative items are pruned as **NEGATIVES**.
>
> **Status:** VERIFIED. Deduped against `hardening-spec.md` (a hardening `Rn`/finding is
> referenced, never duplicated). Ranked by leverage (impact ÷ effort). Open questions
> resolved in Phase 2 (bottom).
>
> **Relationship to the hardening spec:** the hardening spec removes the ~90 line-level
> defects; this spec removes the *structural reasons those defects keep appearing*. Where
> an architectural change subsumes a hardening refactor, it says so — e.g. AR1 (unified
> join/finalize pipeline) is where R5/M15/C5 stop being three separate fixes.

---

## The one structural fact that generates most of the bugs

**MiBot has two parallel, copy-pasted meeting engines that share no contract.** The
Playwright path (`bot.ts` `joinAndRecord` → `meeting.ts` `waitForMeetingEnd`) and the
Camofox path (`bot.ts` `monitorCamofoxMeeting`, lines 403-580) independently reimplement:
join, the monitor loop, participant tracking, signal capture, active-speaker detection,
audio flush, and finalize. Every divergence between them is a bug the hardening spec
catches one instance of:

| Capability | Playwright path | Camofox path | Hardening finding(s) the divergence causes |
|---|---|---|---|
| Alone / grace exit | `meeting.ts` (buggy: M1/M9) | **absent entirely** | **M15** (records silence 4h) |
| Transcription | called (`bot.ts:215`) | **never called** | **C5** |
| Heartbeat lifecycle | interval (C3/C6) | one call in loop (`bot.ts:407`) | **D3/C6**, R1 camofox gap |
| Signal dedup | `signals.ts` (M4/M5/M10) | inline in `bot.ts:443` | **M16** (dup `isSimilar`) |
| Finalize/promote audio | `audio.ts` copy logic | inline `copyFileSync` (`bot.ts:594`) | AU10 only fixed one side |

**AR1 removes this fact.** Everything else is downstream.

---

## Cross-cutting A-refactors (ranked by leverage)

| ID | Refactor | Collapses | Subsumes hardening | Effort | Blast radius |
|----|----------|-----------|--------------------|--------|--------------|
| **AR1** | **One `MeetingSession` contract + unified join→monitor→finalize pipeline.** Extract a `BrowserBackend` interface (`join`, `pollParticipants`, `drainSignals`, `screenshot`, `flushAudio`, `close`) implemented once by Playwright and once by Camofox; the monitor loop, alone/grace gate, signal tracking, and finalize live **once** in `meeting.ts`, backend-agnostic. `bot.ts` shrinks to orchestration. | the two-engine divergence | M15, C5, R5, M16, and prevents the *next* divergence | **L** | bot.ts, meeting.ts, playbook.ts, camofox.ts |
| **AR2** | **Recording/meeting status as an explicit state machine** (module owning the enum + legal transitions), not string literals scattered across bot.ts/transcribe.ts/db.ts. Illegal transitions (e.g. terminal→failed) become impossible, not merely discouraged. | T1/C5/C7 status races | hardening R6 + OQ3 enum | **M** | new `status.ts`, bot.ts, transcribe.ts, db.ts |
| **AR3** | **Per-bot capture session objects (no module singletons).** Same seam as hardening R2, but stated as the design rule: *no meeting-scoped state lives at module scope.* Audit audio.ts/recorder.ts/webrtc-capture.ts for every `let` at module level. | AU9/C4 + future concurrency bugs | hardening R2 (identical) | **M** | audio.ts, recorder.ts, bot.ts |
| **AR4** | **`runCli()` process boundary** — one typed wrapper for every external-binary call (audioscript, deepscript, ms365-cli, gws). Owns exit-code check, JSON-shape validation, stderr surfacing, `maxBuffer`, `timeout`, and `--`-terminated argv. The *only* place the codebase shells out. | T2/T4/T6/T7/CA1/CA7 | hardening R7 (identical) | **M** | transcribe.ts, calendar.ts |
| **AR5** | **Single WebRTC hook source via `context.addInitScript`.** Same as hardening R4, stated architecturally: the injector is *one* asset injected at context creation, never re-injected per-frame per-navigation. | AU1/AU2/AU12 | hardening R4 (identical) | **M** | webrtc-capture.ts, bot.ts |
| **AR6** | **Heartbeat as the single source of liveness truth.** `heartbeat` is written in the *same DB statement* as every status transition (insert + each `updateMeetingStatus`), on both backends; `recoverStaleMeetings` is the only reader. Removes the "which statuses have heartbeats?" ambiguity behind D3/C6. | D3/D4/C6 | hardening R1 (extends: same-statement stamping) | **M** | db.ts, bot.ts, meeting.ts |
| **AR7** | **Calendar-ingest seam: `Provider → normalized Meeting[]` interface.** M365 and Google each return a `CalendarEvent`; one normalizer (URL extraction, timezone→UTC, all-day skip, dedup by join_url+time) runs once, not per-provider. Kills the per-provider divergence behind CA-findings and gives cross-provider dedup (CA4) a home. | CA2/CA4/CA5/CA6/CA8 | complements hardening R7/D6 | **M** | calendar.ts |
| **AR8** | **Config loaded + validated once, threaded as a value (light DI).** `loadConfig()` is called ad hoc in bot.ts/meeting.ts/transcribe.ts; make it load-validate-once (R10) and pass the `Config` object into `joinAndRecord`/`MeetingSession` rather than re-reading globals. Enables testing seams and removes hidden coupling. | D2/D5 re-reads | complements hardening R10 | **S** | config.ts, bot.ts, meeting.ts |

Leverage order for the build: **AR2 + AR6 first** (small, unblock the status/heartbeat
fixes many hardening items depend on), then **AR4 + AR8** (mechanical, low-risk seams),
then **AR5 + AR3** (the audio-lifecycle PR, per hardening OQ1), then **AR7**, then **AR1
last** (largest; benefits from everything above already being seams).

---

## Design findings (per subsystem, deduped against hardening)

### Join / automation
- **AD1** `playbook.ts` (515) hosts two engines (`PlaybookEngine`, `CamofoxPlaybookEngine`)
  with **no shared interface** — every action (`click`/`type`/`wait`/`goto`/`js_click`)
  is implemented twice with subtly different semantics (hardening J1/J6/J10/J11/J17 are
  all "one engine does X, the other doesn't"). **Recommend:** a `PlaybookAction`
  dispatch table behind the `BrowserBackend` interface (AR1). Effort L, blast radius:
  all join flows. Leverage: high — it's the same root as AR1.
- **AD2** `camofox.ts` `CamofoxPage` is a hand-rolled REST client with no response
  contract (hardening R8). Architecturally it should be the Camofox implementation of
  `BrowserBackend`, with `api()` as its single validated transport. Folds R8 into AR1.

### Meeting / signals
- **AD3** `meeting.ts` and the camofox loop both do participant tracking + speaker
  detection + signal capture, but `signals.ts` (`SignalTracker`) is only wired into the
  Playwright path. **Recommend:** `SignalTracker` becomes backend-agnostic (takes a
  `BrowserBackend`), used by both — deletes the inline camofox signal code (`bot.ts:426-568`)
  and its duplicate dedup/`isSimilar` (hardening M16). Under AR1.
- **AD4** The alone/grace/minHumans **policy** is tangled into the Playwright monitor
  loop (`meeting.ts:270-300`) as inline counters (the source of M1/M9). **Recommend:**
  extract a pure `LeavePolicy` (input: per-poll `{humanCount, hasLeaveButton}`; output:
  `stay | leave(reason)`) — unit-testable in isolation, used by both backends. This is
  where M1/M9/M15/M7 stop being four separate fixes. Effort M, high leverage.

### Audio
- **AD5** The audio pipeline's stages (WebRTC hook → periodic flush → ffmpeg fallback →
  finalize/choose-best) are spread across three files with module-global handoffs
  (hardening AU9/AU10). **Recommend:** an `AudioCapture` session object (AR3) that owns
  all stages and exposes `start()/flush()/stop(): CaptureResult{path,durationSec,source}`
  — finalize then picks the longer of WebRTC/ffmpeg by decoded duration (AU10) in *one*
  place used by both backends. Under AR3 + AR1.

### Data / config
- **AD6** `db.ts` (295) mixes schema, migrations, and query helpers; there is no
  migration versioning, so D6's UNIQUE index + dedupe (and any future schema change) has
  nowhere safe to live. **Recommend:** a tiny `user_version`-based migration runner
  (SQLite `PRAGMA user_version`) so schema changes are ordered and idempotent — this is
  the *critical-path gate* the build harness guards. Effort S, unblocks D6/C19 safely.
- **AD7** `config.ts` returns a bag of loosely-typed fields re-read everywhere (AR8).
  Beyond validation (R10), the design fix is **thread the value**, don't re-`loadConfig()`.

### CLI / orchestration
- **AD8** `bot.ts` at **671 lines** (CLAUDE.md documents it as "~184") is the god-module:
  orchestration + the entire camofox monitor loop + audio promotion + speaker queries.
  AR1 moves the monitor loop to `meeting.ts` and AR3 moves audio out; `bot.ts` should end
  near its documented size as a thin orchestrator. **Recommend:** after AR1/AR3, update
  CLAUDE.md's line count to reality (documentation drift is its own finding).
- **AD9** `index.ts` (CLI) contains business logic — `prioritizeMeetings` (hardening
  C11), the poll loop (C20), stale-recovery wiring. **Recommend:** move scheduling/
  prioritization into a `scheduler.ts` the CLI calls; keep `index.ts` argument-parsing +
  dispatch only. Effort M, improves testability of the watcher.

---

## NEGATIVE findings (speculative generality — do NOT build)

The methodology mandates flagging over-engineering. Both passes independently rejected:

- **N1 — No transcription-provider plugin interface.** There is exactly one provider
  chain (audioscript→deepscript). AR4's `runCli` boundary is enough; a
  `TranscriptionProvider` abstraction would be speculative. Revisit only if a second
  provider actually appears.
- **N2 — No generic "platform plugin" system beyond the three playbooks.** The JSON
  playbooks already *are* the extension mechanism for new platforms; a code-level plugin
  registry is YAGNI. AR1's `BrowserBackend` has exactly two implementations (Playwright,
  Camofox) driven by a real second use case — that one is justified; a third abstraction
  layer above it is not.
- **N3 — No event bus / message queue for signals.** Signals are captured, deduped, and
  written synchronously per meeting; an async event bus adds failure modes (the exact
  silent-drop class the hardening spec fights) for a single-operator bot. Keep it direct.
- **N4 — No dependency-injection *framework*.** AR8's "thread the config value" and AR3's
  "pass the session object" are plain constructor arguments. Do not introduce a DI
  container — it would be heavier than the whole app.
- **N5 — Do not abstract the DB behind a repository/ORM layer.** better-sqlite3 with typed
  query helpers is appropriate at this scale; AD6's migration runner is the only structural
  addition warranted.

---

## Open Questions → RESOLVED (Phase 2 canon)

- **AQ1 (AR1 blast radius vs. incremental value).** *Should the two-engine unification
  (AR1) be attempted in this pass, given it's the largest change?* **Decision: land the
  seams AR1 depends on first (AR2 status machine, AR4 runCli, AR6 heartbeat, AR3 audio
  session, AD4 LeavePolicy, AD6 migration runner), then do AR1 as the final, separate
  PR.** Each prerequisite is independently valuable and independently testable, so even if
  AR1 is deferred past this pass, the divergence bugs it targets (M15/C5) are already fixed
  tactically by the hardening spec. AR1 converts those tactical fixes into a structure that
  prevents recurrence — high value, but explicitly *last* and *optional-within-scope*.
- **AQ2 (LeavePolicy vs. per-backend loops — AD4).** **Decision: extract `LeavePolicy` as
  a pure function now**, even before AR1. It's small (M), directly unblocks M1/M9/M15/M7
  as one testable unit, and both the Playwright loop and the camofox loop can call it
  immediately. This is the single highest-leverage architectural move that doesn't require
  the full AR1 rewrite.
- **AQ3 (migration runner scope — AD6).** **Decision: minimal `user_version` runner, not a
  library.** A `MIGRATIONS: ((db)=>void)[]` array indexed by `PRAGMA user_version`, run in
  a transaction at open. Exactly enough to land D6/C19 safely and version future schema.
  This is the DB critical-path gate the Phase-3 harness must exercise.
- **AQ4 (control-channel auth — from hardening OQ7).** **Decision: capture as a tracked
  architecture item, do not build this pass.** The Unix socket is local-only and set
  `0600` by R13. If the `eval` command is ever implemented (it is not — hardening C16/OQ8
  removes it from the usage string), a per-socket auth token becomes mandatory. Logged
  here so it isn't lost; out of scope for the current build.
- **AQ5 (CLAUDE.md drift — AD8).** **Decision: update CLAUDE.md's `bot.ts` line count and
  module description as part of the AR1 PR**, since AR1 is what makes the "~184 lines"
  claim true again. Documentation is verified against reality at the tier boundary.
