import { describe, it, expect, afterAll } from 'vitest';
import { getDb, closeDb, insertMeeting, getMeetingByEventId, listMeetings } from '../src/db.js';

// CA3 P2: getOrCreateMeeting checks-then-inserts, so two pollers can both pass the check
// and race to insert the same calendar_event_id. Before D6's unique index that produced a
// duplicate row; with the index a naive insert would THROW a constraint error and crash the
// poll. insertMeeting now uses INSERT … ON CONFLICT DO NOTHING and reads back the winner's
// row, so the losing insert is a harmless no-op returning the same meeting.
describe('insertMeeting race dedup (CA3 ON CONFLICT DO NOTHING)', () => {
  afterAll(() => closeDb());

  const evt = () => `race-${Math.round(performance.now() * 1000)}`;

  it('does not throw when the same calendar_event_id is inserted twice', () => {
    getDb();
    const id = evt();
    const first = insertMeeting({
      title: 'Race', platform: 'teams', join_url: 'https://x',
      start_time: new Date().toISOString(), calendar_event_id: id,
    });
    // Simulate the racing second insert that slipped past the get-or-create check.
    expect(() =>
      insertMeeting({
        title: 'Race', platform: 'teams', join_url: 'https://x',
        start_time: new Date().toISOString(), calendar_event_id: id,
      }),
    ).not.toThrow();
    // And it returns the already-existing row, not a fresh one.
    expect(getMeetingByEventId(id)!.id).toBe(first.id);
  });

  it('leaves exactly one row after a raced double insert', () => {
    getDb();
    const id = evt();
    insertMeeting({ title: 'R', platform: 'zoom', join_url: 'https://y', start_time: 't', calendar_event_id: id });
    insertMeeting({ title: 'R', platform: 'zoom', join_url: 'https://y', start_time: 't', calendar_event_id: id });
    expect(listMeetings(500).filter((m) => m.calendar_event_id === id)).toHaveLength(1);
  });

  it('the losing insert returns the winner row (same id)', () => {
    getDb();
    const id = evt();
    const a = insertMeeting({ title: 'W', platform: 'meet', join_url: 'https://z', start_time: 't', calendar_event_id: id });
    const b = insertMeeting({ title: 'W', platform: 'meet', join_url: 'https://z', start_time: 't', calendar_event_id: id });
    expect(b.id).toBe(a.id);
  });
});
