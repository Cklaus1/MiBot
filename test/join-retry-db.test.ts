import { describe, it, expect, afterAll, vi, beforeEach, afterEach } from 'vitest';
import {
  getDb, closeDb, insertMeeting, getMeeting, getUpcomingMeetings, sweepMissedMeetings,
  handleJoinFailure,
} from '../src/db.js';
import { advanceMeeting } from './helpers/status.js';

let spy: ReturnType<typeof vi.spyOn>;
beforeEach(() => { spy = vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => spy.mockRestore());
afterAll(() => closeDb());

const iso = (offsetMin: number) => new Date(Date.now() + offsetMin * 60_000).toISOString();
let n = 0;
const mk = (startMin: number, endMin: number | null, eventId: string | null = `m365:jr-${Date.now()}-${n++}`) => {
  getDb();
  return insertMeeting({
    title: 'retry', platform: 'zoom', join_url: `https://zoom.us/j/jr${n}`,
    start_time: iso(startMin), end_time: endMin === null ? undefined : iso(endMin),
    calendar_event_id: eventId ?? undefined,
  });
};
const upcomingIds = () => getUpcomingMeetings(3).map((m) => m.id);

describe('handleJoinFailure', () => {
  it('a failed join goes back to scheduled with a backoff and a counted attempt', () => {
    const m = mk(-2, 28);
    advanceMeeting(m.id, 'joining');
    const outcome = handleJoinFailure(m.id);
    expect(outcome).toMatchObject({ retry: true, attempt: 1 });
    const row = getMeeting(m.id)!;
    expect(row.status).toBe('scheduled');
    expect(row.join_attempts).toBe(1);
    expect(Date.parse(row.next_join_at!)).toBeGreaterThan(Date.now());
  });

  it('attempts accumulate across failures', () => {
    const m = mk(-2, 58);
    for (let i = 1; i <= 3; i++) {
      advanceMeeting(m.id, 'joining');
      expect(handleJoinFailure(m.id)).toMatchObject({ retry: true, attempt: i });
    }
    expect(getMeeting(m.id)!.join_attempts).toBe(3);
  });

  it('a meeting that is over is failed, not retried', () => {
    const m = mk(-60, -1 + 0.5); // ends 30s from now: no room for a 1-minute backoff
    advanceMeeting(m.id, 'joining');
    expect(handleJoinFailure(m.id)).toMatchObject({ retry: false, reason: 'meeting-over' });
    expect(getMeeting(m.id)!.status).toBe('failed');
  });

  it('a failure after in_call is still a plain failure', () => {
    const m = mk(-2, 28);
    advanceMeeting(m.id, 'in_call');
    expect(handleJoinFailure(m.id)).toMatchObject({ retry: false, reason: 'not-a-join-failure' });
    expect(getMeeting(m.id)!.status).toBe('failed');
  });

  it('a manual join (no calendar event) is not retried', () => {
    const m = mk(-2, 28, null);
    advanceMeeting(m.id, 'joining');
    expect(handleJoinFailure(m.id)).toMatchObject({ retry: false, reason: 'manual-join' });
    expect(getMeeting(m.id)!.status).toBe('failed');
  });
});

describe('the scheduler honours the retry', () => {
  it('a retry is NOT picked up before its backoff elapses', () => {
    const m = mk(-2, 28);
    advanceMeeting(m.id, 'joining');
    handleJoinFailure(m.id);
    expect(upcomingIds()).not.toContain(m.id);
  });

  it('it IS picked up once the backoff has elapsed', () => {
    const m = mk(-2, 28);
    advanceMeeting(m.id, 'joining');
    handleJoinFailure(m.id);
    getDb().prepare('UPDATE meetings SET next_join_at = ? WHERE id = ?').run(iso(-0.1), m.id);
    expect(upcomingIds()).toContain(m.id);
  });

  it('a meeting still running 45 minutes after its start is joinable (was: invisible after 30)', () => {
    const m = mk(-45, 15);
    expect(upcomingIds()).toContain(m.id);
  });

  it('a meeting that has ended is not joinable', () => {
    const m = mk(-60, -5);
    expect(upcomingIds()).not.toContain(m.id);
  });

  // Rows are created BEFORE querying: in expect(q()).toContain(mk().id), q() runs first.
  it('with no end time, start + 60 min bounds it', () => {
    const running = mk(-45, null);
    const over = mk(-65, null);
    expect(upcomingIds()).toContain(running.id);
    expect(upcomingIds()).not.toContain(over.id);
  });

  it('a future meeting still waits for the join-before window', () => {
    const later = mk(30, 60);
    const soon = mk(2, 30);
    expect(upcomingIds()).not.toContain(later.id);
    expect(upcomingIds()).toContain(soon.id);
  });
});

describe('the missed sweep no longer kills a meeting that is still running', () => {
  it('a retrying meeting 40 min past start with time left survives the sweep', () => {
    const m = mk(-40, 20);
    advanceMeeting(m.id, 'joining');
    handleJoinFailure(m.id);
    sweepMissedMeetings();
    expect(getMeeting(m.id)!.status).toBe('scheduled');
  });

  it('a meeting that ended unjoined is still swept to missed', () => {
    const m = mk(-60, -5);
    sweepMissedMeetings();
    expect(getMeeting(m.id)!.status).toBe('missed');
  });
});
