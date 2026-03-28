import { type Page } from 'playwright';
import fs from 'fs';
import { startRecording, stopRecording } from './recorder.js';
import { flushAudioToDisk } from './webrtc-capture.js';

let audioFlushInterval: ReturnType<typeof setInterval> | null = null;
let flushPromise: Promise<void> = Promise.resolve();

/**
 * Start audio capture: ffmpeg recording + periodic WebRTC flush to disk.
 * Returns the WebRTC audio path (derived from the main audio path).
 */
export function startAudioCapture(page: Page, audioPath: string): string {
  // Start audio recording via PulseAudio + ffmpeg (headed mode backup)
  startRecording(audioPath);

  // Periodically flush WebRTC-captured audio to disk (crash-safe)
  const webrtcAudioPath = audioPath.replace('.webm', '-webrtc.webm');
  flushPromise = Promise.resolve();
  audioFlushInterval = setInterval(() => {
    // Chain flushes sequentially — never overlap
    flushPromise = flushPromise.then(async () => {
      try {
        await flushAudioToDisk(page, webrtcAudioPath);
      } catch {}
    });
  }, 15000);

  return webrtcAudioPath;
}

/**
 * Stop audio capture: clear flush interval, wait for in-flight flush,
 * stop ffmpeg, do a final WebRTC flush, and prefer WebRTC audio if available.
 */
export async function stopAudioCapture(page: Page, audioPath: string, webrtcAudioPath: string): Promise<void> {
  if (audioFlushInterval) {
    clearInterval(audioFlushInterval);
    audioFlushInterval = null;
  }
  // Wait for any in-flight flush to complete before final flush
  await flushPromise;
  stopRecording(); // Stop ffmpeg

  // Final flush of WebRTC audio (append, don't overwrite)
  await flushAudioToDisk(page, webrtcAudioPath).catch(() => {});

  // Use WebRTC audio if it has content, otherwise keep ffmpeg recording
  if (fs.existsSync(webrtcAudioPath) && fs.statSync(webrtcAudioPath).size > 1000) {
    fs.copyFileSync(webrtcAudioPath, audioPath);
    console.error('[mibot] Using WebRTC-captured audio');
  }
}

/** Get the WebRTC audio path derived from the main audio path. */
export function getWebrtcAudioPath(audioPath: string): string {
  return audioPath.replace('.webm', '-webrtc.webm');
}
