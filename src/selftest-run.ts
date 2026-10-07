import fs from 'fs';
import os from 'os';
import path from 'path';
import { chromium } from 'playwright';
import { loadConfig } from './config.js';
import { getDb, getRecording, getMeeting } from './db.js';
import { LATEST_SCHEMA_VERSION } from './migrations.js';
import { pingCamofox } from './camofox.js';
import { PlaybookEngine } from './playbook.js';
import { runCli } from './runcli.js';
import { resolveGwsBinary } from './calendar.js';
import { probeDurationSec } from './capture-session.js';
import { joinAndRecord, RECORDINGS_DIR, detectPlatform } from './bot.js';
import { expandHome } from './notify.js';
import { defaultChecks, runPreflight, runLiveSelftest, explainCliFailure, type CheckResult, type LiveResult } from './selftest.js';

/** Production wiring for `mibot selftest` (Wave 10 #6). The logic lives in selftest.ts. */
export async function preflight(): Promise<CheckResult[]> {
  const config = loadConfig();
  const calendars: Array<{ name: string; probe: () => Promise<void> }> = [];
  const now = new Date();
  const soon = new Date(now.getTime() + 60_000);
  if (process.env.MS365_CLI_CLIENT_ID) {
    calendars.push({ name: 'Microsoft 365', probe: async () => {
      await runCli('ms365', ['calendar', 'view', '--start', now.toISOString(), '--end', soon.toISOString(), '--select', 'id', '-o', 'json'], { timeoutMs: 20_000 })
        .catch((err) => { throw new Error(explainCliFailure(err, 'ms365 auth login')); });
    } });
  }
  const gws = resolveGwsBinary(process.env.GWS_PATH, (p) => fs.existsSync(p));
  if (gws.action === 'run') {
    calendars.push({ name: 'Google', probe: async () => {
      await runCli(gws.path, ['calendar', 'events', 'list', '--params', JSON.stringify({ calendarId: 'primary', timeMin: now.toISOString(), timeMax: soon.toISOString(), maxResults: 1 }), '--format', 'json'], { timeoutMs: 20_000 })
        .catch((err) => { throw new Error(explainCliFailure(err, `${gws.path} auth login`)); });
    } });
  }
  return runPreflight(defaultChecks({
    recordingsDir: RECORDINGS_DIR,
    notesFolder: expandHome(config.notify.folder),
    minFreeBytes: 2e9,
    dbVersion: () => ({ current: getDb().pragma('user_version', { simple: true }) as number, latest: LATEST_SCHEMA_VERSION }),
    camofoxReachable: pingCamofox,
    launchChromium: async () => { const b = await chromium.launch({ headless: true }); await b.close(); },
    calendars,
    playbooks: () => ['teams', 'zoom', 'meet'].filter((p) => { try { return PlaybookEngine.loadForPlatform(p) !== null; } catch { return false; } }),
  }));
}

export async function live(platform: string, seconds: number): Promise<LiveResult> {
  const config = loadConfig();
  const url = config.selftest.testMeetings[platform];
  if (url && detectPlatform(url) !== platform) {
    return { ok: false, problems: [`selftest.testMeetings.${platform} is not a ${platform} link`], usableSec: null, windowSec: seconds };
  }
  return runLiveSelftest(url, seconds, {
    makeTone: async (out, secs) => {
      await runCli('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${secs}`, '-ac', '1', '-ar', '48000', out], { timeoutMs: 60_000 });
    },
    // The speaker must join WITH its microphone on — the regular join playbooks deliberately
    // join muted ("continue without audio"), so <platform>-speaker.json is used when present.
    startSpeaker: async (meetingUrl, tonePath) => {
      const browser = await chromium.launch({
        headless: true,
        args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${tonePath}`,
          '--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
      });
      const context = await browser.newContext({ permissions: ['microphone', 'camera'] });
      const page = await context.newPage();
      const dir = path.join(os.homedir(), '.config', 'mibot', 'playbooks');
      const speakerFile = path.join(dir, `${platform}-speaker.json`);
      const playbook = fs.existsSync(speakerFile) ? PlaybookEngine.load(speakerFile) : PlaybookEngine.loadForPlatform(platform);
      if (!playbook) { await browser.close(); throw new Error(`no ${platform} playbook for the speaker`); }
      try {
        await page.goto(meetingUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
        await new PlaybookEngine(page, { botName: 'MiBot self-test speaker', meetingUrl }).run(playbook);
      } catch (err) { await browser.close(); throw err; }
      return { stop: () => browser.close() };
    },
    runBot: async (meetingUrl, secs) => {
      const recId = await joinAndRecord({ url: meetingUrl, title: `MiBot self-test (${platform})`, selftest: { maxSeconds: secs } });
      const rec = getRecording(recId)!;
      return { meetingId: rec.meeting_id, audioPath: rec.audio_path, consentPosted: getMeeting(rec.meeting_id)?.consent_posted ?? null };
    },
    usableSeconds: probeDurationSec,
  });
}
