import { type Browser as PWBrowser } from 'playwright';
import path from 'path';
import os from 'os';
import fs from 'fs';
import {
  getOrCreateMeeting, insertRecording, updateMeetingStatus, updateRecording,
  updateMeeting, getMeeting, updateHeartbeat, transaction, applyRecordingStatus,
} from './db.js';
import { RECORDING_STATUS } from './status.js';
import { loadConfig, isBot } from './config.js';
import { SignalTracker } from './signals.js';
import { launchBrowser } from './recorder.js';
import { installAudioCapture } from './webrtc-capture.js';
import { PlaybookEngine, CamofoxPlaybookEngine } from './playbook.js';
import { ControlChannel } from './control.js';
import { waitForMeetingEnd } from './meeting.js';
import { LeavePolicy } from './leave-policy.js';
import { isSimilarImage } from './image-similarity.js';
import { startAudioCapture, stopAudioCapture } from './audio.js';
import { type CaptureSession, webrtcAudioPathFor } from './capture-session.js';
import { transcribe } from './transcribe.js';
import { launchCamofox, type CamofoxPage } from './camofox.js';
import { loadSelectors } from './selectors.js';
import { registerShutdownHook } from './shutdown.js';
import { isNavTimeout, closeOrKill } from './bot-teardown.js';
import { log } from './log.js';

const RECORDINGS_DIR = path.join(os.homedir(), '.config', 'mibot', 'recordings');

/** Detect platform from a meeting URL. */
export function detectPlatform(url: string): 'zoom' | 'teams' | 'meet' | null {
  if (/zoom\.us/i.test(url)) return 'zoom';
  if (/teams\.microsoft\.com|teams\.live\.com/i.test(url)) return 'teams';
  if (/meet\.google\.com/i.test(url)) return 'meet';
  return null;
}

/**
 * M15: extract the People-panel count from a Camofox/Meet accessibility snapshot.
 * Returns null when the People button isn't present so the caller can treat the count
 * as unknown (and NOT trigger a false alone-exit) rather than assuming zero.
 */
