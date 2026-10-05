import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { acquireInstanceLock } from '../src/instance-lock.js';

// Wave 9-K: two watchers both joined every meeting. Only one may hold the lock.
const lockFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mibot-lock-')), 'watcher.lock');
const deadPid = async () => { const c = spawn('true'); await new Promise((r) => c.on('exit', r)); return c.pid!; };

describe('acquireInstanceLock', () => {
  it('the first watcher gets it; a second live one is refused and told who holds it', () => {
    const f = lockFile();
    const sleeper = spawn('sleep', ['30']);
    try {
      const a = acquireInstanceLock(f, sleeper.pid!);
      expect(a.ok).toBe(true);
      expect(acquireInstanceLock(f, process.pid)).toEqual({ ok: false, heldBy: sleeper.pid });
    } finally { sleeper.kill(); }
  });

  it('a lock left by a crashed watcher (dead pid) is reclaimed', async () => {
    const f = lockFile();
    fs.writeFileSync(f, String(await deadPid()));
    const r = acquireInstanceLock(f);
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(f, 'utf8')).toBe(String(process.pid));
  });

  it('a garbage lock file is reclaimed', () => {
    const f = lockFile();
    fs.writeFileSync(f, 'not-a-pid');
    expect(acquireInstanceLock(f).ok).toBe(true);
  });

  it('release removes the lock so the next watcher can start', () => {
    const f = lockFile();
    const r = acquireInstanceLock(f);
    if (!r.ok) throw new Error('expected lock');
    r.release();
    expect(fs.existsSync(f)).toBe(false);
  });

  it('release never deletes a lock someone else now holds', () => {
    const f = lockFile();
    const r = acquireInstanceLock(f);
    if (!r.ok) throw new Error('expected lock');
    fs.writeFileSync(f, '999999'); // taken over (e.g. after we were judged dead)
    r.release();
    expect(fs.readFileSync(f, 'utf8')).toBe('999999');
  });
});
