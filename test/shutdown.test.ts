import { describe, it, expect, vi } from 'vitest';
import { runShutdown, registerShutdownHook, __resetShutdownForTest } from '../src/shutdown.js';

// C1 + C13 + D9: before this, ControlChannel registered SIGINT/SIGTERM handlers that called
// stop() but never exited — Ctrl+C did nothing while the browser and ffmpeg kept running — and
// each meeting leaked two more listeners. And closeDb (D9) / log.close (C13) had no shutdown
// call site, so WAL was never checkpointed and the JSONL stream never flushed. runShutdown is
// the SINGLE graceful teardown path: run every registered hook exactly once, in reverse
// (LIFO/atexit) order so the earliest-registered long-lived resources (log, db) unwind last,
// swallowing individual hook errors so one failure can't strand the rest.
describe('runShutdown (C1/C13/D9 single graceful teardown)', () => {
  it('runs every hook once, in reverse (LIFO) registration order', async () => {
    __resetShutdownForTest();
    const order: string[] = [];
    // Registered startup-first: log, db … then a bot's children hook later.
    registerShutdownHook('log', () => { order.push('log'); });
    registerShutdownHook('db', () => { order.push('db'); });
    registerShutdownHook('children', () => { order.push('children'); });
    await runShutdown();
    // Children stop first; log flushes last (still open to catch final lines).
    expect(order).toEqual(['children', 'db', 'log']);
  });

  it('is idempotent — a second call runs nothing (double signal / exit event)', async () => {
    __resetShutdownForTest();
    const hook = vi.fn();
    registerShutdownHook('x', hook);
    await runShutdown();
    await runShutdown();
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it('a throwing hook does not strand the remaining hooks', async () => {
    __resetShutdownForTest();
    const after = vi.fn();
    registerShutdownHook('boom', () => { throw new Error('teardown failed'); });
    registerShutdownHook('after', after);
    await expect(runShutdown()).resolves.toBeUndefined();
    expect(after).toHaveBeenCalledTimes(1);
  });

  it('awaits async hooks (e.g. awaited ffmpeg/browser close) before resolving', async () => {
    __resetShutdownForTest();
    let done = false;
    registerShutdownHook('slow', async () => {
      await new Promise((r) => setTimeout(r, 5));
      done = true;
    });
    await runShutdown();
    expect(done).toBe(true);
  });
});
