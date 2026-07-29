import { describe, it, expect } from 'vitest';
import { isSimilarImage, perceptualHash } from '../src/image-similarity.js';

// M12: isSimilar's compare loop runs `len/step` iterations but divided the diff count by
// `samples` (capped at 500). When 500 ≤ len < 1000, step becomes 1 so the loop runs `len`
// times (up to 999) while still dividing by 500 → the diff ratio is inflated up to ~2×, and a
// near-identical small screenshot is misclassified as "different" (a duplicate slide gets saved).
// Fix: divide by the ACTUAL number of comparisons. M16: this is the one shared helper both the
// SignalTracker (Playwright) and camofox paths now call, so the fix lands in both places.

/** Build a deterministic pseudo-JPEG buffer of `size` bytes. */
function makeBuf(size: number, seed: number): Buffer {
  const buf = Buffer.alloc(size);
  buf[0] = 0xff; buf[1] = 0xd8; // JPEG SOI
  for (let i = 2; i < size; i++) buf[i] = (i * 31 + seed * 7) & 0xff;
  return buf;
}

describe('M12 isSimilarImage divides by actual comparison count', () => {
  it('treats near-identical small buffers (len in [500,1000)) as similar', () => {
    // minlen 1000 → start = floor(0.1*1000) = 100, len = 900, samples = 500, step = 1:
    // loop compares 900 bytes. Flip 54 of them → true ratio 54/900 = 0.06 (< 0.08 = similar).
    // The OLD divisor (500) gave 54/500 = 0.108 (> 0.08) → wrongly "different".
    const a = makeBuf(1000, 1);
    const b = Buffer.from(a);
    let flipped = 0;
    for (let i = 100; i < 1000 && flipped < 54; i += 16) {
      b[i] = b[i] ^ 0xff; // guaranteed differing byte
      flipped++;
    }
    expect(flipped).toBe(54);
    expect(isSimilarImage(a, b, 0.08)).toBe(true); // RED under old divide-by-500
  });

  it('still flags genuinely different buffers as not similar', () => {
    const a = makeBuf(1000, 1);
    const b = makeBuf(1000, 200); // every data byte differs
    expect(isSimilarImage(a, b, 0.08)).toBe(false);
  });

  it('identical buffers are similar', () => {
    const a = makeBuf(4000, 5);
    expect(isSimilarImage(a, Buffer.from(a), 0.08)).toBe(true);
  });

  it('size difference over 15% is immediately not similar', () => {
    const a = makeBuf(10000, 1);
    const b = makeBuf(8000, 1); // 20% smaller
    expect(isSimilarImage(a, b, 0.08)).toBe(false);
  });

  it('perceptualHash is stable for identical content and differs for different content', () => {
    const a = makeBuf(5000, 1);
    expect(perceptualHash(a)).toBe(perceptualHash(Buffer.from(a)));
    expect(perceptualHash(a)).not.toBe(perceptualHash(makeBuf(5000, 99)));
  });
});
