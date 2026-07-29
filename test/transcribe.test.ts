import { describe, it, expect } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { transcribe } from '../src/transcribe.js';

// R6: transcribe() must return a RecordingStatus outcome (not void), so the caller —
// not transcribe itself — owns the recording-row status write. The 'no_audio' path is
// deterministic (no external binary), so it anchors the contract.
describe('transcribe outcome contract (R6)', () => {
  it('returns "no_audio" when the audio file is missing', async () => {
    const missing = path.join(os.tmpdir(), `mibot-nope-${process.pid}.wav`);
    const outcome = await transcribe(-1, missing, [], []);
    expect(outcome).toBe('no_audio');
  });

  it('returns "no_audio" when the audio file is empty', async () => {
    const empty = path.join(os.tmpdir(), `mibot-empty-${process.pid}.wav`);
    fs.writeFileSync(empty, '');
    try {
      const outcome = await transcribe(-1, empty, [], []);
      expect(outcome).toBe('no_audio');
    } finally {
      fs.rmSync(empty, { force: true });
    }
  });
});
