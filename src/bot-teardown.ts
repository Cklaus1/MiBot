/**
 * Pure teardown/navigation helpers for the bot lifecycle, extracted so they can
 * be unit-tested without a real browser.
 */

/**
 * Classify a `page.goto` failure (C15). Only a networkidle *timeout* is safe to
 * continue past — the page has usually loaded enough to join, and waiting for
 * full idle on a busy meeting page routinely times out. A real navigation
 * failure (DNS, connection refused, bad URL) means we'd run the whole playbook
 * against about:blank, so the caller must rethrow those instead of pressing on.
 */
export function isNavTimeout(err: Error): boolean {
  return /Timeout\s+\d+ms exceeded|TimeoutError/i.test(err.message);
}

/**
 * Close a browser, force-killing it if it does not shut down within the deadline
 * (C14). The old `Promise.race([close(), 5s-timer])` had two leaks: on a lost
 * race the caller nulled the handle and never retried, so a wedged Chromium kept
 * running (holding camera/mic); and the timer was never cancelled, so a finished
 * `mibot join` lingered for the full 5s. Here the timer is always cleared, and a
 * lost race triggers `kill()`. Best effort: never rejects.
 */
export async function closeOrKill(
  close: () => Promise<void>,
  kill: () => void,
  timeoutMs = 5000,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  try {
    const winner = await Promise.race([
      close().then(() => 'closed' as const).catch(() => 'closed' as const),
      deadline,
    ]);
    if (winner === 'timeout') {
      try { kill(); } catch { /* process already gone */ }
    }
  } finally {
    if (timer) clearTimeout(timer); // never let the timer outlive the call
  }
}
