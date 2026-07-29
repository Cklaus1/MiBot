import { describe, it, expect, vi } from 'vitest';
import { drainAudioOnce } from '../src/audio-drain.js';

// DRAIN (OQ5, unifies AU3/AU8/AU12) + AU7. The old flushAudioToDisk did:
//   const chunks = flushed.splice(0);            // DESTRUCTIVE — removes before transfer
//   ...encode... appendFileSync(path, buf);      // if THIS throws, chunks are already gone
// so a failed CDP transfer or an ENOSPC append permanently lost that 15s window (AU8), and the
// error was swallowed by audio.ts's catch{}. And the in-page FileReader had no onerror, so a read
// failure left frame.evaluate hanging forever → stopAudioCapture never returned (AU7).
//
// drainAudioOnce is the node-side orchestrator: two-phase read → append → ack. It removes chunks
// from the page ONLY after the append succeeds, and bounds the read with a timeout.

function makeDeps(over: Partial<Parameters<typeof drainAudioOnce>[0]> = {}) {
  const events: string[] = [];
  return {
    events,
    deps: {
      readEncoded: vi.fn(async () => { events.push('read'); return { b64: 'YWJj', count: 2 }; }),
      append: vi.fn((_buf: Buffer) => { events.push('append'); }),
      ack: vi.fn(async (_n: number) => { events.push('ack'); }),
      timeoutMs: 1000,
      ...over,
    },
  };
}

describe('DRAIN drainAudioOnce (two-phase read→append→ack)', () => {
  it('reads, appends, THEN acks — in that order', async () => {
    const { events, deps } = makeDeps();
    const r = await drainAudioOnce(deps);
    expect(events).toEqual(['read', 'append', 'ack']);
    expect(r.appended).toBe(true);
    expect(r.bytes).toBe(3); // "abc"
  });

  it('acks exactly the count that was read (chunks arriving mid-transfer survive)', async () => {
    const { deps } = makeDeps();
    await drainAudioOnce(deps);
    expect(deps.ack).toHaveBeenCalledWith(2);
  });

  it('does NOT ack when append throws — the window is retried next tick (AU8)', async () => {
    const { deps } = makeDeps({
      append: vi.fn(() => { throw new Error('ENOSPC'); }),
    });
    await expect(drainAudioOnce(deps)).rejects.toThrow('ENOSPC');
    expect(deps.readEncoded).toHaveBeenCalledOnce();
    expect(deps.append).toHaveBeenCalledOnce();
    expect(deps.ack).not.toHaveBeenCalled(); // data stays in the page buffer
  });

  it('empty read → no append, no ack, appended:false', async () => {
    const { deps } = makeDeps({ readEncoded: vi.fn(async () => ({ b64: '', count: 0 })) });
    const r = await drainAudioOnce(deps);
    expect(r.appended).toBe(false);
    expect(deps.append).not.toHaveBeenCalled();
    expect(deps.ack).not.toHaveBeenCalled();
  });

  it('a read that hangs is bounded by the timeout, not left forever (AU7)', async () => {
    const { deps } = makeDeps({
      readEncoded: vi.fn(() => new Promise(() => {})), // never settles
      timeoutMs: 20,
    });
    const r = await drainAudioOnce(deps);
    expect(r.appended).toBe(false);
    expect(r.timedOut).toBe(true);
    expect(deps.append).not.toHaveBeenCalled();
  });
});
