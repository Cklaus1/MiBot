import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import vm from 'vm';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import {
  drainAudioOnce, DrainState, buildReadExpr, buildAckExpr, segmentPath, assembleSegments,
  type DrainDeps,
} from '../src/audio-drain.js';
import { camofoxDrainDeps } from '../src/bot.js';
import { flushAudioToDisk, FrameDrain } from '../src/webrtc-capture.js';

/**
 * DRAIN (AU3/AU7/AU8/AU12) + Wave 9-C, tested by EXECUTING the real in-page read/ack expressions
 * against a simulated page window (fake Blob/FileReader in a vm), driven through the same deps
 * production uses. Chunks are short strings so file contents can be asserted exactly.
 */
function makeWindow() {
  const sandbox: any = {
    Blob: class { constructor(public parts: string[]) {} },
    FileReader: class {
      result = ''; onload: any; onerror: any; onabort: any;
      readAsDataURL(b: any) {
        this.result = 'data:audio/webm;base64,' + Buffer.from(b.parts.join('')).toString('base64');
        Promise.resolve().then(() => this.onload());
      }
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  return {
    win: sandbox,
    eval: (expr: string) => vm.runInContext(expr, sandbox),
    push: (...c: string[]) => { (sandbox.__mibotFlushedChunks ||= []).push(...c); },
    buffered: (): string[] => [...(sandbox.__mibotFlushedChunks ?? [])],
  };
}

/** A camofox page whose window can be replaced (a reload), with an ack that can be made to fail. */
function makePage() {
  let w = makeWindow();
  const page = {
    failAck: false,
    eval: async (expr: string) => {
      if (page.failAck && expr.includes('__mibotFlushedBase = base + n')) throw new Error('camofox 502');
      return w.eval(expr);
    },
    get w() { return w; },
    reload() { w = makeWindow(); },
  };
  return page;
}

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mibot-drain-')), 'a-webrtc.webm');
const read = (p: string) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => { errSpy = vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => errSpy.mockRestore());

describe('DRAIN ordering (AU8)', () => {
  it('reads, appends, THEN acks', async () => {
    const page = makePage(); page.w.push('c0');
    const order: string[] = [];
    const real = camofoxDrainDeps(page as any, tmp());
    const deps: DrainDeps = {
      ...real,
      readEncoded: async (...a) => { order.push('read'); return real.readEncoded(...a); },
      append: (...a) => { order.push('append'); real.append(...a); },
      ack: async (...a) => { order.push('ack'); return real.ack(...a); },
    };
    expect((await drainAudioOnce(deps, new DrainState())).appended).toBe(true);
    expect(order).toEqual(['read', 'append', 'ack']);
  });

  it('the read is non-destructive; the ack removes exactly what was persisted', async () => {
    const page = makePage(); page.w.push('c0', 'c1');
    const out = tmp(); const state = new DrainState();
    const real = camofoxDrainDeps(page as any, out);
    await drainAudioOnce({
      ...real,
      // A chunk lands mid-transfer, after the read but before the ack.
      append: (buf, seg) => { expect(page.w.buffered()).toEqual(['c0', 'c1']); page.w.push('c2'); real.append(buf, seg); },
    }, state);
    expect(read(out)).toBe('c0c1');
    expect(page.w.buffered()).toEqual(['c2']); // survived the ack
    await drainAudioOnce(real, state);
    expect(read(out)).toBe('c0c1c2');
  });

  it('append throws (ENOSPC) → no ack, nothing lost, retried exactly once', async () => {
    const page = makePage(); page.w.push('c0');
    const out = tmp(); const state = new DrainState();
    const real = camofoxDrainDeps(page as any, out);
    await expect(drainAudioOnce({ ...real, append: () => { throw new Error('ENOSPC'); } }, state)).rejects.toThrow('ENOSPC');
    expect(page.w.buffered()).toEqual(['c0']);
    await drainAudioOnce(real, state);
    expect(read(out)).toBe('c0');
  });

  it('empty buffer → nothing appended', async () => {
    const page = makePage(); const out = tmp();
    expect(await drainAudioOnce(camofoxDrainDeps(page as any, out), new DrainState()))
      .toEqual({ appended: false, bytes: 0, timedOut: false });
    expect(fs.existsSync(out)).toBe(false);
  });

  it('a hung read is bounded by the timeout (AU7)', async () => {
    const res = await drainAudioOnce({
      readEncoded: () => new Promise(() => {}),
      append: () => { throw new Error('must not append'); },
      ack: async () => { throw new Error('must not ack'); },
      timeoutMs: 5,
    }, new DrainState());
    expect(res).toEqual({ appended: false, bytes: 0, timedOut: true });
  });
});

describe('Wave 9-C: a failed ack no longer duplicates audio', () => {
  it('append ok + ack fails → the next drain does not re-append those chunks', async () => {
    const page = makePage(); page.w.push('c0', 'c1');
    const out = tmp(); const state = new DrainState();
    const deps = camofoxDrainDeps(page as any, out);
    page.failAck = true;
    await drainAudioOnce(deps, state);            // ack failed; c0,c1 still buffered in-page
    expect(page.w.buffered()).toEqual(['c0', 'c1']);
    page.failAck = false;
    page.w.push('c2');
    await drainAudioOnce(deps, state);
    expect(read(out)).toBe('c0c1c2');             // was: c0c1c0c1c2
    expect(page.w.buffered()).toEqual([]);        // and the late ack cleaned up everything
  });
});

describe('Wave 9-C: a recorder restart starts a new segment instead of splicing', () => {
  it('a reload (new window, fresh buffer) writes to segment 1 and skips nothing', async () => {
    const page = makePage(); page.w.push('a0', 'a1');
    const out = tmp(); const state = new DrainState();
    const deps = camofoxDrainDeps(page as any, out);
    await drainAudioOnce(deps, state);
    page.reload();                               // new window: new recorder, buffer restarts at seq 0
    page.w.push('b0');
    await drainAudioOnce(deps, state);
    expect(read(out)).toBe('a0a1');               // segment 0 untouched by the second stream
    expect(read(segmentPath(out, 1))).toBe('b0'); // nothing skipped despite nextSeq having been 2
    expect(state.segmentCount).toBe(2);
  });

  it('an ack aimed at the previous recorder is a no-op on the new one', () => {
    const w = makeWindow(); w.push('x0', 'x1');
    w.eval(buildReadExpr(0, null));               // assigns this window its recorder id
    expect(w.eval(buildAckExpr(2, 'some-other-recorder'))).toBe(false);
    expect(w.buffered()).toEqual(['x0', 'x1']);
  });
});

describe('Playwright: AU12 frame commitment (Wave 9-C)', () => {
  const frameOf = (w: ReturnType<typeof makeWindow>) => {
    const f = { detached: false, isDetached: () => f.detached, evaluate: async (e: string) => w.eval(e) };
    return f;
  };
  it('locks onto the first frame with audio and ignores other frames afterwards', async () => {
    const a = makeWindow(); const b = makeWindow();
    const fa = frameOf(a); const fb = frameOf(b);
    const page = { mainFrame: () => fa, frames: () => [fa, fb] };
    const out = tmp(); const drain = new FrameDrain();
    a.push('A0');
    await flushAudioToDisk(page as any, out, drain);
    b.push('B0'); a.push('A1');
    await flushAudioToDisk(page as any, out, drain);
    await flushAudioToDisk(page as any, out, drain);
    expect(read(out)).toBe('A0A1');              // B never interleaved into the file
    expect(drain.frame).toBe(fa);
  });

  it('releases the lock when the committed frame is detached', async () => {
    const a = makeWindow(); const b = makeWindow();
    const fa = frameOf(a); const fb = frameOf(b);
    const page = { mainFrame: () => fa, frames: () => [fa, fb] };
    const out = tmp(); const drain = new FrameDrain();
    a.push('A0');
    await flushAudioToDisk(page as any, out, drain);
    fa.detached = true; b.push('B0');
    await flushAudioToDisk(page as any, out, drain);
    expect(drain.frame).toBe(fb);
    expect(read(segmentPath(out, 1))).toBe('B0'); // different recorder → its own segment
  });
});

describe('assembleSegments (real ffmpeg)', () => {
  const haveFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version']); return true; } catch { return false; } })();
  const gen = (p: string, src: string) => execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', src,
    '-c:a', 'libopus', '-live', '1', '-f', 'webm', p]);
  const decodedSec = (p: string) => {
    const r = execFileSync('sh', ['-c', `ffmpeg -hide_banner -nostdin -i '${p}' -f null - 2>&1 | grep -oE 'time=[0-9:.]+' | tail -1`], { encoding: 'utf8' }).trim();
    const [, h, m, s] = /time=(\d+):(\d+):([\d.]+)/.exec(r)!;
    return Number(h) * 3600 + Number(m) * 60 + Number(s);
  };

  it.skipIf(!haveFfmpeg)('joins two recorder streams into one valid file (byte-append decoded as 3s of 7s)', async () => {
    const base = tmp();
    gen(base, 'sine=f=440:d=4');
    gen(segmentPath(base, 1), 'sine=f=660:d=3');
    expect(await assembleSegments(base, 2)).toBe(true);
    expect(decodedSec(base)).toBeGreaterThan(6.5);
    expect(fs.existsSync(segmentPath(base, 1))).toBe(false);
  });

  it.skipIf(!haveFfmpeg)('an undecodable segment is never deleted or silently dropped', async () => {
    // ffmpeg's concat exits 0 even here — the first version trusted that and deleted segment 1.
    const base = tmp();
    gen(base, 'sine=f=440:d=2');
    fs.writeFileSync(segmentPath(base, 1), 'not a webm');
    expect(await assembleSegments(base, 2)).toBe(false);
    expect(fs.readFileSync(segmentPath(base, 1), 'utf8')).toBe('not a webm');
    expect(decodedSec(base)).toBeGreaterThan(1.5);
  });

  it.skipIf(!haveFfmpeg)('joins the decodable segments around a bad one, and keeps the bad one', async () => {
    const base = tmp();
    gen(base, 'sine=f=440:d=2');
    fs.writeFileSync(segmentPath(base, 1), 'garbage');
    gen(segmentPath(base, 2), 'sine=f=660:d=2');
    expect(await assembleSegments(base, 3)).toBe(false); // not fully clean...
    expect(decodedSec(base)).toBeGreaterThan(3.5);         // ...but both real streams are joined
    expect(fs.existsSync(segmentPath(base, 1))).toBe(true);
    expect(fs.existsSync(segmentPath(base, 2))).toBe(false);
  });

  it('one segment is a no-op', async () => {
    expect(await assembleSegments(tmp(), 1)).toBe(true);
  });
});
