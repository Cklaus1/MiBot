import { describe, it, expect, afterAll, vi, beforeEach, afterEach } from 'vitest';
import { closeDb, getMeetingByEventId, getDb } from '../src/db.js';
import { reconcileProvider, type NormalizedMeeting } from '../src/calendar.js';

// Fix 3 (P1): the CA2 cancellation step marks any scheduled row whose event id is missing from
// a sync as 'cancelled' — terminal — and diffMeetingFields ignores non-scheduled rows. So an
// event that was only TEMPORARILY absent (moved beyond the 24h window, or pushed onto an unread
// page of results) was cancelled for good and never joined when it came back. A reappearing id
// is proof the event still exists: revive it.

let spy: ReturnType<typeof vi.spyOn>;
beforeEach(() => { spy = vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => spy.mockRestore());
afterAll(() => closeDb());

const ev = (id: string, start: string, over: Partial<NormalizedMeeting> = {}): NormalizedMeeting => ({
  title: 'Standup', platform: 'zoom', join_url: `https://zoom.us/j/${id}`,
  start_time: start, end_time: undefined, calendar_event_id: id, ...over,
} as NormalizedMeeting);

describe('reviving a cancelled meeting whose event reappears (fix 3)', () => {
  it('temporary absence → cancelled → back in the window → scheduled again', () => {
    const id = `m365:rv-${Date.now()}`;
    reconcileProvider('m365:', [ev(id, '2026-10-01T15:00:00.000Z')], '');
    expect(getMeetingByEventId(id)!.status).toBe('scheduled');

    reconcileProvider('m365:', [], ''); // moved out of the window / on an unread page
    expect(getMeetingByEventId(id)!.status).toBe('cancelled');

    reconcileProvider('m365:', [ev(id, '2026-10-02T10:00:00.000Z')], '');
    const back = getMeetingByEventId(id)!;
    expect(back.status).toBe('scheduled');
    expect(new Date(back.start_time).toISOString()).toBe('2026-10-02T10:00:00.000Z'); // new time applied
  });

  it('applies changed title/url on revive', () => {
    const id = `m365:rv2-${Date.now()}`;
    reconcileProvider('m365:', [ev(id, '2026-10-01T15:00:00.000Z')], '');
    reconcileProvider('m365:', [], '');
    reconcileProvider('m365:', [ev(id, '2026-10-01T15:00:00.000Z', { title: 'Renamed', join_url: 'https://zoom.us/j/new' })], '');
    const m = getMeetingByEventId(id)!;
    expect(m.title).toBe('Renamed');
    expect(m.join_url).toBe('https://zoom.us/j/new');
  });

  it('never revives a meeting that finished, failed, or was missed', () => {
    for (const terminal of ['done', 'failed', 'missed']) {
      const id = `m365:rv-${terminal}-${Date.now()}`;
      reconcileProvider('m365:', [ev(id, '2026-10-01T15:00:00.000Z')], '');
      getDb().prepare('UPDATE meetings SET status = ? WHERE calendar_event_id = ?').run(terminal, id);
      reconcileProvider('m365:', [ev(id, '2026-10-01T15:00:00.000Z')], '');
      expect(getMeetingByEventId(id)!.status).toBe(terminal);
    }
  });

  it('a genuinely deleted event stays cancelled', () => {
    const id = `m365:rv-del-${Date.now()}`;
    reconcileProvider('m365:', [ev(id, '2026-10-01T15:00:00.000Z')], '');
    reconcileProvider('m365:', [], '');
    reconcileProvider('m365:', [], '');
    expect(getMeetingByEventId(id)!.status).toBe('cancelled');
  });
});
