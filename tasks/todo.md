# MiBot — Todo

## Completed (Day 1 — 2026-03-27)
- [x] Calendar sync via ms365-cli
- [x] Teams join flow (playbook-driven)
- [x] Zoom join flow (playbook-driven, direct URL)
- [x] WebRTC audio capture with incremental flush
- [x] Signal tracking (chat, reactions, hand raises, screen share screenshots)
- [x] Participant tracking with bot detection
- [x] Speaker detection (active speaker UI scraping)
- [x] Meeting end detection (Leave button disappearing)
- [x] Metadata JSON sidecar (calendar info, participants, signals)
- [x] AudioScript transcription integration
- [x] Auto speaker labeling from participant list
- [x] Playbook engine (JSON-driven, no rebuild)
- [x] Live control channel (mibot send <id> screenshot/click/type)
- [x] Config system with validation
- [x] 6 code review rounds, 30+ bugs fixed
- [x] Test suite (27 tests, 5 suites)
- [x] Structured logging (JSON lines)
- [x] Module split (bot.ts 669→184 lines)

## Next Up (product roadmap)
- [ ] Google Meet playbook
- [ ] Audio capture on proper server (headed Chrome + PulseAudio)
- [ ] Better participant name scraping (parse from post-join text instead of DOM selectors)
- [ ] Vision-based fallback for playbook steps (screenshot → Claude → click coordinates)
- [ ] Google Calendar support (currently M365 only)
- [ ] MiNotes output adapter
- [ ] MiAction output adapter

---

# Build DAG (hardening + architecture specs) — resumable checkbox mirror

> Mirror of the DAG in `build-loop.md §6`. Check a box **only** when the task reaches
> `committed` (test failed-then-passed, `tsup` + `tsc` clean, commit landed). This section
> + the per-task commits are the resume mechanism — re-running `/loop tasks/build-loop.md`
> skips checked boxes, retries unchecked, leaves `[BLOCKED]` for human triage.
> Findings are defined in `hardening-spec.md`; refactors `AR*`/`AQ*` in `architecture-spec.md`.

## Wave 0 — Foundations (unblock everything; no blockedBy)
- [x] F1 — status.ts state machine (AR2 + OQ3 enum incl. `no_audio`)
- [x] F2 — migration runner (AD6/AQ3, PRAGMA user_version) · **DB critical-path gate §5.1**
- [x] F3 — config validate + thread as value (R10/AR8)
- [x] F4 — runCli() boundary (R7/AR4)
- [x] F5 — LeavePolicy pure function (AD4/AQ2)
- [x] F6 — heartbeat-as-liveness, same-statement, BOTH backends (R1/AR6)
- [x] F7 — findElement deadline-poll, .first()-safe (R9)
- [x] F8 — Camofox api() centralized validation (R8)
- [x] F9 — uniform signal dedup util (R11)
- [x] R12 — fmtTime handles all shapes (display-only, D1/CA10, OQ4)

## Wave 1 — Data integrity (DB gate §5.1 applies to schema tasks)
- [x] C19 P1 — dup-row rejoin loop: reuse scheduled row (bot.ts:50) · blockedBy: F2
- [x] D6 P2 — UNIQUE index + dedupe migration · blockedBy: C19 · **gate §5.1 (seeded-dups proof)**
- [x] CA3 P2 — race dedup: INSERT … ON CONFLICT DO NOTHING · blockedBy: D6
- [x] CA4 P2 — cross-provider dedup (join_url + time) · blockedBy: D6, AR7
- [x] D3 P1 — stale-heartbeat false-kill · blockedBy: F6
- [x] D4 P2 — orphan recordings row in same txn · blockedBy: F6, F2
- [x] D5 P2 — timezone validation at load · blockedBy: F3
- [x] D7 P3 — missed-meeting sweep · blockedBy: F2
- [x] D8 P3 — warn on changes===0 · blockedBy: F2
- [ ] D9 P3 — closeDb on exit (wire, OQ8) · blockedBy: F2, R13

