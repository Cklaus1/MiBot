import type { Page } from 'playwright';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { startRecording, stopRecording } from './recorder.js';
import { flushAudioToDisk, finalizeAudioDrain } from './webrtc-capture.js';

/**
 * R2 (AR3) — a per-bot audio capture session.
 *
 * Capture state used to live in module-level singletons: `audioFlushInterval` + `flushPromise`
 * in audio.ts and the ffmpeg handle in recorder.ts. With two bots in one process the second
 * `startRecording` overwrote the shared ffmpeg handle, so a stop only ever stopped the LAST
 * bot's recorder and leaked the first (C4); and clearing the shared flush interval on one bot's
 * stop silently killed the other bot's flushing. A CaptureSession owns all of that per-instance.
 *
 * Every side-effecting dependency is injectable so the coordination logic (chained flush, stop
 * ordering, prefer-webrtc rule) is unit-testable without a browser or ffmpeg. Production code
 * uses the default deps, which are the same recorder/webrtc/fs calls audio.ts made before.
 */
export interface RecorderHandle {
  stop(): Promise<void>;
}

export interface CaptureSessionDeps {
  audioPath: string;
  /** Start ffmpeg recording to audioPath; returns a handle whose stop() finalizes it. */
  startRecording: (audioPath: string) => RecorderHandle;
  /** Periodic flush of WebRTC-captured audio. Returns true if bytes were written. */
  flush: (webrtcAudioPath: string) => Promise<boolean>;
  /** Final stop-and-drain at meeting end (AU3 tail). Defaults to `flush` if omitted. */
  finalFlush?: (webrtcAudioPath: string) => Promise<boolean>;
  setInterval: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval: (h: ReturnType<typeof setInterval>) => void;
  /** Decoded duration of a path in seconds, or null if missing/corrupt/unmeasurable (AU10). */
  duration: (p: string) => number | null;
  copyFile: (src: string, dest: string) => void;
  flushIntervalMs?: number;
}

const FLUSH_INTERVAL_MS = 15000;
/** AU10: require the webrtc capture to be at least this many seconds longer before overwriting. */
const MIN_DURATION_MARGIN_SEC = 1;

/**
 * AU10 — decide whether to replace the ffmpeg recording with the WebRTC capture, by decoded
 * DURATION rather than byte size. Never overwrite the longer capture: a 2s WebRTC stub must not
 * clobber a full 1h pulse recording, and a null (missing/corrupt/silent) webrtc file is never
 * preferred. A missing ffmpeg duration (null) means "nothing usable there" → prefer webrtc if it
 * has real content.
 */
export function shouldPreferWebrtc(d: { webrtcSec: number | null; ffmpegSec: number | null }): boolean {
  if (!d.webrtcSec || d.webrtcSec <= 0) return false;
  if (d.ffmpegSec === null) return true;
  return d.webrtcSec >= d.ffmpegSec + MIN_DURATION_MARGIN_SEC;
}

export class CaptureSession {
  readonly audioPath: string;
  readonly webrtcAudioPath: string;
  private readonly deps: CaptureSessionDeps;
  private recorder: RecorderHandle | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private flushChain: Promise<void> = Promise.resolve();

  constructor(deps: CaptureSessionDeps) {
    this.deps = deps;
    this.audioPath = deps.audioPath;
    this.webrtcAudioPath = deps.audioPath.replace('.webm', '-webrtc.webm');
  }

  /** Start ffmpeg recording + arm the periodic (never-overlapping) WebRTC flush. */
  start(): void {
    this.recorder = this.deps.startRecording(this.audioPath);
    this.flushChain = Promise.resolve();
    this.interval = this.deps.setInterval(() => {
      // Chain flushes sequentially — a slow flush must never overlap the next tick.
      this.flushChain = this.flushChain.then(async () => {
        try { await this.deps.flush(this.webrtcAudioPath); } catch {}
      });
    }, this.deps.flushIntervalMs ?? FLUSH_INTERVAL_MS);
  }

  /**
   * Stop capture: disarm the flush, drain any in-flight flush, stop ffmpeg (awaited), do a final
   * flush, then prefer the WebRTC capture iff it has real content. Ordering matters — draining
   * before the ffmpeg stop avoids truncating the file a concurrent flush is still appending to.
   */
  async stop(): Promise<void> {
    if (this.interval !== null) {
      this.deps.clearInterval(this.interval);
      this.interval = null;
    }
    await this.flushChain;
    if (this.recorder) { await this.recorder.stop(); this.recorder = null; }
    // AU3: the final drain stops the MediaRecorder and captures the tail, not just the periodic buffer.
    const finalFlush = this.deps.finalFlush ?? this.deps.flush;
    try { await finalFlush(this.webrtcAudioPath); } catch {}

    // AU10: prefer the webrtc capture only when it is genuinely the longer recording.
    const webrtcSec = this.deps.duration(this.webrtcAudioPath);
    const ffmpegSec = this.deps.duration(this.audioPath);
    if (shouldPreferWebrtc({ webrtcSec, ffmpegSec })) {
      this.deps.copyFile(this.webrtcAudioPath, this.audioPath);
    }
  }
}

/** Decoded duration in seconds via ffprobe, or null if missing/corrupt/unmeasurable (AU10). */
export function probeDurationSec(p: string): number | null {
  if (!fs.existsSync(p)) return null;
  try {
    const out = execFileSync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      p,
    ], { encoding: 'utf8', timeout: 10000 }).trim();
    const sec = parseFloat(out);
    return Number.isFinite(sec) ? sec : null;
  } catch {
    return null; // ffprobe missing or file undecodable
  }
}

/** Production factory: a CaptureSession wired to the real recorder/webrtc/fs for a given page. */
export function createCaptureSession(page: Page, audioPath: string): CaptureSession {
  // AU11: the flush catch used to be silent — the exact reason P0/P1 silent-capture failures
  // stayed invisible. Log the first failure and every 4th consecutive one thereafter.
  let consecutiveFailures = 0;
  const loggedFlush = async (p: string): Promise<boolean> => {
    try {
      const ok = await flushAudioToDisk(page, p);
      consecutiveFailures = 0;
      return ok;
    } catch (err) {
      consecutiveFailures++;
      if (consecutiveFailures === 1 || consecutiveFailures % 4 === 0) {
        console.error(`[mibot] audio flush failed (${consecutiveFailures} consecutive): ${(err as Error).message}`);
      }
      return false;
    }
  };

  return new CaptureSession({
    audioPath,
    startRecording: (p) => { const ff = startRecording(p); return { stop: () => stopRecording(ff) }; },
    flush: loggedFlush,
    finalFlush: (p) => finalizeAudioDrain(page, p),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h),
    duration: (p) => probeDurationSec(p),
    copyFile: (src, dest) => {
      fs.copyFileSync(src, dest);
      console.error('[mibot] Using WebRTC-captured audio');
    },
  });
}
