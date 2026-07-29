import { describe, it, expect, afterAll } from 'vitest';
import { getDb, closeDb, insertMeeting, getOrCreateMeeting, listMeetings } from '../src/db.js';

// C19 P1: the scheduler inserts a `scheduled` row for a calendar event, then joinAndRecord
// used to blindly insertMeeting() again — a fresh duplicate row on every (re)join attempt,
// so a flaky join that retried produced N rows for one meeting. getOrCreateMeeting reuses
// the existing row keyed by calendar_event_id; only a truly new event (or a manual join with
// no event id) inserts.
describe('getOrCreateMeeting (C19 dup-row rejoin)', () => {
  afterAll(() => closeDb());

  const evt = () => `evt-${Math.floor(performance.now() * 1000)}-${Math.round(performance.now())}`;

  it('reuses an existing row with the same calendar_event_id', () => {
    getDb();
    const id = evt();
    const first = insertMeeting({
      title: 'Standup', platform: 'teams', join_url: 'https://teams/x',
      start_time: new Date().toISOString(), calendar_event_id: id,
    });
    const again = getOrCreateMeeting({
      title: 'Standup', platform: 'teams', join_url: 'https://teams/x',
      start_time: new Date().toISOString(), calendar_event_id: id,
    });
    expect(again.id).toBe(first.id);
  });

  it('does not create a second row on rejoin', () => {
    getDb();
    const id = evt();
    getOrCreateMeeting({
      title: 'Sync', platform: 'zoom', join_url: 'https://zoom/y',
      start_time: new Date().toISOString(), calendar_event_id: id,
    });
    getOrCreateMeeting({
      title: 'Sync', platform: 'zoom', join_url: 'https://zoom/y',
      start_time: new Date().toISOString(), calendar_event_id: id,
    });
    const rows = listMeetings(200).filter((m) => m.calendar_event_id === id);
    expect(rows).toHaveLength(1);
  });

  it('inserts a new row when calendar_event_id is absent (manual join)', () => {
    getDb();
    const a = getOrCreateMeeting({
      title: 'Manual A', platform: 'meet', join_url: 'https://meet/a',
      start_time: new Date().toISOString(),
    });
    const b = getOrCreateMeeting({
      title: 'Manual B', platform: 'meet', join_url: 'https://meet/b',
      start_time: new Date().toISOString(),
    });
    expect(b.id).not.toBe(a.id);
  });

  it('inserts when the event id has never been seen', () => {
    getDb();
    const id = evt();
    const before = listMeetings(1000).filter((m) => m.calendar_event_id === id);
    expect(before).toHaveLength(0);
    const created = getOrCreateMeeting({
      title: 'New', platform: 'teams', join_url: 'https://teams/new',
      start_time: new Date().toISOString(), calendar_event_id: id,
    });
    const after = listMeetings(1000).filter((m) => m.calendar_event_id === id);
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(created.id);
  });
});
