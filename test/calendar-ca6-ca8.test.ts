import { describe, it, expect } from 'vitest';
import { m365ToRaw, googleToRaw, normalizeEvents, extractMeetingUrl } from '../src/calendar.js';

// CA6: an HTML body stores the URL with escaped ampersands (`&amp;`); the URL charset captured
// them literally, so the stored join_url contained `&amp;` and the join failed. Fix: HTML-entity
// -decode the body candidate before URL extraction.
describe('CA6 HTML-entity decode in body URLs', () => {
  it('decodes &amp; in a body-sourced meeting URL', () => {
    const raw = m365ToRaw({
      id: '1',
      subject: 'Sync',
      body: { content: '<a href="https://zoom.us/j/123?pwd=a&amp;role=1">join</a>' },
      start: { dateTime: '2026-07-29T10:00:00Z' },
    });
    expect(extractMeetingUrl(raw.urlCandidates)).toBe('https://zoom.us/j/123?pwd=a&role=1');
  });

  it('decodes numeric and named entities in a Google description URL', () => {
    const raw = googleToRaw({
      id: '2',
      summary: 'Sync',
      description: 'Join https://zoom.us/j/9?a=1&#38;b=2&amp;c=3',
      start: { dateTime: '2026-07-29T10:00:00Z' },
    });
    expect(extractMeetingUrl(raw.urlCandidates)).toBe('https://zoom.us/j/9?a=1&b=2&c=3');
  });
});

// CA8: a Google all-day event exposes start.date (YYYY-MM-DD), no start.dateTime. The old code
// read that (or fell back to now.toISOString()) → a midnight/immediate join for an all-day
// event. Fix: events without a real dateTime are skipped during normalization.
describe('CA8 skip all-day events (no dateTime)', () => {
  it('googleToRaw leaves start_time empty for an all-day event', () => {
    const raw = googleToRaw({
      id: '3',
      summary: 'Company Holiday',
      hangoutLink: 'https://meet.google.com/xyz',
      start: { date: '2026-07-29' },
      end: { date: '2026-07-30' },
    });
    expect(raw.start_time).toBeUndefined();
  });

  it('normalizeEvents drops an event with no start_time even if it has a join URL', () => {
    const out = normalizeEvents([{
      calendar_event_id: 'gcal:3',
      title: 'Holiday',
      urlCandidates: ['https://meet.google.com/xyz'],
      start_time: undefined as unknown as string,
    }]);
    expect(out).toHaveLength(0);
  });

  it('a timed event alongside an all-day event still comes through', () => {
    const allDay = googleToRaw({ id: 'a', summary: 'Holiday', hangoutLink: 'https://meet.google.com/aaa', start: { date: '2026-07-29' } });
    const timed = googleToRaw({ id: 'b', summary: 'Standup', hangoutLink: 'https://meet.google.com/bbb', start: { dateTime: '2026-07-29T10:00:00Z' } });
    const out = normalizeEvents([allDay, timed]);
    expect(out).toHaveLength(1);
    expect(out[0].calendar_event_id).toBe('gcal:b');
  });
});
