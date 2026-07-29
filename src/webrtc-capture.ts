import type { Page, BrowserContext } from 'playwright';
import fs from 'fs';

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

/**
 * Stop recording and extract audio data from the page.
 * Returns base64-encoded webm audio.
 */
export async function extractAudio(page: Page): Promise<string> {
  // Try all frames
  for (const frame of [page, ...page.frames()]) {
    try {
      const result = await frame.evaluate(() => {
        // Clean up the flush interval
        if ((window as any).__mibotFlushInterval) {
          clearInterval((window as any).__mibotFlushInterval);
          (window as any).__mibotFlushInterval = null;
        }
        return new Promise<string>((resolve) => {
          const recorder = (window as any).__mibotRecorder as MediaRecorder;
          const chunks = (window as any).__mibotChunks as Blob[];

          if (!recorder || !chunks) { resolve(''); return; }

          // Stop all sources
          const sources = (window as any).__mibotSources || [];
          for (const s of sources) { try { s.disconnect(); } catch {} }

          if (recorder.state === 'recording') {
            recorder.onstop = async () => {
              const blob = new Blob(chunks, { type: 'audio/webm' });
              const buffer = await blob.arrayBuffer();
              const bytes = new Uint8Array(buffer);
              let binary = '';
              for (let i = 0; i < bytes.length; i++) {
                binary += String.fromCharCode(bytes[i]);
              }
              resolve(btoa(binary));
            };
            recorder.stop();
          } else {
            resolve('');
          }
        });
      });

      if (result) return result;
    } catch {}
  }
  return '';
}

/**
 * Periodically flush captured audio to disk. Call every 30s during the meeting.
 * Appends new chunks to the file so audio is never lost on crash.
 */
export async function flushAudioToDisk(page: Page, outputPath: string): Promise<boolean> {
  for (const frame of [page, ...page.frames()]) {
    try {
      const chunkB64 = await frame.evaluate(() => {
        const flushed = (window as any).__mibotFlushedChunks as Blob[] | undefined;
        if (!flushed || flushed.length === 0) return '';

        // Take all flushed chunks and encode
        const chunks = flushed.splice(0);
        return new Promise<string>((resolve) => {
          const blob = new Blob(chunks, { type: 'audio/webm' });
          const reader = new FileReader();
          reader.onload = () => {
            const base64 = (reader.result as string).split(',')[1] || '';
            resolve(base64);
          };
          reader.readAsDataURL(blob);
        });
      });

      if (chunkB64) {
        const buf = Buffer.from(chunkB64, 'base64');
        fs.appendFileSync(outputPath, buf);
        return true;
      }
    } catch {}
  }
  return false;
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
