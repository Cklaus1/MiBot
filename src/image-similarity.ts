import fs from 'fs';
import path from 'path';
// image-similarity.ts — one shared perceptual screenshot-similarity check (M16).
//
// The Playwright path (signals.ts) and the camofox path (bot.ts) each had a near-identical
// inline copy of this logic, and BOTH shared the M12 bug: the compare loop runs `len/step`
// iterations but the diff ratio was divided by `samples` (capped at 500). When 500 ≤ len < 1000,
// `step` collapses to 1, so the loop compares up to 999 bytes while dividing by 500 — inflating
// the ratio ~2× and misclassifying a near-identical small screenshot as different (saving a
// duplicate slide). The fix: divide by the actual number of comparisons made.

/**
 * Perceptual hash of a JPEG-ish buffer: skip the header/metadata, sample the image data at
 * structured intervals, fold into a rotating XOR hash. Stable for visually identical content.
 */
export function perceptualHash(buf: Buffer): string {
  const start = Math.min(2048, Math.floor(buf.length * 0.1));
  const end = buf.length;
  const dataLen = end - start;
  if (dataLen < 100) return buf.length.toString(16); // too small — use size

  const step = Math.max(1, Math.floor(dataLen / 256));
  let hash = 0;
  for (let i = start; i < end; i += step) {
    hash = ((hash << 5) - hash + buf[i]) | 0;
  }
  return hash.toString(16);
}

/**
 * Compare two screenshot buffers for visual similarity. `threshold` is the max fraction of
 * sampled bytes allowed to differ (e.g. 0.08 = 8%). Returns true when the images look the same.
 */
export function isSimilarImage(a: Buffer, b: Buffer, threshold: number): boolean {
  // Quick reject: sizes differing by more than 15% are definitely different content.
  const sizeDiff = Math.abs(a.length - b.length) / Math.max(a.length, b.length);
  if (sizeDiff > 0.15) return false;

  // Fast path: identical perceptual hashes.
  if (perceptualHash(a) === perceptualHash(b)) return true;

  // Byte-sample fallback: compare evenly-spaced data bytes (skip headers).
  const start = Math.min(2048, Math.floor(Math.min(a.length, b.length) * 0.1));
  const len = Math.min(a.length, b.length) - start;
  if (len <= 0) return true; // nothing to compare beyond the header → treat as same
  const samples = Math.min(500, len);
  const step = Math.max(1, Math.floor(len / samples));

  let diffCount = 0;
  let compared = 0; // M12: count actual comparisons and divide by THIS, not `samples`.
  for (let i = start; i < start + len; i += step) {
    if (a[i] !== b[i]) diffCount++;
    compared++;
  }

  return compared === 0 ? true : (diffCount / compared) < threshold;
}

/** Shared cap on screen-share screenshots per meeting, for both engines. */
export const MAX_SCREENSHOTS = 240;

/** File extension from an image's magic bytes. Camofox returns PNG; it was being saved as .jpg. */
export function imageExtension(buf: Buffer): 'png' | 'jpg' | 'webp' | 'img' {
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return 'img';
}

/** Per-meeting screenshot bookkeeping for ShareScreenshots. */
export class ShareScreenshots {
  readonly paths: string[] = [];
  private last: Buffer | null = null;

  constructor(private readonly dir: string, private readonly max = MAX_SCREENSHOTS) {}

  /** Room for another? Check BEFORE capturing, so a capped meeting stops paying for screenshots. */
  get full(): boolean { return this.paths.length >= this.max; }

  /**
   * Wave 9-I: save a share screenshot unless the cap is reached, it's too small to be real, or
   * it's visually the same as the last one saved. The camofox loop had no cap (an 8h
   * presentation → ~960 files) and wrote PNG bytes under a .jpg name. Returns the path or null.
   */
  save(buf: Buffer, now: number = Date.now()): string | null {
    if (this.full || buf.length <= 1000) return null;
    if (this.last && isSimilarImage(this.last, buf, 0.08)) return null;
    const p = path.join(this.dir, `share-${now}.${imageExtension(buf)}`);
    fs.writeFileSync(p, buf);
    this.paths.push(p);
    this.last = buf;
    return p;
  }
}
