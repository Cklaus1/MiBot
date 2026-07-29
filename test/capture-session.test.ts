import { describe, it, expect, vi } from 'vitest';
import { CaptureSession } from '../src/capture-session.js';

// R2 (AR3) + C4: capture state used to live in MODULE-LEVEL singletons — `audioFlushInterval`
// and `flushPromise` in audio.ts, and the `ffmpeg` handle in recorder.ts. Two bots in one
// process would clobber each other: the second startRecording overwrote the shared ffmpeg
// handle, so stop() only ever stopped the LAST bot's recorder and leaked the first (C4). And
// clearing the shared flush interval on one bot's stop killed the other bot's flushing.
// CaptureSession makes all of that per-instance — two sessions are fully independent.

/** A fake ffmpeg handle: records whether it was stopped. */
function fakeRecorder() {
  return { stopped: false, async stop() { this.stopped = true; } };
}

/** Build a session with injected deps so no browser/ffmpeg is needed. */
function makeSession(opts: Partial<Parameters<typeof CaptureSession.prototype.constructor>[0]> = {}) {
  const recorder = fakeRecorder();
  const flush = vi.fn().mockResolvedValue(true);
  const timers: Array<() => void> = [];
  const session = new CaptureSession({
    audioPath: '/tmp/a.webm',
    startRecording: () => recorder as any,
    flush,
    setInterval: (fn: () => void) => { timers.push(fn); return timers.length as any; },
    clearInterval: () => {},
    duration: () => null, // nothing measurable → keep ffmpeg audio by default
    copyFile: vi.fn(),
    ...opts,
  });
  return { session, recorder, flush, fireTimers: () => timers.forEach((f) => f()) };
}

describe('R2 CaptureSession (per-bot, no singletons)', () => {
  it('derives the webrtc path from the audio path', () => {
    const { session } = makeSession();
    expect(session.webrtcAudioPath).toBe('/tmp/a-webrtc.webm');
  });

  it('two sessions are independent — stopping one does not stop the other (C4)', async () => {
    const a = makeSession();
    const b = makeSession();
    a.session.start();
    b.session.start();
    await a.session.stop();
    expect(a.recorder.stopped).toBe(true);
    expect(b.recorder.stopped).toBe(false); // the old singleton bug: b would be stopped too
    await b.session.stop();
    expect(b.recorder.stopped).toBe(true);
  });

  it('start() begins recording and arms the periodic flush', async () => {
    const { session, recorder, flush, fireTimers } = makeSession();
    session.start();
    expect(recorder.stopped).toBe(false);
    fireTimers();
    await session.stop();
    expect(flush).toHaveBeenCalled();
  });

  it('stop() awaits any in-flight flush before stopping ffmpeg (no truncation race)', async () => {
    let flushResolved = false;
    const flush = vi.fn().mockImplementation(
      () => new Promise<boolean>((r) => setTimeout(() => { flushResolved = true; r(true); }, 20)),
    );
    const { session, fireTimers } = makeSession({ flush });
    session.start();
    fireTimers(); // kick off a slow flush
    await session.stop();
    expect(flushResolved).toBe(true); // stop waited for it
  });

  it('overlapping flush ticks never run concurrently (chained)', async () => {
    let active = 0; let maxActive = 0;
    const flush = vi.fn().mockImplementation(async () => {
      active++; maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--; return true;
    });
    const { session, fireTimers } = makeSession({ flush });
    session.start();
    fireTimers(); fireTimers(); fireTimers();
    await session.stop();
    expect(maxActive).toBe(1);
  });

  it('a flush that throws never breaks the chain or stop()', async () => {
    const flush = vi.fn().mockRejectedValue(new Error('page closed'));
    const { session, recorder, fireTimers } = makeSession({ flush });
    session.start();
    fireTimers();
    await expect(session.stop()).resolves.toBeUndefined();
    expect(recorder.stopped).toBe(true);
  });

  it('prefers the webrtc capture when it is the longer recording (AU10)', async () => {
    const copyFile = vi.fn();
    // webrtc 3600s, ffmpeg produced nothing (null) → prefer webrtc
    const duration = (p: string) => (p.includes('-webrtc') ? 3600 : null);
    const { session } = makeSession({ copyFile, duration });
    session.start();
    await session.stop();
    expect(copyFile).toHaveBeenCalledWith('/tmp/a-webrtc.webm', '/tmp/a.webm');
  });

  it('never overwrites a longer ffmpeg recording with a short webrtc stub (AU10)', async () => {
    const copyFile = vi.fn();
    // webrtc 2s stub vs a full 3600s ffmpeg recording → keep ffmpeg
    const duration = (p: string) => (p.includes('-webrtc') ? 2 : 3600);
    const { session } = makeSession({ copyFile, duration });
    session.start();
    await session.stop();
    expect(copyFile).not.toHaveBeenCalled();
  });
});
