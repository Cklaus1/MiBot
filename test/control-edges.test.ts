import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import {
  parseControlResponse, isSocketAlive, sweepStaleSockets,
} from '../src/control.js';

// C9: sendCmd treated ANY response as success — the server serializes a command failure as a
// normal-stream `{ok:false,error}`, so the CLI printed raw JSON and exited 0. parseControlResponse
// is the gate: ok:true → returns result; ok:false → throws the server error; malformed → throws.
describe('parseControlResponse (C9)', () => {
  it('returns the result on ok:true', () => {
    expect(parseControlResponse(JSON.stringify({ ok: true, result: { path: '/x.png' } })))
      .toEqual({ path: '/x.png' });
  });

  it('throws the server-side error message on ok:false', () => {
    expect(() => parseControlResponse(JSON.stringify({ ok: false, error: 'not found in any frame' })))
      .toThrow(/not found in any frame/);
  });

  it('throws on malformed JSON', () => {
    expect(() => parseControlResponse('{ not json')).toThrow();
  });

  it('tolerates a trailing newline (server appends one)', () => {
    expect(parseControlResponse(JSON.stringify({ ok: true, result: 42 }) + '\n')).toBe(42);
  });
});

// C8: the constructor "stale socket" sweep unlinked EVERY .sock older than this process's start
// — including other LIVE bots' sockets (a `mibot join` running next to `mibot start`). Liveness
// must be probed by connecting, not inferred from mtime.
describe('isSocketAlive (C8 liveness probe)', () => {
  function fakeConnect(behavior: 'connect' | 'error'): () => any {
    return () => {
      const sock = new EventEmitter() as any;
      sock.destroy = vi.fn();
      queueMicrotask(() => sock.emit(behavior === 'connect' ? 'connect' : 'error', new Error('ECONNREFUSED')));
      return sock;
    };
  }

  it('resolves true when the socket accepts a connection (a live bot)', async () => {
    expect(await isSocketAlive('/x.sock', fakeConnect('connect'))).toBe(true);
  });

  it('resolves false when the connection is refused (stale socket)', async () => {
    expect(await isSocketAlive('/x.sock', fakeConnect('error'))).toBe(false);
  });
});

describe('sweepStaleSockets (C8)', () => {
  it('unlinks only dead sockets, never a live one or the caller’s own', async () => {
    const unlinked: string[] = [];
    await sweepStaleSockets('/sockdir', 'bot-self.sock', {
      readdir: () => ['bot-1.sock', 'bot-2.sock', 'bot-self.sock', 'notes.txt'],
      isAlive: async (p) => p.endsWith('bot-1.sock'), // bot-1 is live, bot-2 is dead
      unlink: (p) => { unlinked.push(p); },
    });
    // bot-2 (dead) swept; bot-1 (live) and bot-self (own) and the non-sock file left alone.
    expect(unlinked).toEqual(['/sockdir/bot-2.sock']);
  });

  it('never throws when readdir fails (best effort)', async () => {
    await expect(sweepStaleSockets('/nope', 'x.sock', {
      readdir: () => { throw new Error('ENOENT'); },
      isAlive: async () => false,
      unlink: () => {},
    })).resolves.toBeUndefined();
  });
});
