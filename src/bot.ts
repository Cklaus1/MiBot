import { type Browser as PWBrowser } from 'playwright';
import path from 'path';
import os from 'os';
import fs from 'fs';
import {
  insertMeeting, insertRecording, updateMeetingStatus, updateRecording,
  updateMeeting, getMeeting, updateHeartbeat, transaction,
} from './db.js';
import { loadConfig } from './config.js';
import { SignalTracker } from './signals.js';
import { launchBrowser, stopRecording } from './recorder.js';
import { injectAudioCaptureAllFrames } from './webrtc-capture.js';
import { PlaybookEngine, CamofoxPlaybookEngine } from './playbook.js';
import { ControlChannel } from './control.js';
import { waitForMeetingEnd } from './meeting.js';
import { startAudioCapture, stopAudioCapture } from './audio.js';
import { transcribe } from './transcribe.js';
import { launchCamofox, type CamofoxPage } from './camofox.js';

const RECORDINGS_DIR = path.join(os.homedir(), '.config', 'mibot', 'recordings');

/** Detect platform from a meeting URL. */
export function detectPlatform(url: string): 'zoom' | 'teams' | 'meet' | null {
  if (/zoom\.us/i.test(url)) return 'zoom';
  if (/teams\.microsoft\.com|teams\.live\.com/i.test(url)) return 'teams';
  if (/meet\.google\.com/i.test(url)) return 'meet';
  return null;
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
  console.error(`[mibot] Joining ${platform}: ${title}`);

  // Create DB records
  const meeting = insertMeeting({
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

      // Wrap DB updates in transaction to prevent partial writes
      transaction(() => {
        updateMeeting(meeting.id, {
          status: 'processing',
          actual_end: new Date().toISOString(),
          participants: JSON.stringify(result.participants),
          speaker_timeline: JSON.stringify(result.speakerTimeline),
        });

        if (fs.existsSync(audioPath) && fs.statSync(audioPath).size > 1000) {
          updateRecording(recording.id, { status: 'recorded' });
        } else {
          updateRecording(recording.id, { status: 'no_audio' });
        }
      });

      // Write metadata sidecar
      writeMetadata(meeting, recording, opts, platform, title, result);

      updateMeetingStatus(meeting.id, 'done');
      return recording.id;

    } else {
      // ── Playwright path (Teams / Zoom) ──────────────────────────────
      const launch = await launchBrowser();
      browser = launch.browser;
      const page = launch.page;

      await injectAudioCaptureAllFrames(page);
      page.on('frameattached', async () => {
        try { await injectAudioCaptureAllFrames(page); } catch {}
      });

      await page.goto(opts.url, { waitUntil: 'networkidle', timeout: 30000 }).catch((err: Error) => {
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

      // Heartbeat interval — proves bot is alive (for crash detection)
      const heartbeatInterval = setInterval(() => updateHeartbeat(meeting.id), 10000);

      const webrtcAudioPath = startAudioCapture(page, audioPath);
      const signalTracker = new SignalTracker(RECORDINGS_DIR, meeting.id);

      const { participants: trackedParticipants, speakerTimeline } = await waitForMeetingEnd(page, platform, config, signalTracker);
      clearInterval(heartbeatInterval);
      const signals = signalTracker.finish();

      console.error('[mibot] Leaving. Saving audio...');
      await stopAudioCapture(page, audioPath, webrtcAudioPath);

      // Wrap DB updates in transaction to prevent partial writes
      transaction(() => {
        updateMeeting(meeting.id, {
          status: 'processing',
          actual_end: new Date().toISOString(),
          participants: JSON.stringify(trackedParticipants),
          speaker_timeline: JSON.stringify(speakerTimeline),
        });

        if (fs.existsSync(audioPath) && fs.statSync(audioPath).size > 1000) {
          updateRecording(recording.id, { status: 'recorded' });
        } else {
          updateRecording(recording.id, { status: 'failed' });
        }
      });

      if (fs.existsSync(audioPath) && fs.statSync(audioPath).size > 1000) {
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
      if (browser) await browser.close().catch(() => {});
      browser = null;

      await transcribe(recording.id, audioPath, trackedParticipants, speakerTimeline);
      updateMeetingStatus(meeting.id, 'done');
      updateRecording(recording.id, { status: 'done' });
      return recording.id;
    }

  } catch (err) {
    console.error(`[mibot] Error: ${(err as Error).message}`);
    updateMeetingStatus(meeting.id, 'failed');
    updateRecording(recording.id, { status: 'failed' });
    throw err;
  } finally {
    stopRecording();
    if (controlChannel) controlChannel.stop();
    if (browser) await browser.close().catch(() => {});
    if (camofoxPage) await camofoxPage.close().catch(() => {});
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
    console.error(`[mibot] WARNING: Audio flush failed — ${(err as Error).message}`);
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
  const trackedParticipants: any[] = [];
  const speakerTimeline: any[] = [];
  const startTime = Date.now();
  const maxMs = config.maxDurationHours * 60 * 60 * 1000;
  let lastParticipantCount = -1;
  let isPresenting = false;
  let lastScreenshotTime = 0;
  let lastScreenshotBuf: Buffer | null = null;
  let screenshotCount = 0;
  const screenshotPaths: string[] = [];
  const screenshotDir = path.join(RECORDINGS_DIR, `screenshots-${meetingId}`);
  if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true });
  const webrtcAudioPath = audioPath.replace('.webm', '-webrtc.webm');
  let lastAudioFlush = 0;

  while (Date.now() - startTime < maxMs) {
    await page.waitForTimeout(5000);

    // Heartbeat — proves bot is alive
    updateHeartbeat(meetingId);

    // Check if still in the call
    const inCall = await page.isTextVisible('Leave call').catch(() => false);
    if (!inCall) {
      console.error('[mibot] Meeting ended (Leave call button gone)');
      break;
    }

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

    // Participants, hand raises, screen share detection
    try {
      const { snapshot } = await page.snapshot();
      const peopleMatch = snapshot.match(/button "People" \[.*?\]: "(\d+)"/);
      if (peopleMatch) {
        const count = parseInt(peopleMatch[1]);
        if (count !== lastParticipantCount) {
          console.error(`[mibot] Participants: ${count}`);
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
            if (!lastScreenshotBuf || !isSimilarBuffer(lastScreenshotBuf, screenshotBuf)) {
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

  return { participants: trackedParticipants, speakerTimeline, signals };
}

// ── Helpers ───────────────────────────────────────────────────────────

/** Quick buffer similarity check — skip headers, sample data bytes. */
function isSimilarBuffer(a: Buffer, b: Buffer): boolean {
  const sizeDiff = Math.abs(a.length - b.length) / Math.max(a.length, b.length);
  if (sizeDiff > 0.15) return false;
  const start = Math.min(2048, Math.floor(Math.min(a.length, b.length) * 0.1));
  const len = Math.min(a.length, b.length) - start;
  const samples = Math.min(500, len);
  const step = Math.max(1, Math.floor(len / samples));
  let diffCount = 0;
  for (let i = start; i < start + len; i += step) {
    if (a[i] !== b[i]) diffCount++;
  }
  return (diffCount / samples) < 0.02;
}

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
