# MiBot

AI meeting bot that joins your Zoom, Teams, and Google Meet calls — records audio, captures signals, and transcribes automatically.

## What it does

- **Auto-joins meetings** from your Microsoft 365 calendar
- **Records audio** via WebRTC capture (works headless, no audio device needed)
- **Captures meeting signals** — chat messages, reactions, hand raises, screen share screenshots
- **Transcribes** via [AudioScript](https://github.com/Cklaus1/audioscript) with speaker diarization
- **JSON playbooks** drive join flows — edit `~/.config/mibot/playbooks/*.json` to adapt to UI changes without rebuilding

## Architecture

```
Calendar sync → Join via playbook → Monitor + record → Transcribe
     │                │                    │                │
  ms365-cli    Playwright (Teams/Zoom)   Signals         AudioScript
               Camofox (Google Meet)     Screenshots
                                         Audio capture
```

- **Playwright + Chromium** for Teams and Zoom (standard browser automation)
- **Camofox** (anti-detection Firefox) for Google Meet (bypasses bot detection)
- **Playbook engine** — JSON-defined join flows, no rebuild needed
- **WebRTC hook + captureStream()** for audio capture without a sound card

## Quick start

```bash
# Install
git clone https://github.com/Cklaus1/MiBot.git
cd MiBot
npm install
npx playwright install chromium
npx tsup

# Configure
mkdir -p ~/.config/mibot
cp playbooks/*.json ~/.config/mibot/playbooks/  # if shipping defaults later

# Set up calendar sync (optional)
export MS365_CLI_CLIENT_ID=your-app-id
export MS365_CLI_TENANT_ID=your-tenant-id

# Join a meeting
npx mibot join https://teams.microsoft.com/l/meetup-join/...
npx mibot join https://us06web.zoom.us/j/123456789
npx mibot join https://meet.google.com/abc-defg-hij

# Auto-join all meetings from calendar
npx mibot start
```

## Docker (recommended for audio capture)

Audio capture via WebRTC works best in Docker where PulseAudio has a real Linux kernel.

```bash
# Requires camofox-browser repo as a sibling directory
bash build-docker.sh

# Join a meeting
docker run --rm -v ~/.config/mibot:/root/.config/mibot mibot \
  node dist/index.js join https://meet.google.com/abc-defg-hij

# Run calendar watcher
docker compose up
```

## Playbooks

Join flows are defined as JSON playbooks in `~/.config/mibot/playbooks/`:

| File | Browser | Platform |
|------|---------|----------|
| `teams.json` | Playwright | Microsoft Teams |
| `zoom.json` | Playwright | Zoom |
| `meet.json` | Camofox | Google Meet |

Playbooks support actions: `click`, `fill`, `type`, `wait`, `screenshot`, `press`, `try`, `goto`, `eval`, `js_click`, `log`.

Set `"browser": "camofox"` in a playbook to use the anti-detection browser.

## CLI commands

| Command | Description |
|---------|-------------|
| `mibot start` | Watch calendar and auto-join meetings |
| `mibot join <url>` | Join a specific meeting |
| `mibot sync` | Sync calendar and join upcoming meetings |
| `mibot meetings` | List meetings |
| `mibot recordings` | List recordings |
| `mibot show <id>` | Show meeting details |
| `mibot config` | Show current config |
| `mibot send <id> screenshot` | Take a screenshot of a running bot |

## Configuration

Edit `~/.config/mibot/config.json`:

```json
{
  "timezone": "America/New_York",
  "botName": "MiBot",
  "joinBeforeMinutes": 5,
  "pollMinutes": 1,
  "maxDurationHours": 4,
  "aloneTimeoutMinutes": 120
}
```

## Stack

TypeScript, Playwright, Camofox (Camoufox), SQLite, PulseAudio, ffmpeg

## License

[CC BY-NC 4.0](LICENSE) — free for non-commercial use.
