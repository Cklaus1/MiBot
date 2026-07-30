import { type Page } from 'playwright';
import { CaptureSession, createCaptureSession, webrtcAudioPathFor } from './capture-session.js';

export { webrtcAudioPathFor };

/**
 * Audio capture entry points. R2 (AR3): the per-bot state that used to live in module-level
 * singletons here now lives inside a CaptureSession instance, so concurrent bots don't clobber
 * each other's ffmpeg handle or flush interval (C4). bot.ts owns one session per meeting.
 */

/** Create and start a per-bot capture session. Returns the session (bot.ts stops it later). */
export function startAudioCapture(page: Page, audioPath: string): CaptureSession {
  const session = createCaptureSession(page, audioPath);
  session.start();
  return session;
}

/** Stop a capture session (delegates to the instance — no shared state). */
export async function stopAudioCapture(session: CaptureSession): Promise<void> {
  await session.stop();
}

/** @deprecated alias for {@link webrtcAudioPathFor}. */
export function getWebrtcAudioPath(audioPath: string): string {
  return webrtcAudioPathFor(audioPath);
}
