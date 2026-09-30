import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import {
  parseDecodeStats, usableDurationSec, probeDurationSec, hasUsableAudio,
  shouldPreferWebrtc, SILENCE_CEILING_DB,
} from '../src/capture-session.js';

// Fix 2 (P1): ffprobe `format=duration` prints N/A for MediaRecorder's live-mode webm, so the
// WebRTC capture was never measurable and never promoted. On the default headless path every
// Teams/Zoom meeting sent ffmpeg's -91 dB null-sink file to transcription and discarded the
// real audio. Length now comes from decoding, and a silent file counts as no audio.

const STDERR_SPEECH = `Input #0, matroska,webm ...
size=N/A time=00:10:02.40 bitrate=N/A speed= 190x
size=N/A time=00:20:04.98 bitrate=N/A speed= 121x
[Parsed_volumedetect_0 @ 0x1] mean_volume: -32.5 dB
[Parsed_volumedetect_0 @ 0x1] max_volume: -0.9 dB`;

describe('parseDecodeStats', () => {
  it('takes the LAST progress time as the length', () => {
    expect(parseDecodeStats(STDERR_SPEECH)).toEqual({ sec: 1204.98, maxVolumeDb: -0.9 });
  });
  it('returns null when nothing decoded (no progress line)', () => {
    expect(parseDecodeStats('x.webm: Invalid data found when processing input')).toBeNull();
  });
  it('parses -inf peak (pure digital zero)', () => {
    expect(parseDecodeStats('time=00:00:05.00\nmax_volume: -inf dB')!.maxVolumeDb).toBe(-Infinity);
  });
  it('tolerates a missing volumedetect report', () => {
    expect(parseDecodeStats('time=00:01:00.00')).toEqual({ sec: 60, maxVolumeDb: null });
  });
});

describe('usableDurationSec', () => {
  it('real speech → its length', () => expect(usableDurationSec({ sec: 233.6, maxVolumeDb: -3 })).toBe(233.6));
  it('the -91 dB null sink → null (silent is not audio)', () =>
    expect(usableDurationSec({ sec: 245, maxVolumeDb: -91 })).toBeNull());
  it('a quiet-but-real room above the ceiling still counts', () =>
    expect(usableDurationSec({ sec: 60, maxVolumeDb: SILENCE_CEILING_DB + 5 })).toBe(60));
  it('zero-length → null', () => expect(usableDurationSec({ sec: 0, maxVolumeDb: -5 })).toBeNull());
  it('null probe → null', () => expect(usableDurationSec(null)).toBeNull());
});

describe('the production decision, end to end with real ffmpeg', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mibot-probe-'));
  const haveFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version']); return true; } catch { return false; } })();
  const gen = (name: string, src: string, live: boolean) => {
    const p = path.join(dir, name);
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', src, '-c:a', 'libopus',
      ...(live ? ['-live', '1'] : []), '-f', 'webm', p]);
    return p;
  };

  it.skipIf(!haveFfmpeg)('a live-mode webm (no Duration header) is measured by decoding', async () => {
    const p = gen('live.webm', 'sine=f=440:d=4', true);
    // The exact case ffprobe could not measure.
    expect(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=nw=1:nk=1', p], { encoding: 'utf8' }).trim()).toBe('N/A');
    expect(await probeDurationSec(p)).toBeGreaterThan(3.5);
  });

  it.skipIf(!haveFfmpeg)('webrtc speech beats a longer SILENT ffmpeg file — the P1 scenario', async () => {
    const webrtc = gen('webrtc.webm', 'sine=f=440:d=4', true);
    const silent = gen('ffmpeg.webm', 'anullsrc=d=6', false);
    const webrtcSec = await probeDurationSec(webrtc);
    const ffmpegSec = await probeDurationSec(silent);
    expect(ffmpegSec).toBeNull();
    expect(shouldPreferWebrtc({ webrtcSec, ffmpegSec })).toBe(true);
    expect(await hasUsableAudio(silent)).toBe(false);
    expect(await hasUsableAudio(webrtc)).toBe(true);
  });

  it('a missing file is not usable audio', async () => {
    expect(await hasUsableAudio(path.join(dir, 'nope.webm'))).toBe(false);
  });
});
