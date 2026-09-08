import { describe, it, expect } from 'vitest';
import { m365ToRaw, googleToRaw, normalizeEvents } from '../src/calendar.js';

// CA9 at the ingest boundary: m365ToRaw must carry start.timeZone through, not discard it.

function m365Event(over: Record<string, any> = {}) {
  return {
    id: 'evt-1',
    subject: 'Standup',
    start: { dateTime: '2026-01-15T09:00:00.0000000', timeZone: 'Pacific Standard Time' },
    end: { dateTime: '2026-01-15T09:30:00.0000000', timeZone: 'Pacific Standard Time' },
    onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/abc' },
    ...over,
  };
}

describe('CA9 — m365ToRaw resolves {dateTime,timeZone} to a UTC instant', () => {
  it('converts a bare PST wall clock to UTC (was stored 8h wrong)', () => {
    const raw = m365ToRaw(m365Event());
    expect(raw.start_time).toBe('2026-01-15T17:00:00.000Z');
    expect(raw.end_time).toBe('2026-01-15T17:30:00.000Z');
  });

  it('is DST-correct — July PDT is UTC-7, not UTC-8', () => {
    const raw = m365ToRaw(m365Event({
      start: { dateTime: '2026-07-15T09:00:00.0000000', timeZone: 'Pacific Standard Time' },
      end: { dateTime: '2026-07-15T09:30:00.0000000', timeZone: 'Pacific Standard Time' },
    }));
    expect(raw.start_time).toBe('2026-07-15T16:00:00.000Z');
    expect(raw.end_time).toBe('2026-07-15T16:30:00.000Z');
  });

  it('a UTC mailbox is unaffected (prior behaviour preserved)', () => {
    const raw = m365ToRaw(m365Event({
      start: { dateTime: '2026-01-15T09:00:00.0000000', timeZone: 'UTC' },
      end: { dateTime: '2026-01-15T09:30:00.0000000', timeZone: 'UTC' },
    }));
    expect(raw.start_time).toBe('2026-01-15T09:00:00.000Z');
  });

  it('a missing timeZone still yields UTC rather than dropping the event', () => {
    const raw = m365ToRaw(m365Event({ start: { dateTime: '2026-01-15T09:00:00' }, end: undefined }));
    expect(raw.start_time).toBe('2026-01-15T09:00:00.000Z');
    expect(raw.end_time).toBeUndefined();
  });

  it('CA8 still holds: no dateTime → undefined start (never a fabricated now())', () => {
    const raw = m365ToRaw(m365Event({ start: { timeZone: 'Pacific Standard Time' } }));
    expect(raw.start_time).toBeUndefined();
  });

  it('an unparseable dateTime yields undefined so the normalizer drops the event', () => {
    const raw = m365ToRaw(m365Event({ start: { dateTime: 'garbage', timeZone: 'UTC' } }));
    expect(raw.start_time).toBeUndefined();
    expect(normalizeEvents([raw])).toHaveLength(0);
  });
});

describe('CA9 — googleToRaw normalizes its offset-bearing times to the same convention', () => {
  it('converts a +offset instant to UTC without re-interpreting it', () => {
    const raw = googleToRaw({
      id: 'g1',
      summary: 'Sync',
      hangoutLink: 'https://meet.google.com/abc-defg-hij',
      start: { dateTime: '2026-01-15T09:00:00-08:00' },
      end: { dateTime: '2026-01-15T09:30:00-08:00' },
    });
    expect(raw.start_time).toBe('2026-01-15T17:00:00.000Z');
    expect(raw.end_time).toBe('2026-01-15T17:30:00.000Z');
  });

  it('all-day events (date only, no dateTime) are still dropped (CA8)', () => {
    const raw = googleToRaw({
      id: 'g2', summary: 'Holiday',
      hangoutLink: 'https://meet.google.com/abc-defg-hij',
      start: { date: '2026-01-15' }, end: { date: '2026-01-16' },
    });
    expect(raw.start_time).toBeUndefined();
  });
});

describe('CA9 — cross-provider dedup now compares like with like', () => {
  it('the same call from both providers normalizes to one identical instant', () => {
    const m365 = m365ToRaw(m365Event({
      onlineMeeting: { joinUrl: 'https://meet.google.com/abc-defg-hij' },
    }));
    const google = googleToRaw({
      id: 'g3', summary: 'Standup',
      hangoutLink: 'https://meet.google.com/abc-defg-hij',
      start: { dateTime: '2026-01-15T09:00:00-08:00' },
    });
    expect(m365.start_time).toBe(google.start_time);
    // normalizeEvents dedups on `${url} ${start_time}` — identical strings collapse to one row.
    expect(normalizeEvents([m365, google])).toHaveLength(1);
  });
});
