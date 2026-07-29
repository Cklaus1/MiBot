// poll.ts — deadline-driven "first candidate that matches" polling (F7/R9).
//
// The old findElement probed each frame exactly once with isVisible({timeout}) and, on a
// miss, returned frames[last] — an arbitrary iframe (ads/notifications under frame:'any'),
// then waited the full timeout in the wrong place (J4/J5/J8). This driver instead sweeps
// every candidate each round and repeats until a deadline, returning null when nothing
// matches — the caller decides what "nothing" means rather than acting on a wrong element.
//
// The clock is injected (now/sleep) so the logic is unit-testable without real timers.

export interface PollOptions {
  /** Total time budget in ms. */
  deadlineMs: number;
  /** Delay between full-sweep rounds in ms. */
  intervalMs: number;
  /** Monotonic clock; defaults to Date.now. */
  now?: () => number;
  /** Sleep; defaults to a real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Sweep `candidates` with `matches` each round, repeating until one matches or the
 * deadline lapses. Returns the first matching candidate, or null if none matched in time.
 * A throwing `matches` is treated as "no match" (a detached frame must not abort the sweep).
 */
export async function pollForFirst<T>(
  candidates: T[],
  matches: (candidate: T) => Promise<boolean>,
  opts: PollOptions,
): Promise<T | null> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? realSleep;
  const start = now();

  // Always run at least one full sweep, even with a tiny/zero deadline.
  do {
    for (const candidate of candidates) {
      let ok = false;
      try {
        ok = await matches(candidate);
      } catch {
        ok = false;
      }
      if (ok) return candidate;
    }
    if (now() - start >= opts.deadlineMs) break;
    await sleep(opts.intervalMs);
  } while (now() - start < opts.deadlineMs);

  return null;
}
