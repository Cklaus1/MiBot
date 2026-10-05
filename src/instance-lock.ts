import fs from 'fs';
import path from 'path';

/**
 * Wave 9-K: single-instance lock for the watcher. Two `mibot start` processes both read the same
 * 'scheduled' row, and the scheduled→joining write accepts a repeat of the current status, so
 * BOTH bots joined every meeting. The lock is a pid file created with O_EXCL; a lock whose pid is
 * dead (a crashed watcher) is reclaimed.
 *
 * Known gap, accepted: two watchers started within milliseconds of each other while a STALE
 * lock exists can both reclaim it. Node has no portable flock; the re-read check below narrows
 * that window to the two reclaims interleaving exactly.
 */
export type LockResult = { ok: true; release: () => void } | { ok: false; heldBy: number };

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

function readPid(lockPath: string): number {
  try { return Number(fs.readFileSync(lockPath, 'utf8').trim()); } catch { return NaN; }
}

export function acquireInstanceLock(lockPath: string, pid: number = process.pid): LockResult {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lockPath, String(pid), { flag: 'wx' });
      if (readPid(lockPath) !== pid) continue; // lost a reclaim race
      const release = () => { if (readPid(lockPath) === pid) { try { fs.unlinkSync(lockPath); } catch { /* gone */ } } };
      return { ok: true, release };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const holder = readPid(lockPath);
      if (holder !== pid && pidAlive(holder)) return { ok: false, heldBy: holder };
      try { fs.unlinkSync(lockPath); } catch { /* someone else reclaimed it */ }
    }
  }
  return { ok: false, heldBy: readPid(lockPath) };
}
