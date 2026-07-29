import { describe, it, expect, afterAll } from 'vitest';
import { diffMeetingFields, type NormalizedMeeting } from '../src/calendar.js';
import {
  closeDb, insertMeeting, getMeeting, getScheduledEventIds, updateMeeting,
} from '../src/db.js';
import type { Meeting } from '../src/db.js';

// CA2: calendar events were inserted once and NEVER updated — a rescheduled meeting kept its
// stale start_time (MiBot joins at the wrong time / not at all) and a cancelled meeting was
// still joined. Fix: reconcile changed fields on re-sync, and mark rows whose event id has
// left the sync window as cancelled.

function meeting(over: Partial<Meeting>): Meeting {
  return {
    id: 1, title: 'Sync', platform: 'zoom', join_url: 'https://zoom.us/j/1',
    start_time: '2026-07-29T10:00:00Z', end_time: '2026-07-29T10:30:00Z',
    actual_start: null, actual_end: null, calendar_event_id: 'm365:1',
    organizer: null, organizer_email: null, location: null, description: null,
    attendees: null, is_recurring: 0, recurrence_id: null, participants: null,
    speaker_timeline: null, heartbeat: null, status: 'scheduled', created_at: '',
    ...over,
  };
}
function incoming(over: Partial<NormalizedMeeting>): NormalizedMeeting {
  return {
    title: 'Sync', platform: 'zoom', join_url: 'https://zoom.us/j/1',
    start_time: '2026-07-29T10:00:00Z', end_time: '2026-07-29T10:30:00Z',
    calendar_event_id: 'm365:1', ...over,
  };
}

describe('diffMeetingFields (CA2 reschedule detection)', () => {
  it('returns null when nothing joinable changed', () => {
    expect(diffMeetingFields(meeting({}), incoming({}))).toBeNull();
  });

  it('detects a changed start_time', () => {
    const d = diffMeetingFields(meeting({}), incoming({ start_time: '2026-07-29T11:00:00Z' }));
    expect(d).toEqual({ start_time: '2026-07-29T11:00:00Z' });
  });

  it('detects changed join_url, end_time and title together', () => {
    const d = diffMeetingFields(
      meeting({}),
      incoming({ join_url: 'https://zoom.us/j/2', end_time: '2026-07-29T11:00:00Z', title: 'Renamed' }),
    );
    expect(d).toEqual({ join_url: 'https://zoom.us/j/2', end_time: '2026-07-29T11:00:00Z', title: 'Renamed' });
  });

  it('does NOT reschedule a meeting that already left scheduled state', () => {
    expect(diffMeetingFields(meeting({ status: 'in_call' }), incoming({ start_time: '2026-07-29T12:00:00Z' }))).toBeNull();
  });
});

describe('getScheduledEventIds (CA2 cancellation source)', () => {
  afterAll(() => closeDb());

  it('lists scheduled event ids for one provider prefix only', () => {
    const tag = `ca2-${Date.now()}`;
    const a = insertMeeting({ title: 'a', platform: 'zoom', join_url: `https://zoom.us/j/${tag}a`, start_time: '2026-07-29T10:00:00Z', calendar_event_id: `m365:${tag}a` });
    insertMeeting({ title: 'b', platform: 'zoom', join_url: `https://zoom.us/j/${tag}b`, start_time: '2026-07-29T10:00:00Z', calendar_event_id: `gcal:${tag}b` });
    const ids = getScheduledEventIds('m365:');
    expect(ids).toContain(`m365:${tag}a`);
    expect(ids).not.toContain(`gcal:${tag}b`);
    // a done meeting is not a cancellation candidate
    updateMeeting(a.id, { status: 'done' });
    expect(getScheduledEventIds('m365:')).not.toContain(`m365:${tag}a`);
  });
});
