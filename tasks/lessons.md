# Lessons Learned

## 2026-03-27 — Day 1

### Zoom join flow is iframe-based
- **Mistake:** Tried to find "Continue without microphone and camera" in the main frame. Spent hours debugging.
- **Root cause:** Zoom renders its web client inside an iframe on `app.zoom.us`. The dialog is in the iframe, not the main page.
- **Rule:** Always use `"frame": "any"` in Zoom playbook steps. When a selector can't find something visible in a screenshot, check iframes.

### Headless Chrome has no audio output
- **Mistake:** Assumed in-browser MediaRecorder could capture WebRTC audio from other participants.
- **Root cause:** WebRTC delivers audio to Chrome's audio output, which doesn't exist in headless mode. MediaRecorder on AudioContext destination only captures locally-generated audio.
- **Rule:** For audio capture, either use headed mode + PulseAudio + ffmpeg, or hook RTCPeerConnection to intercept incoming tracks before they reach the audio output.

### JPEG byte comparison is unreliable for visual similarity
- **Mistake:** Used raw byte hash comparison to detect duplicate screenshots.
- **Root cause:** JPEG compression is non-deterministic — same visual produces different bytes due to encoder state, cursor position, timestamp overlays.
- **Rule:** Use perceptual hashing (skip JPEG headers, sample image data) for screenshot dedup. Threshold at 2% difference.

### Navigation timeout ≠ page not loaded
- **Mistake:** Treated `page.goto` timeout as a failure, stopping the flow.
- **Root cause:** Zoom/Teams SPAs never reach "networkidle" — they keep loading JavaScript. But the UI is usable long before that.
- **Rule:** Use `domcontentloaded` for goto, catch timeouts and continue. Add `wait_for` to verify the expected element appeared.

### Teams pre-join "Leave" button triggers false meeting-end detection
- **Mistake:** Detected "meeting ended" immediately after joining because the lobby has a Leave button too.
- **Rule:** Use 60-second grace period before checking for meeting end. Check for in-call-only elements (chat button, mute toggle), not just Leave button.

### Don't overwrite incrementally-flushed audio
- **Mistake:** Final `saveAudio()` call used `writeFileSync` which replaced 782KB of captured audio with a 1.4KB extract.
- **Rule:** Audio flush uses `appendFileSync`. Final extraction should append, not overwrite. Or skip the final extract entirely if incremental flush already captured everything.

### Browser crashes on Zoom after ~2 minutes
- **Root cause:** Default `/dev/shm` is too small for Chrome rendering Zoom's heavy JavaScript.
- **Rule:** Always launch Chrome with `--disable-dev-shm-usage`.

### Playwright's env option doesn't set DISPLAY for headless detection
- **Mistake:** Passed `env: { DISPLAY: ':50' }` in launch options but Playwright checks `process.env.DISPLAY` before launching Chrome.
- **Rule:** Set `process.env.DISPLAY` directly before calling `chromium.launch()`.

## 2026-07-29 — Build-loop Wave 3 (meeting lifecycle)

### Two parallel engines drift — port the fix, don't re-implement it
- **Pattern:** The Playwright loop (`meeting.ts`) and the Camofox/Meet loop (`bot.ts monitorCamofoxMeeting`) each have their own poll loop. Wave 1–2 fixes to leave logic (LeavePolicy) landed only in the Playwright loop; the camofox loop had NO alone-detection at all (M15).
- **Rule:** When a bug is fixed behind a pure helper (LeavePolicy, isSimilarImage, shareTransition), audit every engine that should use it. Prefer porting the *same* pure helper into the second engine over writing a second copy — a second copy carries the original bug forward (M16 was exactly this: two inline `isSimilar` copies both had the M12 divide-by-samples bug).

### Transient vs. persistent signals need different dedup models
- **Mistake risk:** Using occurrence-counting dedup (OccurrenceDeduper, right for chat) on reactions (M5) would mis-handle a reaction animation spanning two polls.
- **Rule:** Chat = persistent list → occurrence-counted content key. Reactions = transient animation → rising-edge dedup (emit when present-now-absent-last-poll). Hand raises = stateful open/close with history → per-participant open+completed lists (M10), never a single Map entry that a re-raise overwrites.

