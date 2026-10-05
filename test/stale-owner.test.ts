import { describe, it, expect, afterAll } from 'vitest';
import { spawn } from 'child_process';
import { getDb, closeDb, insertMeeting, getMeeting, recoverStaleMeetings, updateMeeting, isPidAlive } from '../src/db.js';
import { advanceMeeting } from './helpers/status.js';

// Wave 9-A: a host suspend (WSL sleep, laptop lid) longer than 2 minutes stalls every timer, so
// the bot's heartbeat goes stale while the bot is perfectly alive. recoverStaleMeetings then
// failed the row, and the transition guard refused every later write — the live bot's
// participants, timeline and actual_end were never saved. A stale heartbeat is only evidence of
// death when the owning process is actually gone.
afterAll(() => closeDb());

const staleInCall = (ownerPid: number | null) => {
  getDb();
  const m = insertMeeting({ title: 'own', platform: 'teams', join_url: 'https://teams.microsoft.com/o', start_time: new Date().toISOString() });
  advanceMeeting(m.id, 'in_call');
  if (ownerPid !== null) updateMeeting(m.id, { owner_pid: ownerPid });
  getDb().prepare('UPDATE meetings SET heartbeat = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', m.id);
  return m;
};

const deadPid = async (): Promise<number> => {
  const child = spawn('true');
  await new Promise((r) => child.on('exit', r));
  return child.pid!;
};

describe('isPidAlive', () => {
  it('true for this process', () => expect(isPidAlive(process.pid)).toBe(true));
  it('false for an exited process', async () => expect(isPidAlive(await deadPid())).toBe(false));
  it('false for nonsense', () => { expect(isPidAlive(0)).toBe(false); expect(isPidAlive(-5)).toBe(false); });
});

describe('recovery spares a stale row whose owner is alive (Wave 9-A)', () => {
  it('a live owner process (e.g. after host suspend) is NOT failed', () => {
    const sleeper = spawn('sleep', ['30']);
    try {
      const m = staleInCall(sleeper.pid!);
      recoverStaleMeetings();
      expect(getMeeting(m.id)!.status).toBe('in_call');
    } finally { sleeper.kill(); }
  });

  it('a dead owner process IS failed (real crash recovery still works)', async () => {
    const m = staleInCall(await deadPid());
    expect(recoverStaleMeetings()).toBeGreaterThanOrEqual(1);
    expect(getMeeting(m.id)!.status).toBe('failed');
  });

  it('a legacy row with no owner is failed as before', () => {
    const m = staleInCall(null);
    recoverStaleMeetings();
    expect(getMeeting(m.id)!.status).toBe('failed');
  });

  it('the caller decides for its OWN rows: alive only while the bot is still tracked', () => {
    const tracked = staleInCall(process.pid);
    const forgotten = staleInCall(process.pid);
    recoverStaleMeetings((pid, id) => pid === process.pid ? id === tracked.id : isPidAlive(pid));
    expect(getMeeting(tracked.id)!.status).toBe('in_call');
    expect(getMeeting(forgotten.id)!.status).toBe('failed');
  });

  it('by default this process\'s own rows are not trusted (no tracker to vouch for them)', () => {
    const m = staleInCall(process.pid);
    recoverStaleMeetings();
    expect(getMeeting(m.id)!.status).toBe('failed');
  });
});
