import { describe, it, expect } from 'vitest';
import {
  parseCamofoxResponse, camofoxFetch, awaitCamofoxReady, CamofoxApiError,
} from '../src/camofox.js';

// J2: a camofox endpoint can answer HTTP 200 but carry a semantic failure in the body
// ({ok:false, error}). The old validator only checked HTTP status, so `eval` read
// `data.result` (undefined) off a failed call and treated it as success. parseCamofoxResponse
// must reject an explicit `ok:false` object — while still passing bodies with no `ok` field
// (snapshot: {snapshot,refsCount}) and bare values (/tabs: []).
describe('parseCamofoxResponse — J2 semantic ok:false', () => {
  it('throws on a 200 body with ok:false', () => {
    let err: unknown;
    try {
      parseCamofoxResponse('/eval', 200, true, '{"ok":false,"error":"ReferenceError: x is not defined"}');
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(CamofoxApiError);
    expect((err as CamofoxApiError).message).toContain('ReferenceError');
  });

  it('passes a 200 body with ok:true', () => {
    const data = parseCamofoxResponse('/eval', 200, true, '{"ok":true,"result":42}');
    expect(data).toEqual({ ok: true, result: 42 });
  });

  it('passes a body with NO ok field (snapshot shape)', () => {
    const data = parseCamofoxResponse('/snapshot', 200, true, '{"snapshot":"button [e1]","refsCount":1}');
    expect(data).toEqual({ snapshot: 'button [e1]', refsCount: 1 });
  });

  it('passes a bare array body (/tabs)', () => {
    expect(parseCamofoxResponse('/tabs', 200, true, '[]')).toEqual([]);
  });
});

// J15: no fetch had an AbortSignal/timeout — a hung camofox connection blocked the bot
// forever. camofoxFetch must attach a deadline signal and surface an abort as a typed,
// diagnosable CamofoxApiError rather than an infinite hang.
describe('camofoxFetch — J15 timeout', () => {
  it('aborts and throws a timeout CamofoxApiError when fetch hangs past the deadline', async () => {
    const hanging: typeof fetch = ((_url: any, init: any) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const e = new Error('aborted'); e.name = 'TimeoutError'; reject(e);
        });
      })) as any;
    let err: unknown;
    try {
      await camofoxFetch('/snapshot', 'http://camofox.invalid', undefined, { fetchImpl: hanging, timeoutMs: 25 });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(CamofoxApiError);
    expect((err as CamofoxApiError).message.toLowerCase()).toContain('timed out');
  });

  it('passes a normal response through the validator', async () => {
    const okFetch: typeof fetch = (async () =>
      ({ ok: true, status: 200, text: async () => '{"ok":true,"result":"hi"}' })) as any;
    const data = await camofoxFetch('/eval', 'http://x', undefined, { fetchImpl: okFetch, timeoutMs: 1000 });
    expect(data).toEqual({ ok: true, result: 'hi' });
  });
});

// J20: launchCamofox slept a blind 8s after createTab — too short if the page is slow,
// wasteful if fast, and blind to an unresponsive server. awaitCamofoxReady polls a real
// readiness signal (a successful snapshot) to a deadline instead.
describe('awaitCamofoxReady — J20 readiness probe', () => {
  it('returns as soon as snapshot succeeds (does not wait the full deadline)', async () => {
    let calls = 0;
    const page = { snapshot: async () => { calls++; if (calls < 3) throw new Error('loading'); return {}; } };
    let t = 0;
    const ok = await awaitCamofoxReady(page, {
      deadlineMs: 60000, intervalMs: 500, now: () => t, sleep: async (ms) => { t += ms; },
    });
    expect(ok).toBe(true);
    expect(calls).toBe(3); // stopped the instant it became ready
  });

  it('returns false if the page never becomes ready before the deadline', async () => {
    const page = { snapshot: async () => { throw new Error('down'); } };
    let t = 0;
    const ok = await awaitCamofoxReady(page, {
      deadlineMs: 1000, intervalMs: 500, now: () => t, sleep: async (ms) => { t += ms; },
    });
    expect(ok).toBe(false);
  });
});
