// signal-dedup.ts — content-stable, occurrence-counted dedup for polled signals (F9/R11).
//
// The old chat deduper (signals.ts M4) keyed on `${sender}::${text}::${domIndex}`.
// Teams/Zoom virtualize the chat list, so scrolling shifts every DOM index and the whole
// visible window re-hashes as "new" → wholesale duplicate chat. The fix is to key on
// stable *content* and count occurrences: the Nth identical (sender,text) pair is emitted
// exactly once, no matter where it sits in the (shifting) visible window.

// ── Reaction rising-edge dedup (M5/R11) ───────────────────────────────────
//
// Reactions are transient floating animations, not a persistent list. Occurrence-counting
// (OccurrenceDeduper) is wrong for them: a reaction that lingers across two polls is the SAME
// event, not two. The right model is a rising edge — emit a reaction only when its (participant,
// type) key is present now but was absent last poll. The caller threads the returned `keys` set
// back in on the next poll; a key that drops out and returns later is a genuinely new reaction.

export interface RawReaction {
  participant: string;
  type: string;
}

export function risingEdgeReactions(
  current: RawReaction[],
  prevKeys: Set<string>,
): { fresh: RawReaction[]; keys: Set<string> } {
  const keyOf = (r: RawReaction) => `${r.participant}::${r.type}`;
  const keys = new Set<string>();
  const fresh: RawReaction[] = [];
  for (const r of current) {
    const key = keyOf(r);
    if (keys.has(key)) continue;      // collapse intra-poll duplicates to one edge
    keys.add(key);
    if (!prevKeys.has(key)) fresh.push(r); // rising edge only
  }
  return { fresh, keys };
}

// ── Hand-raise history (M10) ──────────────────────────────────────────────
//
// Hands were stored in a Map<name, HandRaise> keyed by participant, so a re-raise after a lower
// OVERWROTE the completed earlier raise. HandRaiseTracker keeps full history: a rising edge
// (name present now, no open raise) opens a raise; a falling edge (name gone) closes the open one.
// A hand that stays up across polls is the same raise. finish() closes any still-open hands.

export interface HandRaiseRecord {
  participant: string;
  raised_at: string;
  lowered_at: string | null;
}

export class HandRaiseTracker {
  private completed: HandRaiseRecord[] = [];
  private open = new Map<string, HandRaiseRecord>(); // name → currently-open raise

  /** Feed the set of names currently showing a raised hand this poll, with a timestamp. */
  observe(raisedNames: string[], nowIso: string): void {
    const current = new Set(raisedNames);
    // Rising edges: a name raised now with no open raise starts a new one.
    for (const name of current) {
      if (!this.open.has(name)) {
        this.open.set(name, { participant: name, raised_at: nowIso, lowered_at: null });
      }
    }
    // Falling edges: an open raise whose name is no longer present is completed.
    for (const [name, rec] of this.open) {
      if (!current.has(name)) {
        rec.lowered_at = nowIso;
        this.completed.push(rec);
        this.open.delete(name);
      }
    }
  }

  /** Total raises recorded (completed + still-open). */
  totalRaises(): number {
    return this.completed.length + this.open.size;
  }

  /** Close any still-open hands at `nowIso` and return every raise in completion order. */
  finish(nowIso: string): HandRaiseRecord[] {
    for (const rec of this.open.values()) {
      rec.lowered_at = nowIso;
      this.completed.push(rec);
    }
    this.open.clear();
    return this.completed;
  }
}

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
