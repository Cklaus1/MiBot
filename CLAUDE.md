# MiBot — Development Rules

## Workflow Orchestration

### 1. Plan Mode Default
- Enter plan mode for ANY non-trivial task (3+ steps or architectural decisions)
- If something goes sideways, stop and re-plan immediately — don't keep pushing
- Use plan mode for verification steps, not just building
- Write detailed specs upfront to reduce ambiguity

### 2. Subagents Strategy
- Use subagents liberally to keep main context window clean
- Offload research, exploration, and parallel analysis to subagents
- For complex problems, throw more compute at it via subagents
- One task per subagent for focused execution

### 3. Self-Improvement Loop
- After ANY correction from the user: update tasks/lessons.md with the pattern
- Write rules for yourself that prevent the same mistake
- Ruthlessly iterate on these lessons until mistake rate drops
- Review lessons at session start for relevant project

### 4. Verification Before Done
- Never mark a task complete without proving it works
- Diff behavior between main and your changes when relevant
- Ask yourself: "Would a staff engineer approve this?"
- Run tests, check logs, demonstrate correctness

### 5. Demand Elegance (Balanced)
- For non-trivial changes: pause and ask "is there a more elegant way?"
- If a fix feels hacky: "Knowing everything I know now, implement the elegant solution"
- Skip this for simple, obvious fixes — don't over-engineer
- Challenge your own work before presenting it

### 6. Autonomous Bug Fixing
- When given a bug report: just fix it. Don't ask for hand-holding
- Point at logs, errors, failing tests — then resolve them
- Zero context switching required from the user
- Go fix failing CI tests without being told how

## Task Management
- **Plan First:** Write plan to tasks/todo.md with checkable items
- **Verify Plan:** Check in before starting implementation
- **Track Progress:** Mark items complete as you go
- **Explain Changes:** High-level summary at each step
- **Document Results:** Add review section to tasks/todo.md
- **Capture Lessons:** Update tasks/lessons.md after corrections

## Project Context

- **Stack:** TypeScript, Playwright, SQLite (better-sqlite3), vitest
- **Build:** `npx tsup` — always build after code changes
- **Test:** `npx vitest run` — always run tests after changes
- **Config:** `~/.config/mibot/config.json` (runtime, no rebuild)
- **Playbooks:** `~/.config/mibot/playbooks/*.json` (editable join flows, no rebuild)
- **Auth:** MS365 calendar sync via ms365-cli (needs MS365_CLI_CLIENT_ID env var)

## Architecture

- `bot.ts` — thin orchestrator (~184 lines), imports from all modules
- `meeting.ts` — participant tracking, leave logic, speaker detection
- `audio.ts` — WebRTC + ffmpeg recording
- `transcribe.ts` — audioscript integration + auto speaker labeling
- `playbook.ts` — JSON-driven join flows (Teams, Zoom, Meet)
- `signals.ts` — chat, reactions, hand raises, screen share screenshots
- `control.ts` — Unix socket for live debugging (`mibot send <id> screenshot`)
- `webrtc-capture.ts` — RTCPeerConnection hook for audio capture

## Known Constraints

- **Audio capture:** Headless Chrome can't output to PulseAudio. WebRTC hook captures incoming audio but quality depends on the browser context. Headed mode + Xvfb + PulseAudio works but Xvfb crashes on nvidia GPU servers.
- **Zoom:** Web client runs in an iframe. All playbook steps need `"frame": "any"`.
- **Teams:** Pre-join dialogs vary. Playbook handles "Continue on this browser", "Continue without audio/video", and the "Did not open Zoom Workplace app?" popup.
- **Google Meet reactions:** Reaction announcements are OFF by default. Users must enable them: In Meet → Settings → Accessibility → "Announce reactions". Without this, MiBot captures chat/hands/screen share but not emoji reactions.
