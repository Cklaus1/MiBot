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

## Next Up
- [ ] Google Meet playbook
- [ ] Audio capture on proper server (headed Chrome + PulseAudio)
- [ ] Better participant name scraping (parse from post-join text instead of DOM selectors)
- [ ] Vision-based fallback for playbook steps (screenshot → Claude → click coordinates)
- [ ] Google Calendar support (currently M365 only)
- [ ] MiNotes output adapter
- [ ] MiAction output adapter
