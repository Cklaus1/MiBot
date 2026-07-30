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
