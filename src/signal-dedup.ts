// signal-dedup.ts — content-stable, occurrence-counted dedup for polled signals (F9/R11).
//
// The old chat deduper (signals.ts M4) keyed on `${sender}::${text}::${domIndex}`.
// Teams/Zoom virtualize the chat list, so scrolling shifts every DOM index and the whole
// visible window re-hashes as "new" → wholesale duplicate chat. The fix is to key on
// stable *content* and count occurrences: the Nth identical (sender,text) pair is emitted
// exactly once, no matter where it sits in the (shifting) visible window.

export class OccurrenceDeduper<T> {
  /** Highest occurrence count already emitted for each content key. */
  private seen = new Map<string, number>();

  constructor(private readonly keyOf: (item: T) => string) {}

  /**
   * Feed the full set of items currently visible this poll. Returns only the items not
   * previously emitted. Genuinely repeated identical content (the same key appearing more
   * times than ever before) is treated as new; a re-scrolled window of unchanged content
   * yields nothing.
   */
  add(batch: T[]): T[] {
    // Count occurrences within this batch, assigning each item its 1-based ordinal.
    const batchCount = new Map<string, number>();
    const fresh: T[] = [];

    for (const item of batch) {
      const key = this.keyOf(item);
      const ordinal = (batchCount.get(key) ?? 0) + 1;
      batchCount.set(key, ordinal);
      // Emit only ordinals beyond what we've already emitted for this key.
      if (ordinal > (this.seen.get(key) ?? 0)) {
        fresh.push(item);
      }
    }

    // Advance the high-water mark per key (never decrease — items may scroll out of view).
    for (const [key, count] of batchCount) {
      const prev = this.seen.get(key) ?? 0;
      if (count > prev) this.seen.set(key, count);
    }

    return fresh;
  }
}
