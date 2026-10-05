import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ShareScreenshots, imageExtension } from '../src/image-similarity.js';

// Wave 9-I: the camofox (Meet) screenshot path had no cap — an 8h presentation wrote ~960 files —
// and saved camofox's PNG bytes under a .jpg name.
const png = (fill: number) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(4000, fill)]);
const jpg = (fill: number) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(4000, fill)]);
const noise = (seed: number) => { const b = Buffer.alloc(4000); let x = seed; for (let i = 0; i < b.length; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; b[i] = x & 0xff; } return Buffer.concat([png(0).subarray(0, 8), b]); };
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mibot-shots-'));

describe('imageExtension', () => {
  it('sniffs PNG, JPEG, WebP from magic bytes', () => {
    expect(imageExtension(png(1))).toBe('png');
    expect(imageExtension(jpg(1))).toBe('jpg');
    expect(imageExtension(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('webp');
    expect(imageExtension(Buffer.from('????'))).toBe('img');
  });
});

describe('ShareScreenshots (Wave 9-I)', () => {
  it('saves a PNG as .png, not .jpg', () => {
    const s = new ShareScreenshots(dir());
    const p = s.save(noise(1), 1)!;
    expect(p.endsWith('.png')).toBe(true);
    expect(fs.existsSync(p)).toBe(true);
  });

  it('skips a frame visually identical to the last one saved', () => {
    const s = new ShareScreenshots(dir());
    expect(s.save(noise(1), 1)).not.toBeNull();
    expect(s.save(noise(1), 2)).toBeNull();
  });

  it('skips tiny buffers (not a real capture)', () => {
    expect(new ShareScreenshots(dir()).save(Buffer.alloc(500), 1)).toBeNull();
  });

  it('stops at the cap and reports full BEFORE another capture is taken', () => {
    const s = new ShareScreenshots(dir(), 3);
    for (let i = 0; i < 5; i++) s.save(noise(i + 1), i);
    expect(s.paths).toHaveLength(3);
    expect(s.full).toBe(true);
  });

});
