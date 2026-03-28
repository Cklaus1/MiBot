import { spawn, execSync, type ChildProcess } from 'child_process';
import { chromium, type Browser, type Page } from 'playwright';

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
let ffmpegProc: ChildProcess | null = null;

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

/** Start recording audio from Chrome via PulseAudio monitor → ffmpeg → file. */
export function startRecording(outputPath: string): void {
  ffmpegProc = spawn('ffmpeg', [
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

  ffmpegProc.stderr?.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg.includes('Error') || msg.includes('error')) {
      console.error(`[mibot] ffmpeg: ${msg}`);
    }
  });

  console.error(`[mibot] Recording: ${outputPath}`);
}

/** Stop recording. The file is valid immediately (ffmpeg writes incrementally). */
export function stopRecording(): void {
  if (ffmpegProc) {
    ffmpegProc.kill('SIGINT');
    ffmpegProc = null;
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
