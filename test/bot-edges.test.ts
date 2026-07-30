import { describe, it, expect, vi } from 'vitest';
import { isNavTimeout, closeOrKill } from '../src/bot-teardown.js';

// C15: `page.goto(...).catch(...)` swallowed EVERY navigation failure — a DNS error,
// ECONNREFUSED, or an invalid host all fell through to running the playbook against
// about:blank, surfacing minutes later as a misleading "step X not found". Only a genuine
// networkidle *timeout* is safe to continue past (the page often loads enough to join);
// everything else must rethrow. isNavTimeout is the classifier.
describe('isNavTimeout (C15 nav-error triage)', () => {
  it('treats a Playwright timeout as a continue-able timeout', () => {
    expect(isNavTimeout(new Error('Timeout 30000ms exceeded'))).toBe(true);
    expect(isNavTimeout(new Error('page.goto: Timeout 30000ms exceeded.'))).toBe(true);
  });

  it('does NOT treat a real navigation failure as a timeout (must rethrow)', () => {
    expect(isNavTimeout(new Error('net::ERR_NAME_NOT_RESOLVED at https://bad.host/'))).toBe(false);
    expect(isNavTimeout(new Error('net::ERR_CONNECTION_REFUSED'))).toBe(false);
    expect(isNavTimeout(new Error('Invalid URL'))).toBe(false);
  });
});

// C14: `Promise.race([browser.close(), 5s-timer])` — on a lost race browser was set null and the
// finally never retried, so a hung Chromium leaked (holding camera/mic), and the un-cancelled
// timer kept a finished `mibot join` alive for 5s. closeOrKill force-kills the process after the
// race is lost, and its timer never outlives the call.
describe('closeOrKill (C14 hung-browser force kill)', () => {
  it('resolves without killing when close wins the race', async () => {
    const kill = vi.fn();
    await closeOrKill(() => Promise.resolve(), kill, 50);
    expect(kill).not.toHaveBeenCalled();
  });

  it('force-kills when close does not resolve before the deadline', async () => {
    const kill = vi.fn();
    // A close that never resolves — must be force-killed after the (short) deadline.
    await closeOrKill(() => new Promise(() => {}), kill, 10);
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it('never rejects even if close throws (best-effort teardown)', async () => {
    const kill = vi.fn();
    await expect(closeOrKill(() => Promise.reject(new Error('close failed')), kill, 50))
      .resolves.toBeUndefined();
  });

  it('does not leave a pending timer after close wins (call settles promptly)', async () => {
    const kill = vi.fn();
    const start = Date.now();
    await closeOrKill(() => Promise.resolve(), kill, 5000);
    // If the 5000ms timer were awaited, this would take ~5s. It must return at once.
    expect(Date.now() - start).toBeLessThan(1000);
    expect(kill).not.toHaveBeenCalled();
  });
});
