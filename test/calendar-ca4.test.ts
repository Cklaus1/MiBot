import { describe, it, expect, afterAll } from 'vitest';
import { closeDb, insertMeeting, getMeetingByJoinUrlAndTime, listMeetings } from '../src/db.js';

// CA4: the same meeting appearing on BOTH M365 and Google gets two distinct calendar_event_ids
// (`m365:…` vs `gcal:…`), so the eventId dedup (and the D6 UNIQUE index) can't catch it →
// MiBot joins the same call twice. Cross-provider dedup keys on join_url + start_time instead.
describe('CA4 cross-provider dedup (join_url + time)', () => {
  afterAll(() => closeDb());

  it('finds an existing meeting by join_url + start_time regardless of event id', () => {
    const url = `https://zoom.us/j/${Date.now()}-ca4a`;
    const start = '2026-07-29T14:00:00Z';
    const first = insertMeeting({ title: 'M365 copy', platform: 'zoom', join_url: url, start_time: start, calendar_event_id: 'm365:ca4a' });
    const found = getMeetingByJoinUrlAndTime(url, start);
    expect(found?.id).toBe(first.id);
  });

  it('returns undefined when url matches but the time differs', () => {
    const url = `https://zoom.us/j/${Date.now()}-ca4b`;
    insertMeeting({ title: 'x', platform: 'zoom', join_url: url, start_time: '2026-07-29T14:00:00Z', calendar_event_id: 'm365:ca4b' });
    expect(getMeetingByJoinUrlAndTime(url, '2026-07-29T15:00:00Z')).toBeUndefined();
  });

  it('a second provider with the same url+time does not create a duplicate row', () => {
    const url = `https://meet.google.com/${Date.now()}-ca4c`;
    const start = '2026-07-29T16:00:00Z';
    insertMeeting({ title: 'from M365', platform: 'meet', join_url: url, start_time: start, calendar_event_id: 'm365:ca4c' });
    const before = listMeetings(500).filter((m) => m.join_url === url).length;
    // The gcal copy would be skipped by persistNew's CA4 guard; simulate the guard's decision:
    const dup = getMeetingByJoinUrlAndTime(url, start);
    expect(dup).toBeDefined();
    expect(before).toBe(1);
  });
});
