import type { Page, BrowserContext, Frame } from 'playwright';
import fs from 'fs';
import {
  drainAudioOnce, DrainState, buildReadExpr, buildAckExpr, appendToSegment, assembleSegments,
  type ReadResult,
} from './audio-drain.js';

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

// ── Drain protocol (DRAIN: AU3/AU7/AU8/AU12, Wave 9-C) ───────────────────
//
// The in-page read/ack are the shared expressions in audio-drain.ts (also used by the camofox
// path): a non-destructive, sequence-numbered read from the first chunk node still needs, an
// append to disk, then an ack that drops chunks below the persisted sequence. A failed append
// skips the ack (retried next tick, AU8); a failed ack costs nothing (the next read starts past
// it). A recorder restart writes a new segment, joined at the end. The FileReader carries
// onerror/onabort so a read failure resolves empty rather than hanging evaluate (AU7).

const READ_TIMEOUT_MS = 10000;

/**
 * Drain state for one Playwright capture: sequence/segment bookkeeping (Wave 9-C) plus the frame
 * we committed to. AU12 said "commit to the first frame with data" but the old loop re-picked a
 * frame every tick, so two frames' streams could interleave into one file. Now the first frame
 * that yields audio is locked in, and only released if it's detached.
 */
export class FrameDrain {
  readonly state = new DrainState();
  frame: Frame | null = null;
}

/** Drain one frame once via the two-phase protocol. Returns true if bytes were appended. */
async function drainFrame(frame: Frame, outputPath: string, drain: FrameDrain): Promise<boolean> {
  const result = await drainAudioOnce({
    readEncoded: (fromSeq, knownRecId) => frame.evaluate(buildReadExpr(fromSeq, knownRecId)) as Promise<ReadResult>,
    append: appendToSegment(outputPath),
    ack: async (uptoSeq, recId) => { await frame.evaluate(buildAckExpr(uptoSeq, recId)); },
    timeoutMs: READ_TIMEOUT_MS,
  }, drain.state);
  return result.appended;
}

/** The frames to drain: the locked one if it's still attached, else every frame (once each). */
function candidateFrames(page: Page, drain: FrameDrain): Frame[] {
  if (drain.frame && !drain.frame.isDetached()) return [drain.frame];
  drain.frame = null;
  return [...new Set([page.mainFrame(), ...page.frames()])];
}

/**
 * Periodic flush during the meeting. Drains the locked frame, or — until one has produced audio
 * — the first frame with data, which then becomes the locked frame (AU12).
 */
export async function flushAudioToDisk(page: Page, outputPath: string, drain: FrameDrain): Promise<boolean> {
  for (const frame of candidateFrames(page, drain)) {
    try {
      if (await drainFrame(frame, outputPath, drain)) { drain.frame = frame; return true; }
    } catch { /* AU11 logs at the audio.ts layer; keep trying other frames */ }
  }
  return false;
}

/**
 * AU3 — single stop-and-drain at meeting end. Stops every frame's MediaRecorder and awaits its
 * final `ondataavailable` so the last ~0-6s tail lands in the buffer, drains the committed frame,
 * then joins any segments a mid-meeting recorder restart produced (Wave 9-C).
 */
export async function finalizeAudioDrain(page: Page, outputPath: string, drain: FrameDrain): Promise<boolean> {
  for (const frame of new Set([page.mainFrame(), ...page.frames()])) {
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
    } catch { /* best-effort per frame */ }
  }
  let any = false;
  for (const frame of candidateFrames(page, drain)) {
    try {
      if (await drainFrame(frame, outputPath, drain)) { drain.frame = frame; any = true; break; }
    } catch { /* best-effort per frame */ }
  }
  await assembleSegments(outputPath, drain.state.segmentCount);
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
