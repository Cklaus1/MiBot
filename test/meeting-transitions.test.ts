import { describe, it, expect, vi, afterEach } from 'vitest';
import { insertMeeting, updateMeeting, updateMeetingStatus, getMeeting } from '../src/db.js';

// The MEETING_TRANSITIONS table in status.ts was fully specified but NEVER called by any write
// path: updateMeetingStatus wrote any string unconditionally, and updateMeeting validated the
// column NAME but never the VALUE. So `done -> joining` (re-joining a completed meeting) and
// the catch-all `-> failed` after `done` both passed silently. Enforcement is a guarded UPDATE
// (WHERE status IN <legal predecessors>) so it stays atomic rather than read-then-write.

function mk(status?: string) {
  const m = insertMeeting({
    title: 'T', platform: 'meet', join_url: 'https://meet.google.com/a-b-c',
    start_time: new Date().toISOString(),
  });
  if (status && status !== 'scheduled') {
    // Walk the legal path to reach the desired starting status.
    const path: Record<string, string[]> = {
      joining: ['joining'],
      in_call: ['joining', 'in_call'],
      processing: ['joining', 'in_call', 'processing'],
      done: ['joining', 'in_call', 'processing', 'done'],
      failed: ['failed'],
      missed: ['missed'],
      cancelled: ['cancelled'],
    };
    for (const s of path[status]) updateMeetingStatus(m.id, s);
  }
  return m;
}

afterEach(() => vi.restoreAllMocks());

describe('legal transitions still work', () => {
  it('walks the full happy path', () => {
    const m = mk();
    for (const s of ['joining', 'in_call', 'processing', 'done']) {
      updateMeetingStatus(m.id, s);
      expect(getMeeting(m.id)!.status).toBe(s);
    }
  });

  it('allows scheduled -> cancelled and scheduled -> missed', () => {
    expect((() => { const m = mk(); updateMeetingStatus(m.id, 'cancelled'); return getMeeting(m.id)!.status; })()).toBe('cancelled');
    expect((() => { const m = mk(); updateMeetingStatus(m.id, 'missed'); return getMeeting(m.id)!.status; })()).toBe('missed');
  });

  it('allows a failure from any active status', () => {
    for (const from of ['scheduled', 'joining', 'in_call', 'processing']) {
      const m = mk(from);
      updateMeetingStatus(m.id, 'failed');
      expect(getMeeting(m.id)!.status).toBe('failed');
    }
  });
});

describe('illegal transitions are rejected', () => {
  it('done -> joining is refused (re-joining a completed meeting)', () => {
    const m = mk('done');
    updateMeetingStatus(m.id, 'joining');
    expect(getMeeting(m.id)!.status).toBe('done');
  });

  it('a catch-all failed never clobbers done (the meeting-side C7)', () => {
    const m = mk('done');
    updateMeetingStatus(m.id, 'failed');
    expect(getMeeting(m.id)!.status).toBe('done');
  });

  it('every terminal status is a dead end', () => {
    for (const terminal of ['done', 'failed', 'missed', 'cancelled']) {
      const m = mk(terminal);
      for (const to of ['scheduled', 'joining', 'in_call', 'processing']) {
        updateMeetingStatus(m.id, to);
        expect(getMeeting(m.id)!.status).toBe(terminal);
      }
    }
  });

  it('cannot skip a step (scheduled -> in_call)', () => {
    const m = mk();
    updateMeetingStatus(m.id, 'in_call');
    expect(getMeeting(m.id)!.status).toBe('scheduled');
  });

  it('logs the refusal rather than failing silently', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const m = mk('done');
    updateMeetingStatus(m.id, 'joining');
    expect(spy.mock.calls.flat().join(' ')).toMatch(/illegal|refused|transition/i);
  });

  it('an unknown status value is refused, not written', () => {
    const m = mk();
    updateMeetingStatus(m.id, 'banana');
    expect(getMeeting(m.id)!.status).toBe('scheduled');
  });
});

describe('a rejected status write does not partially apply its other columns', () => {
  it('actual_start is not written when the status half is illegal', () => {
    const m = mk('done');
    updateMeeting(m.id, { status: 'in_call', actual_start: '2026-01-01T00:00:00.000Z' });
    const after = getMeeting(m.id)!;
    expect(after.status).toBe('done');
    expect(after.actual_start).not.toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('non-status updates are unaffected', () => {
  it('writes normal columns and still refreshes the heartbeat', () => {
    const m = mk('in_call');
    updateMeeting(m.id, { title: 'Renamed' });
    expect(getMeeting(m.id)!.title).toBe('Renamed');
    expect(getMeeting(m.id)!.heartbeat).toBeTruthy();
  });

  it('a same-status write is an idempotent no-op, not a refusal', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const m = mk('in_call');
    updateMeeting(m.id, { status: 'in_call', participants: '[]' });
    expect(getMeeting(m.id)!.status).toBe('in_call');
    expect(getMeeting(m.id)!.participants).toBe('[]');
    expect(spy.mock.calls.flat().join(' ')).not.toMatch(/illegal|refused/i);
  });
});