## Wave 2 — Transcription + Calendar
- [x] R6 — transcribe() returns outcome enum · blockedBy: F1
- [x] T1 P1 — failed/skipped recorded as done · blockedBy: R6
- [x] T2 P1 — exit-0 with no output = success · blockedBy: R6, F4
- [x] C5 P1 — camofox path never transcribes · blockedBy: R6, F6
- [x] C7 P2 — catch clobbers terminal status · blockedBy: R6, F1
- [x] T3 P1 — --db absolute path · blockedBy: F4
- [x] T4 P2 — label calls swallow errors + no timeout · blockedBy: F4
- [x] T5 P2 — option-injection via display name (`--`) · blockedBy: F4
- [x] T6 P2 — maxBuffer on transcribe CLI · blockedBy: F4
- [x] T7 P2 — parse output_dir as JSON not regex · blockedBy: F4
- [x] T8 P3 — deepscript empty-dir warn · blockedBy: F4
- [x] AR7 — calendar ingest seam (Provider → normalized Meeting[]) · blockedBy: F4
- [x] CA1 P1 — exit-1 stdout parsed as success · blockedBy: F4, AR7
- [x] CA2 P1 — no update/cancel of changed events · blockedBy: AR7
- [x] CA5 P2 — candidate order: joinUrl first · blockedBy: AR7
- [x] CA6 P2 — HTML-entity-decode body URL · blockedBy: AR7
- [x] CA8 P2 — skip all-day (no dateTime) · blockedBy: AR7
- [BLOCKED] CA9 P3 — timezone at ingest (needs-repro first) · blockedBy: AR7 — no repro fixture; logged in opportunities.md
- [x] CA10 P3 — fmtTime offset datetimes (subsumed by R12) · blockedBy: R12
- [x] CA11 P3 — GWS_PATH set-but-missing + hardcoded default · blockedBy: —

## Wave 3 — Meeting lifecycle
- [x] M1+M3 P0/P1 — frozen consecutiveEmptyPolls + fabricated names, **ONE task**, aria-count→leave-gate · blockedBy: F5
- [x] M15 P1 — camofox loop has no alone-detection · blockedBy: F5, F6
- [x] M9 P2 — minHumans>0 alone gate · blockedBy: F5
- [x] M7 P2 — leave-button 2-miss debounce · blockedBy: F5
- [x] M2 P1 — waitForTimeout reject → finalize · blockedBy: —
- [x] M6 P2 — first-60s skips whole loop body · blockedBy: —
- [x] M8 P2 — mkdir outside try crashes poll · blockedBy: —
- [x] M4 P1 — chat DOM-index dedup (Teams virtualization) · blockedBy: F9
- [x] M5 P1 — hand-as-reaction spam · blockedBy: F9
- [x] M10 P2 — hand re-raise overwrite · blockedBy: F9
- [BLOCKED] M11 P2 — Meet chat sender closest() (needs-repro) · blockedBy: — — dead code as shipped (meet.json browser=camofox → Meet never hits SignalTracker.pollChat); fix direction unverified vs real Meet DOM. Logged in opportunities.md
- [x] M12 P3 — isSimilar divide-by-samples · blockedBy: —
- [x] M13 P3 — presenter handoff within poll gap · blockedBy: —
- [x] M14 P3 — hardcoded /tmp/teams-ended.png · blockedBy: —
- [x] M16 P3 — hoist shared isSimilar (fixes M12 both places) · blockedBy: M12

## Wave 4 — Audio lifecycle (ONE coordinated PR, OQ1: R4→R3→R2)
- [x] FA/R4 — WebRTC hook via addInitScript, single injector (AR5) · blockedBy: —
- [x] R3 — managed ffmpeg wrapper (error/exit/SIGKILL) · blockedBy: FA
- [x] R2 — per-bot capture sessions, no singletons (AR3) · blockedBy: R3
- [x] AU1 P0 — Zoom iframe produces no WebRTC audio · blockedBy: FA
- [x] DRAIN — AU3/AU8/AU12 one drain protocol (OQ5 stop-and-drain) · blockedBy: FA
- [x] AU10 P2 — never overwrite longer capture (ffprobe duration) · blockedBy: R2
- [x] AU2 P1 — hook destroyed by goto · blockedBy: FA
- [x] AU4 P1 — stopRecording no await/SIGKILL · blockedBy: R3
- [x] AU5 P1 — no ffmpeg exit handler · blockedBy: R3
- [x] AU6 P1 — no ffmpeg error handler · blockedBy: R3
- [x] AU7 P2 — FileReader no onerror → hang · blockedBy: FA
- [x] AU11 P2 — catch{} swallows flush errors · blockedBy: —
- [x] AU13 P3 — anchored webrtc-path helper (not a bug) · blockedBy: R2
- [x] AU14 P3 — cleanupInfra: delete + document (OQ8) · blockedBy: —

