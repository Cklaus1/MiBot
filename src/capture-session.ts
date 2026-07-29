import type { Page } from 'playwright';
import fs from 'fs';
import { startRecording, stopRecording } from './recorder.js';
import { flushAudioToDisk } from './webrtc-capture.js';

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
  /** Flush WebRTC-captured audio to the given path. Returns true if bytes were written. */
  flush: (webrtcAudioPath: string) => Promise<boolean>;
  setInterval: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval: (h: ReturnType<typeof setInterval>) => void;
  /** Size in bytes of a path (0 if missing). */
  fileSize: (p: string) => number;
  copyFile: (src: string, dest: string) => void;
  flushIntervalMs?: number;
}

const FLUSH_INTERVAL_MS = 15000;
const MIN_WEBRTC_BYTES = 1000;

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
    try { await this.deps.flush(this.webrtcAudioPath); } catch {}

    if (this.deps.fileSize(this.webrtcAudioPath) > MIN_WEBRTC_BYTES) {
      this.deps.copyFile(this.webrtcAudioPath, this.audioPath);
    }
  }
}

/** Production factory: a CaptureSession wired to the real recorder/webrtc/fs for a given page. */
export function createCaptureSession(page: Page, audioPath: string): CaptureSession {
  return new CaptureSession({
    audioPath,
    startRecording: (p) => { const ff = startRecording(p); return { stop: () => stopRecording(ff) }; },
    flush: (p) => flushAudioToDisk(page, p),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h),
    fileSize: (p) => (fs.existsSync(p) ? fs.statSync(p).size : 0),
    copyFile: (src, dest) => {
      fs.copyFileSync(src, dest);
      console.error('[mibot] Using WebRTC-captured audio');
    },
  });
}
