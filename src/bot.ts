import { drainAudioOnce, type DrainDeps } from './audio-drain.js';
import { type Browser as PWBrowser } from 'playwright';
import path from 'path';
import os from 'os';
import fs from 'fs';
import {
  getOrCreateMeeting, insertRecording, updateMeetingStatus, updateRecording,
  updateMeeting, getMeeting, updateHeartbeat, transaction, applyRecordingStatus, handleJoinFailure,
} from './db.js';
import { RECORDING_STATUS } from './status.js';
import { loadConfig, isBot } from './config.js';
import { SignalTracker } from './signals.js';
import { launchBrowser } from './recorder.js';
import { installAudioCapture } from './webrtc-capture.js';
import { PlaybookEngine, CamofoxPlaybookEngine } from './playbook.js';
import { ControlChannel } from './control.js';
import { waitForMeetingEnd, SpeakerTracker } from './meeting.js';
import { RosterTracker } from './roster.js';
import { LeavePolicy } from './leave-policy.js';
import { isSimilarImage } from './image-similarity.js';
import { startAudioCapture, stopAudioCapture } from './audio.js';
import { type CaptureSession, webrtcAudioPathFor, hasUsableAudio } from './capture-session.js';
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
  for (const re of PEOPLE_COUNT_PATTERNS) {
    const m = snapshot.match(re);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

/**
 * Accepted shapes for the People control in a Meet a11y snapshot.
 *
 * This started as a single pattern matched against no recorded snapshot. If Meet renders the
 * control even slightly differently, the count never parses, `lastKnownHumanCount` stays at
 * its 1 default forever, and M15's alone-detection silently never fires — the bot records an
 * empty room to maxDuration, which is exactly the bug M15 was written to fix. A miss is
 * therefore invisible, so tolerate the plausible renderings rather than betting on one.
 * Ordered most- to least-specific; each must capture the digits in group 1.
 */
/** ~1 minute of 5s polls: past the warm-up, so a real join has had time to render the panel. */
const PEOPLE_COUNT_WARN_AFTER = 12;

const PEOPLE_COUNT_PATTERNS: RegExp[] = [
  /button "People" \[.*?\]: "(\d+)"/,        // original: value rendered after the ref
  /button "People \((\d+)\)"/,               // count inlined in the label
  /button "(\d+) (?:participants?|people)"/i, // aria-label carries the count
  // Deliberately NO "any digits on the People line" catch-all: it read attribute digits
  // (`[nth=1]`, `[level=2]`) as the count, and a count of 1 means 0 humans — a false
  // alone-exit ~40s into a real meeting. An unparsed count is the safe failure (the loop keeps
  // assuming a human is present and the miss warning fires); a wrong count is not.
];

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

  // Claim the row: recovery only fails a stale meeting whose owner process is gone (Wave 9-A).
  updateMeeting(meeting.id, { status: 'joining', owner_pid: process.pid });

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

      // Decode-based, not byte-size: a silent null-sink recording is large but has no audio.
      const haveAudio = await hasUsableAudio(audioPath);

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

      // Decode-based, not byte-size: a silent null-sink recording is large but has no audio.
      const haveAudio = await hasUsableAudio(audioPath);

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
    // A failed JOIN of a calendar meeting is retried with backoff until the meeting ends; any
    // other failure (after in_call, manual join, meeting over) is terminal as before.
    const plan = handleJoinFailure(meeting.id);
    if (plan.retry) {
      console.error(`[mibot] Join attempt ${plan.attempt} failed — retrying in ${Math.round(plan.delayMs / 60000)} min (until the meeting ends)`);
    }
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
            window.__mibotFlushInterval = setInterval(() => {
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

export const AUDIO_ELEMENT_CAPTURE = `
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
    // Fix 5: publish the destination too. The WebRTC hook's track handler sees __mibotAudioCtx
    // already set and skips its own setup, then connects each new track to __mibotDest. With
    // only the context published, that was connect(undefined) -> TypeError, so everyone who
    // joined after this fallback fired was silently never recorded.
    window.__mibotDest = dest;
    window.__mibotSources = [];
    // Keep the handle: the AU3 stop-and-fold clears it so no fold can race the final drain.
    window.__mibotFlushInterval = setInterval(() => { if (chunks.length > 0) window.__mibotFlushedChunks.push(...chunks.splice(0)); }, 5000);
    return 'capturing ' + connected + ' audio streams';
  })()
`;

// AU8/DRAIN, camofox side. The Playwright path (webrtc-capture.ts) reads NON-destructively
// and only removes chunks after the bytes are on disk; this path used to `splice(0)` in-page
// BEFORE the payload had crossed the REST boundary, so any failed transfer or throwing
// appendFileSync (ENOSPC) permanently lost that 5s window. These two expressions are the
// read and ack halves of the same two-phase protocol; drainAudioOnce sequences them.
const AUDIO_READ_EXPR = `
  (() => {
    const flushed = window.__mibotFlushedChunks;
    if (!flushed || flushed.length === 0) return { b64: '', count: 0 };
    const count = flushed.length;
    const snapshot = flushed.slice(0, count); // copy — NOT splice
    return new Promise(resolve => {
      const blob = new Blob(snapshot, { type: 'audio/webm' });
      const reader = new FileReader();
      reader.onload = () => resolve({ b64: reader.result.split(',')[1] || '', count });
      reader.onerror = () => resolve({ b64: '', count: 0 }); // AU7: never hang on read failure
      reader.onabort = () => resolve({ b64: '', count: 0 });
      reader.readAsDataURL(blob);
    });
  })()
`;

const audioAckExpr = (count: number) => `
  (() => {
    const flushed = window.__mibotFlushedChunks;
    if (flushed) flushed.splice(0, ${count});
    return true;
  })()
`;

// AU3 tail capture, camofox side. The old final flush just concatenated whatever happened to
// be in the buffers — it never called requestData()/stop(), so the last partial segment (up to
// one 5s tick) was dropped from EVERY Meet recording. Stop the recorder, await its final
// ondataavailable, fold the tail into the flushed buffer, then drain it normally.
const AUDIO_STOP_AND_FOLD_EXPR = `
  (() => {
    const w = window;
    if (w.__mibotFlushInterval) { clearInterval(w.__mibotFlushInterval); w.__mibotFlushInterval = null; }
    const recorder = w.__mibotRecorder;
    const chunks = w.__mibotChunks;
    const flushed = w.__mibotFlushedChunks;
    if (!chunks || !flushed) return false;
    return new Promise(resolve => {
      const fold = () => { flushed.push(...chunks.splice(0)); resolve(true); };
      if (recorder && recorder.state === 'recording') {
        recorder.onstop = () => fold();
        try { recorder.requestData(); } catch (e) {}
        recorder.stop();
        setTimeout(() => fold(), 3000); // safety: don't wait forever for onstop
      } else {
        fold();
      }
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

/** Bound the in-page read so a wedged FileReader can't stall the monitor loop (AU7). */
const CAMOFOX_READ_TIMEOUT_MS = 15000;

/** DRAIN deps for the camofox page — the read/append/ack triple drainAudioOnce sequences. */
export function camofoxDrainDeps(page: CamofoxPage, outputPath: string): DrainDeps {
  return {
    readEncoded: async () => {
      const r = await page.eval(AUDIO_READ_EXPR) as { b64?: string; count?: number } | null;
      return { b64: r?.b64 ?? '', count: r?.count ?? 0 };
    },
    append: (buf) => fs.appendFileSync(outputPath, buf),
    ack: async (count) => { await page.eval(audioAckExpr(count)); },
    timeoutMs: CAMOFOX_READ_TIMEOUT_MS,
  };
}

/** Flush captured audio chunks to disk via the DRAIN protocol. Returns bytes on disk. */
async function flushCamofoxAudio(page: CamofoxPage, outputPath: string): Promise<number> {
  try {
    await drainAudioOnce(camofoxDrainDeps(page, outputPath));
  } catch (err) {
    // append threw (e.g. ENOSPC): ack was skipped, so the page buffer still holds the
    // window and the next tick retries it. Nothing is lost by returning here.
    log.warn(`Audio flush failed: ${(err as Error).message}`);
  }
  return fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0;
}

/** AU3: stop the recorder, fold in the tail, then drain what's left exactly once. */
export async function finalizeCamofoxAudio(page: CamofoxPage, outputPath: string): Promise<boolean> {
  try {
    await page.eval(AUDIO_STOP_AND_FOLD_EXPR);
  } catch { /* recorder may already be gone — still try to drain what's buffered */ }
  try {
    const res = await drainAudioOnce(camofoxDrainDeps(page, outputPath));
    return res.appended;
  } catch (err) {
    log.warn(`Final audio drain failed: ${(err as Error).message}`);
    return false;
  }
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
  // AR1 slice: the roster diff and speaker segmentation are the same browser-independent
  // bookkeeping the Playwright loop does. They were hand-rolled a second time here and had
  // drifted — this copy never logged join/leave and never reclassified a bot. Both loops now
  // share RosterTracker + SpeakerTracker.
  const roster = new RosterTracker((msg) => console.error(`[mibot] ${msg}`));
  const speakerTracker = new SpeakerTracker();
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
  let peopleCountMisses = 0;   // consecutive polls with no parseable People count
  let snapshotDumped = false;  // dump the first snapshot once per meeting (verification aid)
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

      // Item 1 live-verification hook: the People-count regexes have never been checked
      // against a real Meet snapshot (none was ever recorded). Dump the first one per meeting
      // so any live call leaves an artifact to verify the parse against, without needing a
      // control channel on this path (ControlChannel is Playwright-only).
      if (!snapshotDumped) {
        snapshotDumped = true;
        try {
          const dumpPath = path.join(screenshotDir, 'snapshot-first.txt');
          fs.writeFileSync(dumpPath, snapshot);
          console.error(`[mibot] Snapshot dumped for verification: ${dumpPath} (People count parsed: ${parsePeopleCount(snapshot)})`);
        } catch { /* diagnostics must never break the loop */ }
      }

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
        roster.observe(new Map(participantNames.map((n) => [n, isBot(n)])));
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
      speakerTracker.update(speakerResult);
      if (speakerResult) roster.markSpoke(speakerResult);

      const count = parsePeopleCount(snapshot);
      if (count === null) {
        peopleCountMisses++;
        // A never-parsing People count is silent: the loop just keeps its 1-human default and
        // never alone-exits. Say so once, with a snippet, so a live run diagnoses itself
        // instead of the failure only showing up as a maxDuration recording of an empty room.
        if (peopleCountMisses === PEOPLE_COUNT_WARN_AFTER) {
          const line = snapshot.split('\n').find((l) => l.includes('People')) ?? '(no "People" line in snapshot)';
          log.warn(`People count unparsed after ${peopleCountMisses} polls — alone-detection is inactive. Snapshot line: ${line.trim().slice(0, 200)}`);
        }
      }
      if (count !== null) {
        peopleCountMisses = 0;
        // M15: People count includes the bot; humans = count - 1. Only overwrite the last-known
        // count when we actually parsed it (an unknown snapshot must not read as "0 humans").
        lastKnownHumanCount = camofoxHumanCount(count) ?? lastKnownHumanCount;
        if (count !== lastParticipantCount) {
          console.error(`[mibot] Participants: ${count}${roster.size > 0 ? ` (${roster.names().join(', ')})` : ''}`);
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

  // Final audio drain — AU3 stop-and-drain, so the meeting's last partial segment lands.
  await finalizeCamofoxAudio(page, webrtcAudioPath);

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

  const speakerSegments = speakerTracker.finish();
  const participants = roster.finish();
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