## Wave 5 — Join hardening + CLI edges
- [x] J1/J2/J14/J15/J16/J20 — via F8 (R8) · blockedBy: F8 — J2 ok:false rejection in parseCamofoxResponse; J15 AbortSignal timeout in camofoxFetch + screenshot; J20 awaitCamofoxReady snapshot-poll replaces blind 8s sleep (camofox-api-edges.test.ts)
- [x] J4/J8/J9/J5 — via F7 (R9) · blockedBy: F7 — discharged by Wave 0 findElement refactor (poll-for-first.test.ts; .first() guards playbook.ts:482/495/497; null-on-miss :463)
- [x] J6 P2 — camofox type no-op logs typed · blockedBy: F8 — buildTypeSetExpr reports write; type throws on no editable focus (camofox-interaction.test.ts)
- [x] J7 P2 — goto swallows nav errors · blockedBy: — — goto .catch now logs real err.message (not "timeout"); playbook.ts goto
- [x] J10 P2 — wait unknown-target silent success · blockedBy: F7 — findElement wait now covers text|selector|role|xpath|near_text (playbook.ts:357), throws on miss
- [x] J11 P2 — camofox clickElement CSS selector · blockedBy: F8 — selector target routes through buildSelectorClickExpr (DOM querySelector), not findRef
- [x] J12 P2 — findRef substring matches wrong el · blockedBy: F8 — findRefInSnapshot name-scoped, exact→word→prefix→substring ladder (camofox-interaction.test.ts)
- [x] J13 P2 — signal observer destroyed by nav · blockedBy: F8 — drainSignals re-installs idempotent SIGNAL_OBSERVER_SCRIPT each poll (self-heal after nav)
- [x] J17 P3 — camofox press untrusted events · blockedBy: F8 — buildPressExpr reports focus; press throws when nothing focused (honest logging)
- [x] J18 P3 — playbook load no shape validation · blockedBy: F3 — validatePlaybook() fails fast on non-object/missing-steps/step-without-action; load() wraps it
- [x] J19 P2 — js_click/eval ignore step.frame · blockedBy: — — evalFrame(step.frame) routes js_click/eval to the target frame
- [x] J21 P3 — interpolate empty-string var · blockedBy: — — interpolateVars uses `key in vars` not `|| placeholder`; "" now substitutes
- [ ] J22 P3 — selector override element types · blockedBy: F3
- [x] J23 P3 — raw text into text= engine · blockedBy: — — getByText().first() replaces text= selector-engine string (escapes /, quotes)
- [x] J24 P3 — screenshot path concurrent clobber · blockedBy: — — defaultScreenshotPath includes pid + seq counter
- [ ] R13 — control-socket edges + single graceful exit · blockedBy: R3
- [ ] C1 P1 — signal handler never exits · blockedBy: R13
- [ ] C2 P1 — no socket/server error handler · blockedBy: R13
- [x] C3 P1 — heartbeat interval not in finally · blockedBy: — — fixed by D3/R1 (bot.ts:98 outer-scope, cleared bot.ts:266 finally; stale-heartbeat.test.ts)
- [x] C4 P1 — cross-bot ffmpeg kill · blockedBy: R2 — fixed by R2 CaptureSession (per-bot ffmpeg handle)
- [x] C6 P1 — heartbeat accounting / activeBots · blockedBy: F6 — heartbeat lifecycle fixed by F6/R1/D3 (one interval join→processing, cleared in finally; heartbeat.test.ts)
- [ ] C8 P2 — stale-socket sweep kills live sockets · blockedBy: R13
- [ ] C9 P2 — sendCmd ok:false → exit 1 · blockedBy: R13
- [ ] C10 P2 — sendCommand no timeout · blockedBy: R13
- [ ] C11 P2 — JSON.parse(attendees) aborts poll · blockedBy: —
- [ ] C12 P3 — wrap updateHeartbeat (was false-pos) · blockedBy: —
- [ ] C13 P3 — log flush before exit · blockedBy: R13
- [ ] C14 P1 — hung Chromium leak on close race · blockedBy: R3
- [ ] C15 P3 — goto swallows nav (sibling J7) · blockedBy: —
- [ ] C16 P3 — remove eval from usage (OQ8) · blockedBy: —
- [ ] C17 P3 — log level validate + date rotate · blockedBy: —
- [ ] C18 P3 — --title flag parsing · blockedBy: —
- [ ] C20 P3 — poll re-entrancy guard · blockedBy: —

## Wave 6 — Structural unification (LAST, optional-in-scope)
- [ ] AR1 — BrowserBackend contract + unified join/monitor/finalize pipeline (subsumes AD1/AD2/AD3/AD5/AD8/AD9) · blockedBy: F5, R2, F1
- [ ] AQ5 — update CLAUDE.md bot.ts line count + module description · blockedBy: AR1

## Tier gates (run at each wave boundary — build-loop.md §8)
- [ ] Full-suite regression after each wave (`npx vitest run` + tsup + tsc)
- [ ] Smoke/integration after each wave (config/meetings/recordings boot, control cmd, playbook parse, AU1 iframe fixture)
