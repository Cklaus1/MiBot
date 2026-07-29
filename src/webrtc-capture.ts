import type { Page, BrowserContext, Frame } from 'playwright';
import fs from 'fs';
import { drainAudioOnce } from './audio-drain.js';

/**
 * FA/R4 — the ONE WebRTC audio-capture hook, self-contained so it can be installed via
 * `context.addInitScript`. addInitScript runs this in the main frame AND every iframe, on
 * every navigation, before any page script — which is exactly what audio capture needs:
 *
 *  - AU1 (P0): Zoom's WebRTC lives in an iframe. The old code had a SEPARATE, drifted iframe
 *    injector that never created `__mibotFlushedChunks`, so `flushAudioToDisk` read `undefined`
 *    and returned '' for the whole meeting. One hook, run in every frame, ends the drift.
 *  - AU2 (P1): a `page.evaluate()` hook is wiped by the first navigation (goto). An init script
 *    is re-run on every document, so the hook is always present before RTCPeerConnection is used.
 *
 * References `window` explicitly (never a bundler closure) so it survives serialization into the
 * page and is unit-testable by binding a fake `window`. Keep it dependency-free for the same
 * reason — everything it needs is read off `window`.
 */
export function audioCaptureHook(): void {
  const w = window as any;
  if (w.__mibotHooked) return;
  w.__mibotHooked = true;

  const OrigRTC = w.RTCPeerConnection;
  if (!OrigRTC) return; // no WebRTC in this frame (e.g. an ad/tracking iframe)

  const Wrapped = function (this: any, ...args: any[]) {
    const pc = new OrigRTC(...args);
    pc.addEventListener('track', (event: any) => {
      if (!event.track || event.track.kind !== 'audio') return;
      w.console?.log?.('[mibot-capture] Remote audio track received');

      if (!w.__mibotAudioCtx) {
        const Ctx = w.AudioContext || w.webkitAudioContext;
        w.__mibotAudioCtx = new Ctx();
        w.__mibotDest = w.__mibotAudioCtx.createMediaStreamDestination();
        w.__mibotSources = [];
      }
      const ctx = w.__mibotAudioCtx;
      const dest = w.__mibotDest;
      const stream = new w.MediaStream([event.track]);
      const source = ctx.createMediaStreamSource(stream);
      source.connect(dest);
      w.__mibotSources.push(source);

      if (!w.__mibotRecorder) {
        const recorder = new w.MediaRecorder(dest.stream, {
          mimeType: 'audio/webm;codecs=opus',
          audioBitsPerSecond: 64000,
        });
        const chunks: any[] = [];
        recorder.ondataavailable = (e: any) => { if (e.data.size > 0) chunks.push(e.data); };
        recorder.start(1000);
        w.__mibotRecorder = recorder;
        w.__mibotChunks = chunks;

        // The array flushAudioToDisk drains. ALWAYS created here — this is the AU1 fix.
        w.__mibotFlushedChunks = [];
        w.__mibotFlushInterval = w.setInterval(() => {
          if (chunks.length > 0) w.__mibotFlushedChunks.push(...chunks.splice(0));
        }, 5000);
        w.console?.log?.('[mibot-capture] Audio recorder started');
      }
    });
    return pc;
  } as any;

  Wrapped.prototype = OrigRTC.prototype;
  try { Object.setPrototypeOf(Wrapped, OrigRTC); } catch {}
  w.RTCPeerConnection = Wrapped;
  w.console?.log?.('[mibot-capture] WebRTC audio capture hook installed');
}

/**
 * Install the capture hook on a context so it runs in every frame, on every navigation,
 * before page scripts. MUST be called before the first `page.goto` (before WebRTC starts).
 */
export async function installAudioCapture(context: BrowserContext): Promise<void> {
  await context.addInitScript(audioCaptureHook);
  console.error('[mibot] WebRTC audio capture hook installed on context (all frames)');
}

// ── Drain protocol (DRAIN: AU3/AU7/AU8/AU12) ────────────────────────────
//
// The in-page read is NON-destructive: it peeks and encodes the pending flushed chunks but
// leaves them in `__mibotFlushedChunks`. Node appends the bytes to disk and only THEN calls the
// ack step, which removes exactly the chunks that were read (`splice(0, count)` — new chunks that
// arrived mid-transfer sit after them and survive). If the append throws (ENOSPC) the ack never
// runs, so the window is retried next tick instead of being lost (AU8). The FileReader carries an
// onerror/onabort so a read failure resolves to '' rather than hanging frame.evaluate (AU7).

