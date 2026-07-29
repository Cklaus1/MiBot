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
