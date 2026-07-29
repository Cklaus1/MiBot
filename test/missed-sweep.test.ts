import { describe, it, expect, afterAll } from 'vitest';
import { getDb, closeDb, insertMeeting, getMeeting, sweepMissedMeetings } from '../src/db.js';

// D7 P3: getUpcomingMeetings has a `start_time >= now-30min` lower bound, so a meeting whose
// window passed while the watcher was down stays `scheduled` forever — never joined, never
// pruned, growing the table. sweepMissedMeetings marks overdue scheduled rows `missed`.
describe('sweepMissedMeetings (D7)', () => {
  afterAll(() => closeDb());

  const mk = (startTime: string) => {
    getDb();
    return insertMeeting({
      title: 'sweep', platform: 'teams',
      join_url: 'https://teams.microsoft.com/x', start_time: startTime,
    });
  };

  it('marks a long-overdue scheduled meeting as missed', () => {
    const m = mk('2000-01-01T00:00:00.000Z');
    const swept = sweepMissedMeetings();
    expect(swept).toBeGreaterThanOrEqual(1);
    expect(getMeeting(m.id)!.status).toBe('missed');
  });

  it('leaves a future scheduled meeting untouched', () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const m = mk(future);
    sweepMissedMeetings();
    expect(getMeeting(m.id)!.status).toBe('scheduled');
  });

  it('leaves a just-recently-started scheduled meeting inside the grace window', () => {
    const recent = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5 min ago
    const m = mk(recent);
    sweepMissedMeetings();
    expect(getMeeting(m.id)!.status).toBe('scheduled');
  });

  it('does not touch non-scheduled meetings', () => {
    const m = mk('2000-01-01T00:00:00.000Z');
    getDb().prepare("UPDATE meetings SET status = 'done' WHERE id = ?").run(m.id);
    sweepMissedMeetings();
    expect(getMeeting(m.id)!.status).toBe('done');
  });
});