### Divide by the actual iteration count, not the intended sample cap
- **Mistake:** `isSimilar` looped `len/step` times but divided the diff count by `samples` (capped 500). For 500≤len<1000 `step` collapses to 1, so it compared up to 999 bytes while dividing by 500 → ~2× inflated ratio, near-identical small screenshots misread as different (M12).
- **Rule:** When a sampling loop's real iteration count can diverge from the intended sample count, count iterations and divide by that.

## 2026-07-29 — Build-loop Wave 4 (audio lifecycle)

### One injector, run everywhere — don't hand-copy it per frame
- **Mistake (AU1, P0):** The WebRTC hook had a main-frame copy (created `__mibotFlushedChunks`) and a *separate* hand-written iframe copy that omitted it. Zoom's WebRTC is in an iframe, so `flushAudioToDisk` read `undefined` and returned '' for the whole meeting — a silent no-audio for an entire platform.
- **Rule:** For "same behavior in every frame + survive navigation", install ONE function via `context.addInitScript`, never a second `page.evaluate` copy. Two copies of injected script drift exactly like two copies of a pure helper (Wave 3 M16). Make the injected function reference `window` explicitly so it's unit-testable by binding a fake `window`.

### Destructive-read-before-persist loses data on any downstream failure
- **Mistake (AU8):** The flush did `flushed.splice(0)` (remove) *before* the payload crossed CDP and `appendFileSync` succeeded. A failed transfer or ENOSPC permanently lost that 15s window — and `catch{}` hid it.
- **Rule:** Order side effects as read → persist → ack. Never remove from the source until the sink has confirmed. Split it so the ack step is a separate call that only runs after persist returns (the `drainAudioOnce` two-phase protocol). And never wrap a whole meeting's flushes in a silent `catch{}` — log the first failure + a periodic count (AU11), or the P0 failures stay invisible.

### Choose the "winner" file by decoded content, not byte size
- **Mistake (AU10):** `webrtcSize > 1000` gated whether the WebRTC file overwrote the ffmpeg recording. A 2s WebRTC stub (or >1KB of pure-silence opus) clobbered a full 1h pulse recording.
- **Rule:** When two captures of the same event compete, compare decoded duration (ffprobe), require a real margin, and never overwrite the longer one. Size is not content.

### Async lifecycle: a "stop" that doesn't await is a race, not a stop
- **Mistake (AU4):** `stopRecording` sent SIGINT then immediately nulled the handle; the subsequent `copyFileSync` raced ffmpeg still writing the webm trailer, and an ffmpeg ignoring SIGINT leaked forever.
- **Rule:** A stop must await the real exit (SIGINT → timeout → SIGKILL) before callers touch the output. Wrap child processes so 'error'/'exit' are always handled — an unhandled 'error' on a child EventEmitter crashes the process (AU6), and a missing 'exit' handler reports a mid-meeting death as success (AU5).

## 2026-07-29 — Build-loop Wave 5 (join/control/CLI/teardown edges)

### Browser code IS testable — extract the seam, not an excuse
- **Mistake pattern (J-cluster):** "vitest can't drive a real browser" was treated as "these paths can't be tested," so camofox click/type/press/findRef shipped unverified — and each had a silent-failure bug (typed text dropped, `Join` matching `Rejoin`, selectors fed to a snapshot text search that never matches).
- **Rule:** For browser/page code, extract a pure seam: a **JS-expression builder** (`buildTypeSetExpr`/`buildPressExpr`/`buildSelectorClickExpr`) that returns a source string testable via `new Function(...)` with a fake `document`, a **pure matcher** (`findRefInSnapshot`) over the snapshot text, or an **injected-clock poller** (`pollForFirst`, `closeOrKill`). The seam is also the exact method body the future backend impl (AR1) needs — testing it now is free structure later.

### "Logged success" must be gated on a verified effect
- **Mistake (J6/J17):** the camofox `type`/`press` evals wrote only when `activeElement` was editable but the step ALWAYS logged "typed"/"pressed". A mis-targeted type silently dropped the text — the worst kind of failure, one that looks like success.
- **Rule:** An action expr must RETURN whether it actually did the thing (wrote to an editable el / had a focus target), and the caller must throw on false. Never log an outcome you didn't confirm.

