import { spawn, execSync, type ChildProcess } from 'child_process';
import { chromium, type Browser, type Page } from 'playwright';
import { ManagedFfmpeg } from './managed-ffmpeg.js';

// Use Chrome 121 (puppeteer's version) — it works better with Xvfb + PulseAudio
// Chrome 145 (Playwright's) has issues with the nvidia Xvfb workaround
const CHROME_PATH = '/root/.cache/puppeteer/chrome/linux-121.0.6167.85/chrome-linux64/chrome';
import fs from 'fs';
import path from 'path';
import os from 'os';

const DISPLAY = ':50';
const PULSE_RUNTIME = '/tmp/pulse';
const PULSE_SERVER = `unix:${PULSE_RUNTIME}/native`;
const SINK_NAME = 'chromesink';

let xvfbProc: ChildProcess | null = null;
let pulsePid: number | null = null;

/** Ensure Xvfb and PulseAudio are running. Sets process.env.DISPLAY. */
export function ensureAudioInfra(): void {
  // Start Xvfb if not running
  try { execSync(`pgrep -f "Xvfb ${DISPLAY}"`, { stdio: 'ignore' }); }
  catch {
    xvfbProc = spawn('Xvfb', [DISPLAY, '-screen', '0', '640x480x8', '-ac',
      '-nolisten', 'tcp', '+extension', 'Composite', '-noreset'], {
      stdio: 'ignore', detached: true,
    });
    xvfbProc.unref();
    execSync('sleep 1');
    console.error('[mibot] Xvfb started on ' + DISPLAY);
  }

  // Start PulseAudio if not running
  try {
    execSync(`PULSE_RUNTIME_PATH=${PULSE_RUNTIME} PULSE_SERVER="" pulseaudio --check`, { stdio: 'ignore' });
  } catch {
    execSync(`mkdir -p ${PULSE_RUNTIME}`);
    execSync(`PULSE_RUNTIME_PATH=${PULSE_RUNTIME} PULSE_SERVER="" pulseaudio --start --exit-idle-time=-1 --daemonize`, { stdio: 'ignore' });
    try {
      const pidOut = execSync(`pgrep -f "pulseaudio.*exit-idle-time"`, { encoding: 'utf8' }).trim();
      pulsePid = pidOut ? parseInt(pidOut.split('\n')[0], 10) : null;
    } catch { pulsePid = null; }
    execSync('sleep 1');
    // Create a named sink
    try {
      execSync(`PULSE_SERVER=${PULSE_SERVER} pactl load-module module-null-sink sink_name=${SINK_NAME}`, { stdio: 'ignore' });
      execSync(`PULSE_SERVER=${PULSE_SERVER} pactl set-default-sink ${SINK_NAME}`, { stdio: 'ignore' });
    } catch {}
    console.error('[mibot] PulseAudio started');
  }

  // Set process env so Playwright picks up the display
  process.env.DISPLAY = DISPLAY;
  process.env.PULSE_SERVER = PULSE_SERVER;
}

/** Launch a headed Playwright browser that outputs audio to PulseAudio. */
export async function launchBrowser(): Promise<{ browser: Browser; page: Page }> {
  ensureAudioInfra();

  const blackVideo = path.join(os.homedir(), '.config', 'mibot', 'black.y4m');
  if (!fs.existsSync(blackVideo)) {
    console.error(`[mibot] Warning: black video file not found at ${blackVideo} — fake video capture disabled`);
  }
  // Use headless for fast page loads. Audio capture needs separate approach.
  const useHeaded = process.env.MIBOT_HEADED === '1';
  const browser = await chromium.launch({
    ...(useHeaded ? { executablePath: CHROME_PATH } : {}),
    headless: !useHeaded,
    args: [
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      ...(fs.existsSync(blackVideo) ? [`--use-file-for-fake-video-capture=${blackVideo}`] : []),
      '--disable-blink-features=AutomationControlled',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-features=AudioServiceSandbox,AudioServiceOutOfProcess',
      '--disable-infobars',
      '--excludeSwitches=enable-automation',
      '--window-size=1280,720',
    ],
    env: {
      ...process.env,
      DISPLAY,
      PULSE_SERVER,
    },
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  // Override navigator.webdriver to avoid bot detection (Google Meet checks this)
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    // Override chrome.runtime to hide automation
    (window as any).chrome = { runtime: {}, loadTimes: () => {}, csi: () => {} };
  });

  const page = await context.newPage();
  return { browser, page };
}

/**
 * Start recording audio from Chrome via PulseAudio monitor → ffmpeg → file.
 * R2 (C4): returns the per-recording handle instead of storing a module singleton, so
 * concurrent bots each own their own ffmpeg — stopping one never touches another.
 */
export function startRecording(outputPath: string): ManagedFfmpeg {
  const proc = spawn('ffmpeg', [
    '-y',
    '-f', 'pulse',
    '-i', `${SINK_NAME}.monitor`,
    '-ac', '1',
    '-ar', '16000',
    '-c:a', 'libopus',
    '-b:a', '32k',
    outputPath,
  ], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, PULSE_SERVER },
  });

  // R3 (AU4/AU5/AU6): supervise the child. onError keeps a missing binary from crashing the
  // bot; onUnexpectedExit surfaces a mid-meeting death (pulse restart, ENOSPC) that would
  // otherwise be reported as a successful recording.
  const ffmpeg = new ManagedFfmpeg(proc, {
    onError: (err) => console.error(`[mibot] ffmpeg spawn error: ${err.message}`),
    onUnexpectedExit: ({ code, signal, stderrTail }) => {
      console.error(`[mibot] ffmpeg died mid-recording (code=${code} signal=${signal}): ${stderrTail}`);
    },
  });

  console.error(`[mibot] Recording: ${outputPath}`);
  return ffmpeg;
}

/**
 * Stop a recording and WAIT for ffmpeg to finalize the container before returning (AU4).
 * SIGINT lets ffmpeg write the webm trailer; ManagedFfmpeg escalates to SIGKILL if it hangs,
 * so callers can safely copy/read the file once this resolves.
 */
export async function stopRecording(ffmpeg: ManagedFfmpeg | null): Promise<void> {
  if (ffmpeg) {
    await ffmpeg.stop();
    console.error('[mibot] Recording stopped');
  }
}

/** Kill Xvfb and PulseAudio processes started by ensureAudioInfra(). */
export function cleanupInfra(): void {
  if (xvfbProc) {
    try { xvfbProc.kill(); } catch {}
    xvfbProc = null;
    console.error('[mibot] Xvfb stopped');
  }
  if (pulsePid) {
    try { process.kill(pulsePid); } catch {}
    pulsePid = null;
    console.error('[mibot] PulseAudio stopped');
  }
}