export function parsePeopleCount(snapshot: string): number | null {
  const m = snapshot.match(/button "People" \[.*?\]: "(\d+)"/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * M15: convert a raw People count (which includes the bot itself) into a human count for
 * the leave gate. Clamps at 0; passes null through so an unknown count never fabricates a
 * "0 humans" reading that would leave the meeting prematurely.
 */
export function camofoxHumanCount(peopleCount: number | null): number | null {
  if (peopleCount === null) return null;
  return Math.max(0, peopleCount - 1);
}

export interface BotOptions {
  url: string;
  title?: string;
  calendarEventId?: string;
}

/**
 * Join a meeting, record audio, leave when it ends, run audioscript.
 */
export async function joinAndRecord(opts: BotOptions): Promise<number> {
  const config = loadConfig();
  const platform = detectPlatform(opts.url);
  if (!platform) throw new Error(`Unsupported meeting URL: ${opts.url}`);

  const title = opts.title || `${platform} meeting`;
  log.info(`Joining ${platform}: ${title}`, { platform, title });

  // Create DB records. C19: reuse the scheduler's pre-inserted row (keyed by calendar
  // event id) instead of inserting a duplicate on every (re)join attempt.
  const meeting = getOrCreateMeeting({
    title, platform, join_url: opts.url,
    start_time: new Date().toISOString(),
    calendar_event_id: opts.calendarEventId,
  });

  if (!fs.existsSync(RECORDINGS_DIR)) {
    fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
  }
  const audioPath = path.join(RECORDINGS_DIR, `${meeting.id}-${platform}-${Date.now()}.webm`);
  const recording = insertRecording({ meeting_id: meeting.id, audio_path: audioPath });

  updateMeetingStatus(meeting.id, 'joining');

  let controlChannel: ControlChannel | null = null;
  let browser: PWBrowser | null = null;
  let camofoxPage: CamofoxPage | null = null;
  let captureSession: CaptureSession | null = null;

  // C14: close the browser, force-killing a wedged Chromium (holding camera/mic) if it
  // doesn't shut down in time. closeOrKill also clears its own timer so a finished
  // `mibot join` doesn't linger. camofoxPage has no local process handle → no-op killer.
  const closeBrowser = () => browser
    ? closeOrKill(() => browser!.close(), () => {
        // Browser doesn't expose its child process in the public type, but the handle
        // exists at runtime — reach for it to SIGKILL a Chromium that ignored close().
        (browser as unknown as { process?: () => { kill: (s: string) => void } | null })
          .process?.()?.kill('SIGKILL');
      })
    : Promise.resolve();
  const closeCamofox = () => camofoxPage
    ? closeOrKill(() => camofoxPage!.close(), () => {})
    : Promise.resolve();

  // C1: on SIGINT/SIGTERM the graceful-shutdown path must stop THIS bot's children
  // (ffmpeg + browser) — the finally below only runs on normal completion, not on a
  // signal. Register a teardown hook and dispose it in finally so hooks don't pile up.
  const disposeTeardownHook = registerShutdownHook(`bot-${meeting.id}`, async () => {
    if (captureSession) await stopAudioCapture(captureSession).catch(() => {});
    if (controlChannel) controlChannel.stop();
    await closeBrowser();
    await closeCamofox();
  });

  // D3/R1: one heartbeat interval spans the ENTIRE active lifecycle — joining (waiting
  // room), in_call, and the up-to-30-min processing/transcription phase. Previously it was
  // cleared before transcription, so a long transcribe let the heartbeat go stale and
  // recoverStaleMeetings false-killed the row mid-transcribe. Cleared only in finally.
  const heartbeatInterval = setInterval(() => {
    // C12: an unhandled throw inside a setInterval callback is an uncaught exception —
    // a transient SQLite hiccup must not crash the whole bot. Swallow + log.
    try { updateHeartbeat(meeting.id); } catch (err) {
      log.warn(`Heartbeat update failed: ${(err as Error).message}`, { meetingId: meeting.id });
    }
  }, 10000);

  try {
    // Load playbook for this platform
    const playbook = PlaybookEngine.loadForPlatform(platform);
    if (!playbook) throw new Error(`No playbook found for ${platform}. Create ~/.config/mibot/playbooks/${platform}.json`);

    const vars: Record<string, string> = { botName: config.botName, meetingUrl: opts.url };

    if (playbook.browser === 'camofox') {
      // ── Camofox path (Google Meet) ──────────────────────────────────
      camofoxPage = await launchCamofox(opts.url);

      const engine = new CamofoxPlaybookEngine(camofoxPage, vars);
      await engine.run(playbook);

      updateMeeting(meeting.id, { status: 'in_call', actual_start: new Date().toISOString() });
      console.error('[mibot] In call (via camofox). Monitoring...');

      // Install signal observer + audio capture
      await camofoxPage.installSignalObserver();
      await installCamofoxAudioCapture(camofoxPage);

      // Run camofox monitoring loop
      const result = await monitorCamofoxMeeting(camofoxPage, meeting.id, audioPath, config);

      // Save results
      await camofoxPage.close();
      camofoxPage = null;

      const haveAudio = fs.existsSync(audioPath) && fs.statSync(audioPath).size > 1000;

      // Wrap DB updates in transaction to prevent partial writes
      transaction(() => {
        updateMeeting(meeting.id, {
          status: 'processing',
          actual_end: new Date().toISOString(),
          participants: JSON.stringify(result.participants),
          speaker_timeline: JSON.stringify(result.speakerTimeline),
        });

        applyRecordingStatus(recording.id, haveAudio ? RECORDING_STATUS.RECORDED : RECORDING_STATUS.NO_AUDIO);
      });

      // Write metadata sidecar
      writeMetadata(meeting, recording, opts, platform, title, result);

      // C5: the camofox (Google Meet) path previously jumped straight to 'done'
      // without ever transcribing. Run the same pipeline as the Playwright path.
      if (haveAudio) {
        const outcome = await transcribe(recording.id, audioPath, result.participants, result.speakerTimeline);
        applyRecordingStatus(recording.id, outcome);
      }

      updateMeetingStatus(meeting.id, 'done');
      return recording.id;

    } else {
      // ── Playwright path (Teams / Zoom) ──────────────────────────────
      const launch = await launchBrowser();
      browser = launch.browser;
      const page = launch.page;

      // FA/R4 (AU1/AU2): one hook, installed on the context so it runs in every frame
      // (Zoom's iframe WebRTC) and survives navigation. Must precede the first goto.
      await installAudioCapture(page.context());

      await page.goto(opts.url, { waitUntil: 'networkidle', timeout: 30000 }).catch((err: Error) => {
        // C15: only continue past a networkidle timeout (page usually loaded enough to join).
        // A real nav failure (DNS/refused/bad URL) must abort — otherwise the playbook runs
        // against about:blank and fails minutes later with a misleading "step not found".
        if (!isNavTimeout(err)) throw err;
        console.error(`[mibot] Navigation timeout (continuing): ${err.message.substring(0, 80)}`);
      });

      controlChannel = new ControlChannel(page, meeting.id);
      controlChannel.start();

      // Zoom-specific variables
      const zoomMatch = opts.url.match(/zoom\.us\/j\/(\d+)(?:\?pwd=([^&]+))?/);
      if (zoomMatch) {
        vars.zoomMeetingId = zoomMatch[1];
        vars.zoomPassword = zoomMatch[2] || '';
        vars.zoomDirectUrl = `https://app.zoom.us/wc/join/${zoomMatch[1]}${zoomMatch[2] ? '?pwd=' + zoomMatch[2] : ''}`;
      } else if (platform === 'zoom') {
        vars.zoomDirectUrl = opts.url;
      }

      const engine = new PlaybookEngine(page, vars);
      await engine.run(playbook);

      updateMeeting(meeting.id, { status: 'in_call', actual_start: new Date().toISOString() });
      console.error('[mibot] In call. Recording...');

      captureSession = startAudioCapture(page, audioPath);
      const signalTracker = new SignalTracker(RECORDINGS_DIR, meeting.id);

      const { participants: trackedParticipants, speakerTimeline } = await waitForMeetingEnd(page, platform, config, signalTracker);
      const signals = signalTracker.finish();

      console.error('[mibot] Leaving. Saving audio...');
      await stopAudioCapture(captureSession);
      captureSession = null; // stopped cleanly; finally's safety-net stop is now a no-op

      const haveAudio = fs.existsSync(audioPath) && fs.statSync(audioPath).size > 1000;

      // Wrap DB updates in transaction to prevent partial writes
      transaction(() => {
        updateMeeting(meeting.id, {
          status: 'processing',
          actual_end: new Date().toISOString(),
          participants: JSON.stringify(trackedParticipants),
          speaker_timeline: JSON.stringify(speakerTimeline),
        });

        // 'recorded' is non-terminal (transcribe will advance it); 'no_audio' is terminal.
        applyRecordingStatus(recording.id, haveAudio ? RECORDING_STATUS.RECORDED : RECORDING_STATUS.NO_AUDIO);
      });

      if (haveAudio) {
        const metadataPath = audioPath.replace(/\.\w+$/, '.json');
        const meetingData = getMeeting(meeting.id);
        const metadata = {
          meeting: {
            id: meeting.id, title, platform, join_url: opts.url,
            scheduled_start: meeting.start_time, scheduled_end: meeting.end_time,
            actual_start: meetingData?.actual_start, actual_end: meetingData?.actual_end,
          },
          calendar: {
            event_id: opts.calendarEventId, organizer: meetingData?.organizer,
            organizer_email: meetingData?.organizer_email, location: meetingData?.location,
            description: meetingData?.description,
            attendees: meetingData?.attendees ? (() => { try { return JSON.parse(meetingData.attendees); } catch { return []; } })() : [],
            is_recurring: meetingData?.is_recurring === 1,
          },
          participants: trackedParticipants,
          speaker_timeline: speakerTimeline,
          signals: { chat: signals.chat, reactions: signals.reactions, hand_raises: signals.hand_raises, screen_shares: signals.screen_shares },
          recording: { id: recording.id, audio_path: audioPath, format: 'audio/webm' },
          generated_at: new Date().toISOString(),
        };
        fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
        updateRecording(recording.id, { metadata_path: metadataPath });
        console.error(`[mibot] Metadata: ${metadataPath}`);
      } else {
        console.error('[mibot] Warning: recording file is empty');
      }

      if (controlChannel) controlChannel.stop();
      controlChannel = null;
      await closeBrowser();
      browser = null;

      if (haveAudio) {
        // T1/C7: persist the *outcome* transcribe reports (done / transcribe_failed),
        // reconciled so a stale 'done' can't clobber a real failure. If there was no
        // audio, the recording is already terminal ('no_audio') and left untouched.
        const outcome = await transcribe(recording.id, audioPath, trackedParticipants, speakerTimeline);
        applyRecordingStatus(recording.id, outcome);
      }
      updateMeetingStatus(meeting.id, 'done');
      return recording.id;
    }

  } catch (err) {
    log.error(`Bot error: ${(err as Error).message}`, { meetingId: meeting.id });
    updateMeetingStatus(meeting.id, 'failed');
    // C7: never downgrade a recording that already reached a terminal outcome
    // (done / transcribe_failed / no_audio) just because a later step threw.
    applyRecordingStatus(recording.id, RECORDING_STATUS.FAILED);
    throw err;
  } finally {
    clearInterval(heartbeatInterval);
    disposeTeardownHook(); // this bot's children are torn down below; drop the signal hook
    // Safety-net: if the happy path didn't already stop the session (error mid-meeting),
    // stop it here so ffmpeg is finalized and killed. No-op after a clean stop.
    if (captureSession) await stopAudioCapture(captureSession).catch(() => {});
    if (controlChannel) controlChannel.stop();
    await closeBrowser();
    await closeCamofox();
  }
}

// ── Camofox audio capture ─────────────────────────────────────────────

const WEBRTC_HOOK = `
  if (!window.__mibotHooked) {
    window.__mibotHooked = true;
    const origRTC = window.RTCPeerConnection;
    window.RTCPeerConnection = function(...args) {
      const pc = new origRTC(...args);
      pc.addEventListener('track', (event) => {
        if (event.track.kind === 'audio') {
          if (!window.__mibotAudioCtx) {
            window.__mibotAudioCtx = new AudioContext();
            window.__mibotDest = window.__mibotAudioCtx.createMediaStreamDestination();
            window.__mibotSources = [];
          }
          const stream = new MediaStream([event.track]);
          const source = window.__mibotAudioCtx.createMediaStreamSource(stream);
          source.connect(window.__mibotDest);
          window.__mibotSources.push(source);
          if (!window.__mibotRecorder) {
            const recorder = new MediaRecorder(window.__mibotDest.stream, {
              mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 64000
            });
            const chunks = [];
            recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
            recorder.start(1000);
            window.__mibotRecorder = recorder;
            window.__mibotChunks = chunks;
            window.__mibotFlushedChunks = [];
            setInterval(() => {
              if (chunks.length > 0) window.__mibotFlushedChunks.push(...chunks.splice(0));
            }, 5000);
            console.log('[mibot] WebRTC audio capture started');
          }
        }
      });
      return pc;
    };
    window.RTCPeerConnection.prototype = origRTC.prototype;
    console.log('[mibot] WebRTC hook installed');
  }
`;

const AUDIO_ELEMENT_CAPTURE = `
  (() => {
    if (window.__mibotAudioCapture) return 'already running';
    if (window.__mibotRecorder) return 'rtc hook active';
    const audioEls = document.querySelectorAll('audio');
    if (audioEls.length === 0) return 'no audio elements';
    const ctx = new AudioContext();
    const dest = ctx.createMediaStreamDestination();
    let connected = 0;
    audioEls.forEach(el => {
      try {
        const stream = el.captureStream ? el.captureStream() : el.mozCaptureStream();
        if (stream) { ctx.createMediaStreamSource(stream).connect(dest); connected++; }
      } catch(e) {}
    });
    if (connected === 0) return 'no streams captured';
    const recorder = new MediaRecorder(dest.stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 64000 });
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
    recorder.start(1000);
    window.__mibotAudioCapture = true;
    window.__mibotRecorder = recorder;
    window.__mibotChunks = chunks;
    window.__mibotFlushedChunks = [];
    window.__mibotAudioCtx = ctx;
    setInterval(() => { if (chunks.length > 0) window.__mibotFlushedChunks.push(...chunks.splice(0)); }, 5000);
    return 'capturing ' + connected + ' audio streams';
  })()
`;

const AUDIO_FLUSH_EXPR = `
  (() => {
    const flushed = window.__mibotFlushedChunks;
    if (!flushed || flushed.length === 0) return '';
    const chunks = flushed.splice(0);
    return new Promise(resolve => {
      const blob = new Blob(chunks, { type: 'audio/webm' });
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',')[1] || '');
      reader.readAsDataURL(blob);
    });
  })()
`;

const AUDIO_FINAL_FLUSH_EXPR = `
  (() => {
    const flushed = window.__mibotFlushedChunks || [];
    const chunks = window.__mibotChunks || [];
    const all = [...flushed, ...chunks];
    if (all.length === 0) return '';
    return new Promise(resolve => {
      const blob = new Blob(all, { type: 'audio/webm' });
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',')[1] || '');
      reader.readAsDataURL(blob);
    });
  })()
`;

/** Install both WebRTC hook and audio element capture fallback. */
async function installCamofoxAudioCapture(page: CamofoxPage): Promise<void> {
  // WebRTC hook (for future connections)
  await page.eval(WEBRTC_HOOK).catch(() => {});
  console.error('[mibot] WebRTC audio hook injected');

  // Fallback: capture from <audio> elements after a short delay
  setTimeout(async () => {
    try {
      const result = await page.eval(AUDIO_ELEMENT_CAPTURE);
      console.error(`[mibot] Audio element capture: ${result}`);
    } catch {}
  }, 5000);
}

/** Flush captured audio chunks to disk. Returns bytes written. */
async function flushCamofoxAudio(page: CamofoxPage, outputPath: string): Promise<number> {
  try {
    const audioChunk = await page.eval(AUDIO_FLUSH_EXPR) as string;
    if (audioChunk && audioChunk.length > 10) {
      const buf = Buffer.from(audioChunk, 'base64');
      fs.appendFileSync(outputPath, buf);
      return fs.statSync(outputPath).size;
    }
  } catch (err) {
    log.warn(`Audio flush failed: ${(err as Error).message}`);
  }
  return fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0;
}

// ── Camofox monitoring loop ───────────────────────────────────────────

interface CamofoxMonitorResult {
  participants: any[];
  speakerTimeline: any[];
  signals: {
    chat: any[];
    reactions: any[];
    hand_raises: any[];
    screen_shares: any[];
  };
}

async function monitorCamofoxMeeting(
  page: CamofoxPage,
  meetingId: number,
  audioPath: string,
  config: ReturnType<typeof loadConfig>,
): Promise<CamofoxMonitorResult> {
  const allSignals: Array<{ raw: string; type: string; who: string; detail: string; time: string }> = [];
  const participantMap = new Map<string, { name: string; joined_at: string; left_at: string | null; is_bot: boolean; spoke: boolean }>();
  const speakerSegments: Array<{ speaker: string; start: string; end: string | null }> = [];
  let currentSpeaker: string | null = null;
  let currentSpeakerStart: string | null = null;
  const startTime = Date.now();
  const maxMs = config.maxDurationHours * 60 * 60 * 1000;
  let lastParticipantCount = -1;

  // M15: the camofox loop had NO alone-detection — it broke only on maxDuration or the "Leave
  // call" button vanishing, so a Meet call everyone left recorded silence for up to maxDuration.
  // Reuse the same pure LeavePolicy the Playwright path uses, fed the People-panel count minus
  // the bot itself. Warm-up + config mapping mirror meeting.ts exactly.
  const policy = new LeavePolicy(
    {
      minHumansToStay: config.minHumansToStay,
      aloneTimeoutMs: config.aloneTimeoutMinutes * 60 * 1000,
      leaveGracePeriodMs: config.leaveGracePeriodSeconds * 1000,
      maxDurationMs: maxMs,
      leaveButtonMissesToEnd: 2,
      emptyPollsToTrigger: 2,
    },
    startTime,
  );
  const MIN_CALL_SECONDS = 60; // Warm-up: don't ACT on "ended"/"alone" in the first 60 seconds
  let lastKnownHumanCount = 1; // Unknown People count → assume a human present (never false-exit)
  let isPresenting = false;
  let lastScreenshotTime = 0;
  let lastScreenshotBuf: Buffer | null = null;
  let screenshotCount = 0;
  const screenshotPaths: string[] = [];
  const screenshotDir = path.join(RECORDINGS_DIR, `screenshots-${meetingId}`);
  if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true });
  const webrtcAudioPath = webrtcAudioPathFor(audioPath);
  let lastAudioFlush = 0;

  while (Date.now() - startTime < maxMs) {
    await page.waitForTimeout(5000);
    const inWarmup = Date.now() - startTime < MIN_CALL_SECONDS * 1000;

    // Heartbeat — proves bot is alive. C12: a transient SQLite error here must not
    // throw out of the monitor loop and skip the final audio flush + promotion.
    try { updateHeartbeat(meetingId); } catch (err) {
      log.warn(`Heartbeat update failed: ${(err as Error).message}`, { meetingId });
    }

    // Check if still in the call. A single flaky miss must NOT end the meeting (M7 debounce
    // lives in LeavePolicy); we track the signal here and let the policy decide at poll end.
    const inCall = await page.isTextVisible('Leave call').catch(() => false);

    // Drain signals from MutationObserver
    try {
      const newSignals = await page.drainSignals();
      for (const sig of newSignals) {
        allSignals.push(sig);
        const icon = sig.type === 'chat' ? '💬' : sig.type === 'reaction' ? '🎉' : sig.type === 'hand' ? '✋' : '📢';
        console.error(`[mibot] ${icon} ${sig.raw}`);
      }
    } catch {}

    // Scrape aria-live regions for chat
    try {
      const ariaChat = await page.eval(`
        (() => {
          const regions = document.querySelectorAll('[aria-live], [role=log]');
          for (const el of regions) {
            const text = el.textContent?.trim() || '';
            if (text.includes('AM') || text.includes('PM')) return text;
          }
          return '';
        })()
      `) as string;
      if (ariaChat && ariaChat.length > 10) {
        const chatMatches = ariaChat.matchAll(/([A-Za-z ]+?)(\d{1,2}:\d{2}\s*[AP]M)(.+?)(?=[A-Z][a-z]+ \d{1,2}:\d{2}\s*[AP]M|$)/g);
        for (const match of chatMatches) {
          const sender = match[1].trim();
          const text = match[3].trim();
          if (text && !allSignals.some(s => s.type === 'chat' && s.detail === text && s.who === sender)) {
            allSignals.push({ raw: `${sender} says in chat: ${text}`, type: 'chat', who: sender, detail: text, time: new Date().toISOString() });
            console.error(`[mibot] 💬 ${sender}: ${text}`);
          }
        }
      }
    } catch {}

    // Participants, hand raises, screen share, active speaker detection
    try {
      const { snapshot } = await page.snapshot();

      // Extract participant names from snapshot (Meet shows names in various elements)
      const participantNames = await page.eval(`
        (() => {
          const names = new Set();
          // Video tiles show participant names
          document.querySelectorAll('[data-self-name]').forEach(el => {
            const n = el.getAttribute('data-self-name');
            if (n) names.add(n);
          });
          // People panel list items
          document.querySelectorAll('[data-participant-id]').forEach(el => {
            const n = el.textContent?.trim();
            if (n && n.length < 100) names.add(n);
          });
          // Fallback: parse participant names from accessible labels
          document.querySelectorAll('[aria-label]').forEach(el => {
            const label = el.getAttribute('aria-label') || '';
            const m = label.match(/^(.+?)(?:'s video| is presenting| raised)/);
            if (m) names.add(m[1]);
          });
          return [...names];
        })()
      `) as string[];
      if (participantNames && participantNames.length > 0) {
        const now = new Date().toISOString();
        const currentNames = new Set(participantNames);
        for (const name of participantNames) {
          if (!participantMap.has(name)) {
            participantMap.set(name, { name, joined_at: now, left_at: null, is_bot: isBot(name), spoke: false });
          } else {
            const p = participantMap.get(name)!;
            if (p.left_at) { p.left_at = null; } // rejoined
          }
        }
        // Mark participants who left
        for (const [name, p] of participantMap) {
          if (!currentNames.has(name) && !p.left_at) {
            p.left_at = now;
          }
        }
      }

      // Detect active speaker from snapshot. Overlay selectors are config-driven
      // (Meet's minified classes churn) — shared with the Playwright path via selectors.ts.
      const overlaySel = loadSelectors('meet').activeSpeaker.join(', ');
      const speakerResult = await page.eval(`
        (() => {
          // Meet highlights active speaker with blue border or shows name overlay
          const active = document.querySelector('[data-self-name][data-is-speaking="true"]');
          if (active) return active.getAttribute('data-self-name');
          // Speaker name overlay classes (fragile — from selectors config)
          const overlaySel = ${JSON.stringify(overlaySel)};
          const overlay = overlaySel ? document.querySelector(overlaySel) : null;
          if (overlay?.textContent?.trim()) return overlay.textContent.trim();
          return null;
        })()
      `) as string | null;
      if (speakerResult !== currentSpeaker) {
        const now = new Date().toISOString();
        if (currentSpeaker && currentSpeakerStart) {
          speakerSegments.push({ speaker: currentSpeaker, start: currentSpeakerStart, end: now });
        }
        currentSpeaker = speakerResult;
        currentSpeakerStart = speakerResult ? now : null;
        if (speakerResult) {
          const p = participantMap.get(speakerResult);
          if (p) p.spoke = true;
        }
      }

      const count = parsePeopleCount(snapshot);
      if (count !== null) {
        // M15: People count includes the bot; humans = count - 1. Only overwrite the last-known
        // count when we actually parsed it (an unknown snapshot must not read as "0 humans").
        lastKnownHumanCount = camofoxHumanCount(count) ?? lastKnownHumanCount;
        if (count !== lastParticipantCount) {
          console.error(`[mibot] Participants: ${count}${participantMap.size > 0 ? ` (${[...participantMap.keys()].join(', ')})` : ''}`);
          lastParticipantCount = count;
        }
      }
      const handMatch = snapshot.match(/button "Hand raises" \[.*?\]: (.+)/);
      if (handMatch) {
        const who = handMatch[1].trim();
        if (!allSignals.some(s => s.type === 'hand' && s.who === who && s.detail === 'raised')) {
          allSignals.push({ raw: `${who} raised a hand`, type: 'hand', who, detail: 'raised', time: new Date().toISOString() });
          console.error(`[mibot] ✋ ${who} raised a hand`);
        }
      }
      const presentMatch = snapshot.match(/heading "(.+?) \(Presenting\)"/);
      if (presentMatch) {
        const presenter = presentMatch[1];
        if (!isPresenting) {
          isPresenting = true;
          allSignals.push({ raw: `${presenter} is presenting`, type: 'screenshare', who: presenter, detail: 'started', time: new Date().toISOString() });
          console.error(`[mibot] 🖥️ ${presenter} is presenting`);
        }
        if (Date.now() - lastScreenshotTime >= 30000) {
          const screenshotBuf = await page.screenshot({ path: undefined });
          if (screenshotBuf.length > 1000) {
            if (!lastScreenshotBuf || !isSimilarImage(lastScreenshotBuf, screenshotBuf, 0.08)) {
              const ssPath = path.join(screenshotDir, `share-${Date.now()}.jpg`);
              fs.writeFileSync(ssPath, screenshotBuf);
              screenshotPaths.push(ssPath);
              screenshotCount++;
              lastScreenshotBuf = screenshotBuf;
              console.error(`[mibot] 📸 Screenshot ${screenshotCount}: ${ssPath}`);
            }
          }
          lastScreenshotTime = Date.now();
        }
      } else if (isPresenting) {
        isPresenting = false;
        allSignals.push({ raw: 'Presentation stopped', type: 'screenshare', who: '', detail: 'stopped', time: new Date().toISOString() });
        console.error('[mibot] 🖥️ Presentation stopped');
      }
    } catch {}

    // Flush audio every 15 seconds
    if (Date.now() - lastAudioFlush >= 15000) {
      try {
        const totalBytes = await flushCamofoxAudio(page, webrtcAudioPath);
        if (totalBytes > 0) {
          console.error(`[mibot] 🎙️ Audio flush: ${(totalBytes / 1024).toFixed(0)} KB total`);
        }
      } catch {}
      lastAudioFlush = Date.now();
    }

    // M15: single leave gate. During warm-up we track but never act on a missing button
    // (mirror meeting.ts). The policy owns duration cap, leave-button debounce, alone-timeout,
    // and empty-grace — all previously absent from this loop.
    const decision = policy.observe(
      { humanCount: lastKnownHumanCount, hasLeaveButton: inWarmup ? true : inCall },
      Date.now(),
    );
    if (decision.action === 'leave') {
      console.error(`[mibot] Leaving — ${decision.reason}`);
      break;
    }
  }

  console.error('[mibot] Leaving meeting...');

  // Final audio flush
  try {
    const finalAudio = await page.eval(AUDIO_FINAL_FLUSH_EXPR) as string;
    if (finalAudio && finalAudio.length > 10) {
      fs.appendFileSync(webrtcAudioPath, Buffer.from(finalAudio, 'base64'));
    }
  } catch {}

  // Copy WebRTC audio to main audio path
  if (fs.existsSync(webrtcAudioPath) && fs.statSync(webrtcAudioPath).size > 1000) {
    fs.copyFileSync(webrtcAudioPath, audioPath);
    console.error(`[mibot] Audio saved: ${(fs.statSync(audioPath).size / 1024).toFixed(0)} KB`);
  }

  // Final signal drain
  const finalSignals = await page.drainSignals().catch(() => []);
  allSignals.push(...finalSignals);

  const signals = {
    chat: allSignals.filter(s => s.type === 'chat').map(s => ({ sender: s.who, text: s.detail, timestamp: s.time })),
    reactions: allSignals.filter(s => s.type === 'reaction').map(s => ({ participant: s.who, type: s.detail, timestamp: s.time })),
    hand_raises: allSignals.filter(s => s.type === 'hand').map(s => ({ participant: s.who, raised_at: s.time, lowered_at: null })),
    screen_shares: allSignals.filter(s => s.type === 'screenshare' && s.detail === 'started').map(s => ({ presenter: s.who, started_at: s.time, ended_at: null, screenshots: screenshotPaths })),
  };
  console.error(`[mibot] Signals: ${signals.chat.length} chat, ${signals.reactions.length} reactions, ${signals.hand_raises.length} hands`);

  // Close any open speaker segment
  if (currentSpeaker && currentSpeakerStart) {
    speakerSegments.push({ speaker: currentSpeaker, start: currentSpeakerStart, end: new Date().toISOString() });
  }

  // Close any open participant leave times
  const endTime = new Date().toISOString();
  for (const p of participantMap.values()) {
    if (!p.left_at) p.left_at = endTime;
  }

  const participants = [...participantMap.values()];
  console.error(`[mibot] Participants tracked: ${participants.length} (${participants.filter(p => p.spoke).length} spoke)`);
  console.error(`[mibot] Speaker segments: ${speakerSegments.length}`);

  return { participants, speakerTimeline: speakerSegments, signals };
}

// ── Helpers ───────────────────────────────────────────────────────────

/** Write metadata sidecar JSON file. */
function writeMetadata(
  meeting: any, recording: any, opts: BotOptions,
  platform: string, title: string, result: CamofoxMonitorResult,
): void {
  const metadataPath = path.join(RECORDINGS_DIR, `${meeting.id}-${platform}-metadata.json`);
  const meetingData = getMeeting(meeting.id);
  const metadata = {
    meeting: {
      id: meeting.id, title, platform, join_url: opts.url,
      scheduled_start: meeting.start_time, scheduled_end: meeting.end_time,
      actual_start: meetingData?.actual_start, actual_end: meetingData?.actual_end,
    },
    calendar: {
      event_id: opts.calendarEventId, organizer: meetingData?.organizer,
      organizer_email: meetingData?.organizer_email,
    },
    participants: result.participants,
    speaker_timeline: result.speakerTimeline,
    signals: result.signals,
    recording: { id: recording.id, format: 'audio/webm' },
    generated_at: new Date().toISOString(),
  };
  fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
  updateRecording(recording.id, { metadata_path: metadataPath });
  console.error(`[mibot] Metadata: ${metadataPath}`);
}
