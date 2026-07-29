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
- [ ] CA4 P2 — cross-provider dedup (join_url + time) · blockedBy: D6, AR7
- [ ] D3 P1 — stale-heartbeat false-kill · blockedBy: F6
- [ ] D4 P2 — orphan recordings row in same txn · blockedBy: F6, F2
- [ ] D5 P2 — timezone validation at load · blockedBy: F3
- [ ] D7 P3 — missed-meeting sweep · blockedBy: F2
- [ ] D8 P3 — warn on changes===0 · blockedBy: F2
- [ ] D9 P3 — closeDb on exit (wire, OQ8) · blockedBy: F2, R13

## Wave 2 — Transcription + Calendar
- [x] R6 — transcribe() returns outcome enum · blockedBy: F1
- [x] T1 P1 — failed/skipped recorded as done · blockedBy: R6
- [ ] T2 P1 — exit-0 with no output = success · blockedBy: R6, F4
- [x] C5 P1 — camofox path never transcribes · blockedBy: R6, F6
- [x] C7 P2 — catch clobbers terminal status · blockedBy: R6, F1
- [ ] T3 P1 — --db absolute path · blockedBy: F4
- [ ] T4 P2 — label calls swallow errors + no timeout · blockedBy: F4
- [ ] T5 P2 — option-injection via display name (`--`) · blockedBy: F4
- [ ] T6 P2 — maxBuffer on transcribe CLI · blockedBy: F4
- [ ] T7 P2 — parse output_dir as JSON not regex · blockedBy: F4
- [ ] T8 P3 — deepscript empty-dir warn · blockedBy: F4
- [ ] AR7 — calendar ingest seam (Provider → normalized Meeting[]) · blockedBy: F4
- [ ] CA1 P1 — exit-1 stdout parsed as success · blockedBy: F4, AR7
- [ ] CA2 P1 — no update/cancel of changed events · blockedBy: AR7
- [ ] CA5 P2 — candidate order: joinUrl first · blockedBy: AR7
- [ ] CA6 P2 — HTML-entity-decode body URL · blockedBy: AR7
- [ ] CA8 P2 — skip all-day (no dateTime) · blockedBy: AR7
- [ ] CA9 P3 — timezone at ingest (needs-repro first) · blockedBy: AR7
- [ ] CA10 P3 — fmtTime offset datetimes (subsumed by R12) · blockedBy: R12
- [ ] CA11 P3 — GWS_PATH set-but-missing + hardcoded default · blockedBy: —

## Wave 3 — Meeting lifecycle
- [ ] M1+M3 P0/P1 — frozen consecutiveEmptyPolls + fabricated names, **ONE task**, aria-count→leave-gate · blockedBy: F5
- [ ] M15 P1 — camofox loop has no alone-detection · blockedBy: F5, F6
- [ ] M9 P2 — minHumans>0 alone gate · blockedBy: F5
- [ ] M7 P2 — leave-button 2-miss debounce · blockedBy: F5
- [ ] M2 P1 — waitForTimeout reject → finalize · blockedBy: —
- [ ] M6 P2 — first-60s skips whole loop body · blockedBy: —
- [ ] M8 P2 — mkdir outside try crashes poll · blockedBy: —
- [x] M4 P1 — chat DOM-index dedup (Teams virtualization) · blockedBy: F9
- [ ] M5 P1 — hand-as-reaction spam · blockedBy: F9
- [ ] M10 P2 — hand re-raise overwrite · blockedBy: F9
- [ ] M11 P2 — Meet chat sender closest() (needs-repro) · blockedBy: —
- [ ] M12 P3 — isSimilar divide-by-samples · blockedBy: —
- [ ] M13 P3 — presenter handoff within poll gap · blockedBy: —
- [ ] M14 P3 — hardcoded /tmp/teams-ended.png · blockedBy: —
- [ ] M16 P3 — hoist shared isSimilar (fixes M12 both places) · blockedBy: M12

## Wave 4 — Audio lifecycle (ONE coordinated PR, OQ1: R4→R3→R2)
- [ ] FA/R4 — WebRTC hook via addInitScript, single injector (AR5) · blockedBy: —
- [ ] R3 — managed ffmpeg wrapper (error/exit/SIGKILL) · blockedBy: FA
- [ ] R2 — per-bot capture sessions, no singletons (AR3) · blockedBy: R3
- [ ] AU1 P0 — Zoom iframe produces no WebRTC audio · blockedBy: FA
- [ ] DRAIN — AU3/AU8/AU12 one drain protocol (OQ5 stop-and-drain) · blockedBy: FA
- [ ] AU10 P2 — never overwrite longer capture (ffprobe duration) · blockedBy: R2
- [ ] AU2 P1 — hook destroyed by goto · blockedBy: FA
- [ ] AU4 P1 — stopRecording no await/SIGKILL · blockedBy: R3
- [ ] AU5 P1 — no ffmpeg exit handler · blockedBy: R3
- [ ] AU6 P1 — no ffmpeg error handler · blockedBy: R3
- [ ] AU7 P2 — FileReader no onerror → hang · blockedBy: FA
- [ ] AU11 P2 — catch{} swallows flush errors · blockedBy: —
- [ ] AU13 P3 — anchored webrtc-path helper (not a bug) · blockedBy: R2
- [ ] AU14 P3 — cleanupInfra: delete + document (OQ8) · blockedBy: —

## Wave 5 — Join hardening + CLI edges
- [ ] J1/J2/J14/J15/J16/J20 — via F8 (R8) · blockedBy: F8
- [ ] J4/J8/J9/J5 — via F7 (R9) · blockedBy: F7
- [ ] J6 P2 — camofox type no-op logs typed · blockedBy: F8
- [ ] J7 P2 — goto swallows nav errors · blockedBy: —
- [ ] J10 P2 — wait unknown-target silent success · blockedBy: F7
- [ ] J11 P2 — camofox clickElement CSS selector · blockedBy: F8
- [ ] J12 P2 — findRef substring matches wrong el · blockedBy: F8
- [ ] J13 P2 — signal observer destroyed by nav · blockedBy: F8
- [ ] J17 P3 — camofox press untrusted events · blockedBy: F8
- [ ] J18 P3 — playbook load no shape validation · blockedBy: F3
- [ ] J19 P2 — js_click/eval ignore step.frame · blockedBy: —
- [ ] J21 P3 — interpolate empty-string var · blockedBy: —
- [ ] J22 P3 — selector override element types · blockedBy: F3
- [ ] J23 P3 — raw text into text= engine · blockedBy: —
- [ ] J24 P3 — screenshot path concurrent clobber · blockedBy: —
- [ ] R13 — control-socket edges + single graceful exit · blockedBy: R3
- [ ] C1 P1 — signal handler never exits · blockedBy: R13
- [ ] C2 P1 — no socket/server error handler · blockedBy: R13
- [ ] C3 P1 — heartbeat interval not in finally · blockedBy: —
- [ ] C4 P1 — cross-bot ffmpeg kill · blockedBy: R2
- [ ] C6 P1 — heartbeat accounting / activeBots · blockedBy: F6
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