const READ_TIMEOUT_MS = 10000;

/** Peek+encode pending flushed chunks in one frame WITHOUT removing them. */
async function readPendingChunks(frame: Frame): Promise<{ b64: string; count: number }> {
  return frame.evaluate(() => {
    const flushed = (window as any).__mibotFlushedChunks as Blob[] | undefined;
    if (!flushed || flushed.length === 0) return { b64: '', count: 0 };
    const count = flushed.length;
    const snapshot = flushed.slice(0, count); // copy — do NOT splice (non-destructive read)
    return new Promise<{ b64: string; count: number }>((resolve) => {
      const blob = new Blob(snapshot, { type: 'audio/webm' });
      const reader = new FileReader();
      reader.onload = () => resolve({ b64: (reader.result as string).split(',')[1] || '', count });
      reader.onerror = () => resolve({ b64: '', count: 0 }); // AU7: never hang on read failure
      reader.onabort = () => resolve({ b64: '', count: 0 });
      reader.readAsDataURL(blob);
    });
  });
}

/** Remove the first `count` (already-persisted) chunks from a frame's flushed buffer. */
async function ackChunks(frame: Frame, count: number): Promise<void> {
  await frame.evaluate((n) => {
    const flushed = (window as any).__mibotFlushedChunks as Blob[] | undefined;
    if (flushed) flushed.splice(0, n);
  }, count);
}

/** Drain one frame once via the two-phase protocol. Returns true if bytes were appended. */
async function drainFrame(frame: Frame, outputPath: string): Promise<boolean> {
  const result = await drainAudioOnce({
    readEncoded: () => readPendingChunks(frame),
    append: (buf) => fs.appendFileSync(outputPath, buf),
    ack: (count) => ackChunks(frame, count),
    timeoutMs: READ_TIMEOUT_MS,
  });
  return result.appended;
}

/**
 * Periodic flush during the meeting. Drains the FIRST frame that has pending audio (AU12: a
 * single meeting has one recorder frame; appending two frames' streams to one file yields
 * invalid webm, so we commit to the first frame with data rather than concatenating).
 */
export async function flushAudioToDisk(page: Page, outputPath: string): Promise<boolean> {
  for (const frame of [page.mainFrame(), ...page.frames()]) {
    try {
      if (await drainFrame(frame, outputPath)) return true;
    } catch { /* AU11 logs at the audio.ts layer; keep trying other frames */ }
  }
  return false;
}

/**
 * AU3 — single stop-and-drain at meeting end. Stops the MediaRecorder, awaits its final
 * `ondataavailable` so the last ~0-6s tail lands in the buffer, moves it into the flushed buffer,
 * then drains. Without this the tail of every meeting was dropped.
 */
export async function finalizeAudioDrain(page: Page, outputPath: string): Promise<boolean> {
  let any = false;
  for (const frame of [page.mainFrame(), ...page.frames()]) {
    try {
      // Stop the recorder and fold any un-flushed tail into __mibotFlushedChunks.
      await frame.evaluate(() => {
        const w = window as any;
        if (w.__mibotFlushInterval) { clearInterval(w.__mibotFlushInterval); w.__mibotFlushInterval = null; }
        const recorder = w.__mibotRecorder as MediaRecorder | undefined;
        const chunks = w.__mibotChunks as Blob[] | undefined;
        const flushed = w.__mibotFlushedChunks as Blob[] | undefined;
        if (!recorder || !chunks || !flushed) return;
        return new Promise<void>((resolve) => {
          const fold = () => { flushed.push(...chunks.splice(0)); resolve(); };
          if (recorder.state === 'recording') {
            recorder.onstop = () => fold();
            try { recorder.requestData(); } catch {}
            recorder.stop();
            setTimeout(() => fold(), 3000); // safety: don't wait forever for onstop
          } else {
            fold();
          }
        });
      });
      if (await drainFrame(frame, outputPath)) any = true;
    } catch { /* best-effort per frame */ }
  }
  return any;
}

/** Save extracted audio to a file. */
export function saveAudio(audioBase64: string, outputPath: string): boolean {
  if (!audioBase64) return false;
  const buffer = Buffer.from(audioBase64, 'base64');
  if (buffer.length === 0) return false;
  fs.writeFileSync(outputPath, buffer);
  console.error(`[mibot] Audio saved: ${outputPath} (${(buffer.length / 1024).toFixed(0)} KB)`);
  return true;
}
