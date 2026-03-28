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
