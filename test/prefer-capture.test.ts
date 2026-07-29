import { describe, it, expect } from 'vitest';
import { shouldPreferWebrtc } from '../src/capture-session.js';

// AU10: the old gate was `webrtcSize > 1000` → copyFileSync(webrtc, main). That let a 2s WebRTC
// stub clobber a full 1h pulse recording (headed mode), and pure-silence opus (>1000 bytes) also
// passed. The decision must be by decoded DURATION, never overwriting the longer capture.
describe('AU10 shouldPreferWebrtc (duration-based)', () => {
  it('prefers webrtc when it is clearly longer than the ffmpeg recording', () => {
    expect(shouldPreferWebrtc({ webrtcSec: 3600, ffmpegSec: 0 })).toBe(true);
  });

  it('does NOT overwrite a longer ffmpeg recording with a short webrtc stub', () => {
    expect(shouldPreferWebrtc({ webrtcSec: 2, ffmpegSec: 3600 })).toBe(false);
  });

  it('keeps ffmpeg when durations are equal (no pointless copy / no regression)', () => {
    expect(shouldPreferWebrtc({ webrtcSec: 100, ffmpegSec: 100 })).toBe(false);
  });

  it('prefers webrtc when ffmpeg produced nothing (null duration = missing/corrupt)', () => {
    expect(shouldPreferWebrtc({ webrtcSec: 50, ffmpegSec: null })).toBe(true);
  });

  it('never prefers a webrtc file with no measurable duration', () => {
    expect(shouldPreferWebrtc({ webrtcSec: null, ffmpegSec: null })).toBe(false);
    expect(shouldPreferWebrtc({ webrtcSec: 0, ffmpegSec: null })).toBe(false);
  });

  it('requires a real margin — a webrtc file 0.5s longer does not trigger a rewrite', () => {
    expect(shouldPreferWebrtc({ webrtcSec: 100.4, ffmpegSec: 100 })).toBe(false);
    expect(shouldPreferWebrtc({ webrtcSec: 105, ffmpegSec: 100 })).toBe(true);
  });
});
