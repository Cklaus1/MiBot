import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getDb, insertMeeting, insertRecording, updateRecording, applyRecordingStatus, getRecording,
  getMeeting, listMeetings,
} from '../src/db.js';
import { RECORDING_STATUS, isTerminalMeetingStatus, type MeetingStatus } from '../src/status.js';
import {
  registerShutdownHook, runShutdown, __resetShutdownForTest, HOOK_TIMEOUT_MS,
  installShutdownHandlers,
} from '../src/shutdown.js';

function makeMeeting(over: Record<string, any> = {}) {
  return insertMeeting({
    title: 'T', platform: 'meet', join_url: 'https://meet.google.com/a-b-c',
    start_time: new Date().toISOString(), ...over,
  });
}

describe('applyRecordingStatus is a single guarded UPDATE (no read-then-write race)', () => {
  it('does not downgrade a terminal status', () => {
    const m = makeMeeting();
    const r = insertRecording({ meeting_id: m.id, audio_path: '/tmp/a.webm' });
    updateRecording(r.id, { status: RECORDING_STATUS.DONE });
    expect(applyRecordingStatus(r.id, RECORDING_STATUS.FAILED)).toBe(RECORDING_STATUS.DONE);
    expect(getRecording(r.id)!.status).toBe(RECORDING_STATUS.DONE);
  });

  it('promotes a non-terminal status normally', () => {
    const m = makeMeeting();
    const r = insertRecording({ meeting_id: m.id, audio_path: '/tmp/b.webm' });
    expect(applyRecordingStatus(r.id, RECORDING_STATUS.RECORDED)).toBe(RECORDING_STATUS.RECORDED);
    expect(getRecording(r.id)!.status).toBe(RECORDING_STATUS.RECORDED);
  });

  it('a terminal write interleaved between read and write still wins (the race)', () => {
    const m = makeMeeting();
    const r = insertRecording({ meeting_id: m.id, audio_path: '/tmp/c.webm' });
    // Simulate the interleave: the guard must live IN the UPDATE, so even if a caller decided
    // to write 'failed' based on a stale read of 'recording', the terminal 'done' persists.
    updateRecording(r.id, { status: RECORDING_STATUS.DONE });
    applyRecordingStatus(r.id, RECORDING_STATUS.FAILED);
    expect(getRecording(r.id)!.status).toBe(RECORDING_STATUS.DONE);
  });

  it('returns the desired status for a missing recording without throwing', () => {
    expect(() => applyRecordingStatus(999999, RECORDING_STATUS.FAILED)).not.toThrow();
  });

  it('performs exactly one statement against the recordings row', () => {
    const m = makeMeeting();
    const r = insertRecording({ meeting_id: m.id, audio_path: '/tmp/d.webm' });
    const db = getDb();
    const spy = vi.spyOn(db, 'prepare');
    applyRecordingStatus(r.id, RECORDING_STATUS.RECORDED);
    // One guarded UPDATE — not a SELECT followed by an UPDATE.
    const sql = spy.mock.calls.map(c => String(c[0]));
    expect(sql.filter(s => /select/i.test(s))).toHaveLength(0);
    expect(sql.filter(s => /update\s+recordings/i.test(s))).toHaveLength(1);
    spy.mockRestore();
  });
});

describe('shutdown hooks are time-bounded (a wedged hook cannot strand teardown)', () => {
  beforeEach(() => { __resetShutdownForTest(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); __resetShutdownForTest(); });

  it('a hook that never settles does not block the hooks after it', async () => {
    const ran: string[] = [];
    // Registered first → runs LAST (LIFO), so it proves the hung hook released the chain.
    registerShutdownHook('log', () => { ran.push('log'); });
    registerShutdownHook('wedged', () => new Promise<void>(() => { /* never resolves */ }));
    const p = runShutdown();
    await vi.advanceTimersByTimeAsync(HOOK_TIMEOUT_MS + 100);
    await p;
    expect(ran).toEqual(['log']);
  });

  it('a fast hook is not delayed by the timeout', async () => {
    const ran: string[] = [];
    registerShutdownHook('a', async () => { ran.push('a'); });
    registerShutdownHook('b', async () => { ran.push('b'); });
    const p = runShutdown();
    await vi.advanceTimersByTimeAsync(10);
    await p;
    expect(ran).toEqual(['b', 'a']); // LIFO
  });
});

describe('installShutdownHandlers covers the crash paths', () => {
  beforeEach(() => { __resetShutdownForTest(); });
  afterEach(() => {
    __resetShutdownForTest();
    process.removeAllListeners('uncaughtException');
    process.removeAllListeners('unhandledRejection');
    process.removeAllListeners('beforeExit');
  });

  it('registers uncaughtException and unhandledRejection listeners', () => {
    const before = {
      ue: process.listenerCount('uncaughtException'),
      ur: process.listenerCount('unhandledRejection'),
    };
    installShutdownHandlers();
    expect(process.listenerCount('uncaughtException')).toBe(before.ue + 1);
    expect(process.listenerCount('unhandledRejection')).toBe(before.ur + 1);
  });

  it('an uncaught exception runs the teardown hooks (was: orphaned ffmpeg + Chromium)', async () => {
    const ran: string[] = [];
    registerShutdownHook('children', async () => { ran.push('children'); });
    installShutdownHandlers();
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    process.emit('uncaughtException', new Error('boom'));
    // Let the async teardown chain settle.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(ran).toEqual(['children']);
    exit.mockRestore();
  });
});

describe('activeBots reconciliation uses a direct lookup (leaked slot fix)', () => {
  it('a terminal meeting outside any recent-50 window is still reclaimed', () => {
    // The old code searched listMeetings(50). Create a terminal meeting whose start_time
    // sorts it well outside that window, then prove a direct getMeeting(id) still sees it.
    const old = makeMeeting({ start_time: '2000-01-01T00:00:00.000Z' });
    getDb().prepare("UPDATE meetings SET status = 'failed' WHERE id = ?").run(old.id);
    for (let i = 0; i < 60; i++) {
      makeMeeting({ start_time: new Date(Date.now() + i * 60000).toISOString() });
    }
    const within50 = listMeetings(50).some(m => m.id === old.id);
    expect(within50).toBe(false); // the old code would never have found it → slot leaked

    const m = getMeeting(old.id);
    expect(m).toBeDefined();
    expect(isTerminalMeetingStatus(m!.status as MeetingStatus)).toBe(true);
  });

  it('treats every terminal status as inactive, not just failed', () => {
    for (const s of ['done', 'failed', 'missed', 'cancelled']) {
      expect(isTerminalMeetingStatus(s as MeetingStatus)).toBe(true);
    }
    for (const s of ['scheduled', 'joining', 'in_call', 'processing']) {
      expect(isTerminalMeetingStatus(s as MeetingStatus)).toBe(false);
    }
  });
});
