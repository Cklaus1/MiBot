import { describe, it, expect, vi } from 'vitest';
import { drainAudioOnce } from '../src/audio-drain.js';
import { camofoxDrainDeps } from '../src/bot.js';

/**
 * Item 3: the Meet (camofox) audio path used a destructive in-page `flushed.splice(0)` that
 * ran BEFORE the payload crossed the REST boundary and was appended — so a failed transfer or
 * a throwing appendFileSync lost that 5s window outright (AU8). It also never called
 * requestData()/stop(), dropping the tail of every recording (AU3). Both are now the same
 * two-phase read→append→ack protocol the Playwright path uses.
 *
 * A FakeCamofoxPage stands in for the REST browser: it records the expressions evaluated,
 * so we can assert on ORDERING — the property that actually makes the protocol safe.
 */
class FakeCamofoxPage {
  calls: string[] = [];
  constructor(private chunks: string[] = ['aGVsbG8=']) {}
  async eval(expr: string): Promise<unknown> {
    this.calls.push(expr);
    if (expr.includes('readAsDataURL')) {
      return this.chunks.length ? { b64: this.chunks[0], count: this.chunks.length } : { b64: '', count: 0 };
    }
    if (expr.includes('splice(0,')) {
      const n = Number(/splice\(0, (\d+)\)/.exec(expr)?.[1] ?? 0);
      this.chunks.splice(0, n);
      return true;
    }
    return true;
  }
}

const kind = (e: string) => (e.includes('readAsDataURL') ? 'read' : e.includes('splice(0,') ? 'ack' : 'other');

describe('camofox DRAIN port (item 3)', () => {
  it('reads, appends, THEN acks — never acks before bytes are on disk', async () => {
    const page = new FakeCamofoxPage();
    const order: string[] = [];
    const deps = camofoxDrainDeps(page as any, '/dev/null');
    const res = await drainAudioOnce({
      ...deps,
      readEncoded: async () => { order.push('read'); return deps.readEncoded(); },
      append: () => { order.push('append'); },
      ack: async (n) => { order.push('ack'); return deps.ack(n); },
    });
    expect(res.appended).toBe(true);
    expect(order).toEqual(['read', 'append', 'ack']);
  });

  it('does NOT ack when append throws — the window survives for the next tick', async () => {
    const page = new FakeCamofoxPage(['aGVsbG8=']);
    const deps = camofoxDrainDeps(page as any, '/dev/null');
    await expect(drainAudioOnce({
      ...deps,
      append: () => { throw new Error('ENOSPC'); },
    })).rejects.toThrow('ENOSPC');
    // The in-page buffer is untouched: no ack was issued.
    expect(page.calls.map(kind)).not.toContain('ack');
    expect((page as any).chunks).toHaveLength(1);
  });

  it('the read expression is non-destructive (slice, not splice)', () => {
    const page = new FakeCamofoxPage();
    void camofoxDrainDeps(page as any, '/dev/null').readEncoded();
    // Asserted against the real expression string the module ships.
    const read = page.calls[0] ?? '';
    expect(read).toContain('slice(0, count)');
    expect(read).not.toMatch(/flushed\.splice\(0\)/);
  });

  it('acks exactly the count that was persisted, not the whole buffer', async () => {
    const page = new FakeCamofoxPage(['a', 'b', 'c']);
    const deps = camofoxDrainDeps(page as any, '/dev/null');
    await deps.ack(2);
    expect((page as any).chunks).toEqual(['c']);
  });

  it('a hung in-page read times out instead of stalling the monitor loop (AU7)', async () => {
    const res = await drainAudioOnce({
      readEncoded: () => new Promise(() => {}),
      append: () => { throw new Error('must not append'); },
      ack: async () => { throw new Error('must not ack'); },
      timeoutMs: 5,
    });
    expect(res).toEqual({ appended: false, bytes: 0, timedOut: true });
  });
});
