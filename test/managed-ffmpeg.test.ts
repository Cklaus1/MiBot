import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { ManagedFfmpeg } from '../src/managed-ffmpeg.js';

// R3 (AU4/AU5/AU6/C14): the raw ffmpeg child had no 'error' handler (a missing binary crashed
// the whole bot), no 'exit' handler (a mid-meeting death — pulse restart, ENOSPC — went unnoticed
// and reported a truncated recording as success), and stopRecording sent SIGINT then immediately
// nulled the handle with no await/SIGKILL (copyFileSync raced ffmpeg finalizing → corrupt webm;
// an ffmpeg that ignores SIGINT leaked forever). ManagedFfmpeg owns all three.

/** A ChildProcess-like fake: EventEmitter + kill() + stderr stream. */
function fakeChild() {
  const child: any = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.signals = [] as string[];
  child.kill = (sig: string) => { child.signals.push(sig); child.killed = true; return true; };
  return child;
}

describe('R3 ManagedFfmpeg', () => {
  it('does not throw when the child emits an error; forwards to onError', () => {
    const child = fakeChild();
    const onError = vi.fn();
    new ManagedFfmpeg(child, { onError });
    expect(() => child.emit('error', new Error('spawn ffmpeg ENOENT'))).not.toThrow();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0][0].message).toContain('ENOENT');
  });

  it('reports an UNEXPECTED exit (death before stop) via onUnexpectedExit', () => {
    const child = fakeChild();
    const onUnexpectedExit = vi.fn();
    new ManagedFfmpeg(child, { onUnexpectedExit });
    child.stderr.emit('data', Buffer.from('No such file or directory'));
    child.emit('exit', 1, null);
    expect(onUnexpectedExit).toHaveBeenCalledOnce();
    const info = onUnexpectedExit.mock.calls[0][0];
    expect(info.code).toBe(1);
    expect(info.stderrTail).toContain('No such file');
  });

  it('does NOT call onUnexpectedExit when the exit follows a stop()', async () => {
    const child = fakeChild();
    const onUnexpectedExit = vi.fn();
    const m = new ManagedFfmpeg(child, { onUnexpectedExit, killTimeoutMs: 50 });
    const p = m.stop();
    child.emit('exit', 0, 'SIGINT'); // clean stop
    await p;
    expect(onUnexpectedExit).not.toHaveBeenCalled();
  });

  it('stop() sends SIGINT and resolves once the child exits', async () => {
    const child = fakeChild();
    const m = new ManagedFfmpeg(child, { killTimeoutMs: 200 });
    const p = m.stop();
    expect(child.signals).toContain('SIGINT');
    child.emit('exit', 0, 'SIGINT');
    await expect(p).resolves.toBeUndefined();
    expect(m.hasExited()).toBe(true);
  });

  it('stop() escalates to SIGKILL when the child ignores SIGINT past the timeout', async () => {
    const child = fakeChild();
    const m = new ManagedFfmpeg(child, { killTimeoutMs: 20 });
    const p = m.stop();
    expect(child.signals).toEqual(['SIGINT']);
    // Never emit exit for SIGINT — force the escalation.
    await new Promise((r) => setTimeout(r, 40));
    child.emit('exit', null, 'SIGKILL'); // die on the kill
    await p;
    expect(child.signals).toContain('SIGKILL');
  });

  it('stop() on an already-exited child is a no-op that resolves', async () => {
    const child = fakeChild();
    const m = new ManagedFfmpeg(child, { killTimeoutMs: 50 });
    child.emit('exit', 0, null);
    await expect(m.stop()).resolves.toBeUndefined();
    expect(child.signals).not.toContain('SIGINT'); // nothing to signal
  });

  it('captures a bounded stderr tail (surfacing AU5 error signatures)', () => {
    const child = fakeChild();
    const m = new ManagedFfmpeg(child, {});
    for (let i = 0; i < 100; i++) child.stderr.emit('data', Buffer.from(`line ${i}`));
    child.stderr.emit('data', Buffer.from('Connection refused'));
    const tail = m.stderrTail();
    expect(tail).toContain('Connection refused');
    expect(tail.split('\n').length).toBeLessThanOrEqual(10); // bounded
  });
});
