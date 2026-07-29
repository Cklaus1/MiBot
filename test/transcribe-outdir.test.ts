import { describe, it, expect } from 'vitest';
import path from 'path';
import { resolveOutputDir } from '../src/transcribe.js';

// T7: the audioscript output_dir was scraped from stdout with a regex; a format change
// silently fell back to `audioDir/output` and fed the empty-transcript path. resolveOutputDir
// JSON-parses stdout and resolves the dir relative to audioDir, returning null when the field
// is absent so the caller can hard-fail (T2) instead of guessing.
describe('resolveOutputDir (T7 JSON parse, not regex)', () => {
  const audioDir = '/recordings';

  it('resolves a relative output_dir from JSON stdout', () => {
    const out = resolveOutputDir('{"output_dir": "output/run1"}', audioDir);
    expect(out).toBe(path.resolve(audioDir, 'output/run1'));
  });

  it('resolves an absolute output_dir as-is', () => {
    const out = resolveOutputDir('{"output_dir": "/var/out"}', audioDir);
    expect(out).toBe('/var/out');
  });

  it('returns null when output_dir is absent (caller hard-fails, no silent fallback)', () => {
    expect(resolveOutputDir('{"something_else": 1}', audioDir)).toBeNull();
  });

  it('returns null on non-JSON stdout', () => {
    expect(resolveOutputDir('Transcribing... done!', audioDir)).toBeNull();
  });

  it('tolerates JSON embedded in surrounding log lines', () => {
    const stdout = 'starting\n{"output_dir": "output/x", "n": 3}\ndone\n';
    expect(resolveOutputDir(stdout, audioDir)).toBe(path.resolve(audioDir, 'output/x'));
  });

  it('returns null when output_dir is not a string', () => {
    expect(resolveOutputDir('{"output_dir": 42}', audioDir)).toBeNull();
  });
});
