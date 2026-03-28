import type { Page } from 'playwright';
import fs from 'fs';

/**
 * Inject a WebRTC audio capture hook into the page.
 * This intercepts RTCPeerConnection.addTrack / ontrack to capture
 * incoming audio streams from other meeting participants.
 *
 * Must be called BEFORE the page joins the meeting (before WebRTC connections are made).
 */
export async function injectAudioCapture(page: Page): Promise<void> {
  await page.evaluate(() => {
    // Skip if already injected in this context
    if ((window as any).__mibotHooked) return;
    (window as any).__mibotHooked = true;

    // Hook RTCPeerConnection to capture incoming audio tracks
    const origRTCPeerConnection = window.RTCPeerConnection;

    window.RTCPeerConnection = function(...args: any[]) {
      const pc = new origRTCPeerConnection(...args);

      // When a remote track arrives (other person's audio)
      pc.addEventListener('track', (event: RTCTrackEvent) => {
        if (event.track.kind === 'audio') {
          console.log('[mibot-capture] Remote audio track received');

          // Connect this audio track to our recorder
          if (!(window as any).__mibotAudioCtx) {
            (window as any).__mibotAudioCtx = new AudioContext();
            (window as any).__mibotDest = (window as any).__mibotAudioCtx.createMediaStreamDestination();
            (window as any).__mibotSources = [];
          }

          const ctx = (window as any).__mibotAudioCtx as AudioContext;
          const dest = (window as any).__mibotDest as MediaStreamAudioDestinationNode;

          // Create a source from the remote stream
          const stream = new MediaStream([event.track]);
          const source = ctx.createMediaStreamSource(stream);
          source.connect(dest);
          (window as any).__mibotSources.push(source);

          // Start recorder if not already started
          if (!(window as any).__mibotRecorder) {
            const recorder = new MediaRecorder(dest.stream, {
              mimeType: 'audio/webm;codecs=opus',
              audioBitsPerSecond: 64000,
            });
            const chunks: Blob[] = [];
            recorder.ondataavailable = (e) => {
              if (e.data.size > 0) chunks.push(e.data);
            };
            recorder.start(1000);
            (window as any).__mibotRecorder = recorder;
            (window as any).__mibotChunks = chunks;

            // Periodically flush chunks to a global array for incremental extraction
            (window as any).__mibotFlushedChunks = [];
            (window as any).__mibotFlushInterval = setInterval(() => {
              if (chunks.length > 0) {
                (window as any).__mibotFlushedChunks.push(...chunks.splice(0));
              }
            }, 5000);

            console.log('[mibot-capture] Audio recorder started');
          }
        }
      });

      return pc;
    } as any;

    // Preserve prototype chain
    window.RTCPeerConnection.prototype = origRTCPeerConnection.prototype;
    Object.setPrototypeOf(window.RTCPeerConnection, origRTCPeerConnection);

    console.log('[mibot-capture] WebRTC audio capture hook installed');
  });

  console.error('[mibot] WebRTC audio capture hook injected');
}

/**
 * Also inject on all new frames (for Zoom which runs in an iframe).
 */
export async function injectAudioCaptureAllFrames(page: Page): Promise<void> {
  // Inject on main page
  await injectAudioCapture(page);

  // Inject on all existing frames
  for (const frame of page.frames()) {
    if (frame !== page.mainFrame()) {
      try {
        await frame.evaluate(() => {
          if ((window as any).__mibotHooked) return;
          (window as any).__mibotHooked = true;
          const origRTC = window.RTCPeerConnection;
          window.RTCPeerConnection = function(...args: any[]) {
            const pc = new origRTC(...args);
            pc.addEventListener('track', (event: RTCTrackEvent) => {
              if (event.track.kind === 'audio') {
                if (!(window as any).__mibotAudioCtx) {
                  (window as any).__mibotAudioCtx = new AudioContext();
                  (window as any).__mibotDest = (window as any).__mibotAudioCtx.createMediaStreamDestination();
                }
                const ctx = (window as any).__mibotAudioCtx;
                const dest = (window as any).__mibotDest;
                const stream = new MediaStream([event.track]);
                const source = ctx.createMediaStreamSource(stream);
                source.connect(dest);
                if (!(window as any).__mibotRecorder) {
                  const recorder = new MediaRecorder(dest.stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 64000 });
                  const chunks: Blob[] = [];
                  recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
                  recorder.start(1000);
                  (window as any).__mibotRecorder = recorder;
                  (window as any).__mibotChunks = chunks;
                }
              }
            });
            return pc;
          } as any;
          window.RTCPeerConnection.prototype = origRTC.prototype;
        });
      } catch {}
    }
  }
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