### One signal handler for the whole process, registered once, exits once
- **Mistake (C1):** each ControlChannel registered its own SIGINT/SIGTERM handler that called `stop()` but never exited — so once any channel started, Ctrl+C did nothing (browser/ffmpeg kept running), and every meeting leaked two more listeners.
- **Rule:** Signal handling lives in exactly ONE place (`shutdown.ts`), installed once (`process.once`). Subsystems register named teardown hooks; the single path runs them LIFO (children stop before log/db flush), swallows per-hook errors, then exits. Per-meeting hooks return a disposer and dispose on normal completion, or hooks (and their captured browser handles) pile up — the same leak, relocated.

### A `Promise.race([work, timer])` leaks the timer and abandons the loser
- **Mistake (C14):** `Promise.race([browser.close(), 5s])` nulled the handle on a lost race and never retried → hung Chromium leaked (camera/mic held); the un-cancelled timer kept a finished `mibot join` alive 5s.
- **Rule:** A timed close must (a) `clearTimeout` in `finally` so the timer never outlives the call, and (b) force-kill (`process().kill('SIGKILL')`) the loser, not just drop it. `closeOrKill` encodes both.

### `.catch(() => continue)` on I/O hides the failures you most need to see
- **Mistake (C15/J7):** `page.goto(...).catch(log)` swallowed DNS/refused/bad-URL alongside the benign networkidle timeout, then ran the whole playbook against about:blank → misleading "step not found" minutes later.
- **Rule:** Classify before you swallow. Continue only past the one benign case (`isNavTimeout`); rethrow the rest. A blanket catch on navigation/IO turns a clear root-cause error into a distant symptom.

### Cast a JSON blob to an array only through a guard
- **Mistake (C11):** unguarded `JSON.parse(meeting.attendees)` inside the poll's sort threw on one malformed row and aborted the ENTIRE poll iteration — the watcher joined nothing that cycle, and every cycle the bad row stayed in-window.
- **Rule:** External/stored JSON crosses a `safeParseArray` boundary (try/catch + `Array.isArray`) before use. A per-item parse failure must degrade that item, never abort the batch loop.

### Cross-suite file races hide until suites interleave
- **Mistake:** two test suites wrote the same `~/.config/mibot/selectors/zoom.json`; each passed alone, but parallel workers clobbered each other → a flaky failure that only appeared in the full run.
- **Rule:** File-touching tests must own a unique path (distinct platform/fixture per suite). Prove stability by running the FULL suite (not just the new file) 2–3× before committing — an isolated green is not a green.

### A pure ID audit at the tier boundary catches silent drops that per-wave green hides
- **Mistake (J3):** J3 — a P1 (stale-tab sweep deletes a live second bot's meet tab) — was never mirrored into the build DAG. Every wave ran green and the compound stop condition looked met, because a dropped task leaves no failing test to notice it; its absence is invisible until something cross-checks specs against the mirror.
- **Rule:** Before declaring the stop condition met, run a mechanical spec-ID → todo-ID diff (a fresh subagent, not the builder who owns the blind spot). An actionable finding with no `[x]`/`[ ]`/`[BLOCKED]` line and no `→Rn` parent is a silent drop — pull it back into the DAG and fix it test-first, don't wave it through. "All boxes checked" only proves the boxes that exist.

### Concurrency-safe cleanup must distinguish a crashed peer from a live one
- **Mistake (J3):** the sweep reclaimed *every* `meet.google.com` tab under the shared USER_ID — correct for a crashed prior run, catastrophic for a concurrent bot (it deleted the live meeting tab mid-call).
- **Rule:** Shared-resource reclamation keys off *liveness*, not identity-of-kind. Tag each resource with its owner pid on creation; before reclaiming, probe `kill(pid, 0)` (ESRCH=dead→reclaim, EPERM=alive→keep). Unowned = crashed run = reclaimable. Encode the decision as a pure seam (`selectStaleTabs`) so both the crash and concurrent cases are unit-tested without real processes.
