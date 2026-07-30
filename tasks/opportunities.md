# MiBot — Opportunities (deferred-work sink)

> The curated input to the *next* build loop. Per `build-loop.md §10`, during a build run:
> - A newly-found **optimization** → one line here, **not acted on** (no failing test →
>   acting would violate the verification bar).
> - A newly-found **bug** → captured here as a candidate task with proposed severity,
>   **never** silently fixed outside the DAG.
> - Exception: a fix impossible without a minimal refactor may include that refactor (as an
>   `Rn`/`Fn` anticipates) — note it here rather than expanding scope silently.
>
> Format: `- [OPT|BUG] <where> — <what> · <proposed severity/effort or "opt">`

## Optimizations (deferred — do not act during build)
- [OPT] `webrtc-capture.ts saveAudio()` — became unreferenced after the DRAIN rewrite removed
  `extractAudio` (its only sibling). Left in place (not in any finding; deleting mid-wave would
  be scope creep). Candidate for a dead-code sweep in a future pass · opt.
- [OPT] `audio.ts getWebrtcAudioPath()` — kept as a deprecated alias of `webrtcAudioPathFor`
  (AU13) for any out-of-tree caller; no in-repo call sites remain. Remove in a future cleanup · opt.

## Candidate bugs found during build (triage into a future DAG)
- [RESOLVED] test isolation — shared on-disk `~/.config/mibot/mibot.db` caused an
  intermittent "1 failed" under full-suite concurrency. Fixed mid-build (commit ad4808a):
  getDb() honors `MIBOT_DB_PATH`, test/setup.ts gives each test file a temp DB. 5× clean.

## Needs-repro (deferred until a reproduction exists)
- [BUG] CA9 `calendar.ts` M365 ingest — `event.start.timeZone` is discarded while the bare
  `dateTime` is stored. Graph returns UTC by default (no `Prefer: outlook.timezone` header is
  sent), so this only misbehaves if ms365-cli sets a timezone preference — unverified. Fix if
  reproduced: convert `{dateTime,timeZone}` → UTC ISO in `m365ToRaw`. The AR7 seam gives it a
  single home (one line in `m365ToRaw`). P3 · needs-repro. Not fixed this run (no fixture).
- [BUG] M11 `signals.ts` Meet chat sender — the Playwright `pollChat` meet branch reads the
  sender via descendant `querySelector('[data-sender-name]')`, but Meet reportedly puts the attr
  on the ancestor (→ sender always `''`). **Dead code as shipped:** `~/.config/mibot/playbooks/
  meet.json` sets `browser: camofox`, so every Meet meeting routes through `monitorCamofoxMeeting`
  (inline chat scrape via the signal observer), never `SignalTracker.pollChat`. The branch only
  goes live if a `meet` playbook sets `browser: playwright`. Proposed fix `el.closest(
  '[data-sender-name]')` is unverified against real Meet DOM — encoding it as a test fixture would
  bake in a guess (the exact needs-repro trap). Fix when a Playwright-Meet repro exists. P2 · S.
- [BUG] CA2 empty-window semantics — a provider returning a valid-but-empty event list cancels
  ALL its scheduled meetings. This is intentional (empty window = nothing scheduled) and safe
  because `parseEventsPayload` throws on error payloads (so a failed sync never reaches the
  cancel step), but if a provider ever returns empty on transient partial failure, add a
  "non-empty-last-time" guard. Watch item, not a fix.

## Carried architecture items (out of current scope, tracked)
- [ARCH] control channel — no auth; local-only `0600` socket for now (hardening OQ7 /
  arch AQ4). Becomes mandatory if an `eval`/arbitrary-JS command is ever added (C16 removes
  it from the usage string). Revisit before exposing any code-execution command.
- [ARCH] AR1 (BrowserBackend unification) — largest structural change; its target bugs
  (M15, C5) are fixed tactically in waves 2–3, so AR1 is optional-within-scope and
  scheduled last. If deferred past this run, it lands here as the top item for the next.
- [ARCH] N1 transcription-provider interface, N2 platform-plugin registry, N3 signal event
  bus, N4 DI framework, N5 DB repository/ORM — explicitly rejected as YAGNI
  (architecture-spec NEGATIVES). Listed so they are not "re-discovered" as new ideas.
