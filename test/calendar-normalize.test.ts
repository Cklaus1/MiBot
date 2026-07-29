import { describe, it, expect } from 'vitest';
import { extractMeetingUrl, normalizeEvents, type RawCalendarEvent } from '../src/calendar.js';

// AR7: M365 and Google each mapped their native event to a provider-neutral RawCalendarEvent;
// ONE normalizer (URL extraction + platform detection + in-batch dedup by join_url+time) runs
// once instead of the two divergent per-provider loops. These are the pure, DB-free cores that
// the CA-cluster fixes (CA4/CA5/CA6/CA8) hang off of, so they're unit-testable without CLIs.
describe('extractMeetingUrl (AR7 single extractor)', () => {
  it('returns the first matching meeting URL across ordered candidates', () => {
    const url = extractMeetingUrl(['no link here', 'join https://zoom.us/j/123 now']);
    expect(url).toBe('https://zoom.us/j/123');
  });

  it('honors candidate order — earlier field wins over later', () => {
    const url = extractMeetingUrl([
      'https://meet.google.com/abc-defg-hij',
      'https://teams.microsoft.com/l/meetup-join/xyz',
    ]);
    expect(url).toBe('https://meet.google.com/abc-defg-hij');
  });

  it('returns null when no candidate holds a known-platform URL', () => {
    expect(extractMeetingUrl(['https://example.com/foo', 'plain text'])).toBeNull();
  });

  it('stops the URL at whitespace / closing punctuation', () => {
    const url = extractMeetingUrl(['see <https://zoom.us/j/999> for details']);
    expect(url).toBe('https://zoom.us/j/999');
  });
});

describe('normalizeEvents (AR7 seam)', () => {
  const base: RawCalendarEvent = {
    calendar_event_id: 'm365:1',
    title: 'Standup',
    urlCandidates: ['https://zoom.us/j/555'],
    start_time: '2026-07-29T10:00:00Z',
  };

  it('maps a raw event to a normalized meeting with detected platform', () => {
    const out = normalizeEvents([base]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      calendar_event_id: 'm365:1',
      title: 'Standup',
      platform: 'zoom',
      join_url: 'https://zoom.us/j/555',
      start_time: '2026-07-29T10:00:00Z',
    });
  });

  it('drops events whose candidates yield no known-platform URL', () => {
    const out = normalizeEvents([{ ...base, urlCandidates: ['https://example.com/x'] }]);
    expect(out).toHaveLength(0);
  });

  it('dedups across providers by join_url + start_time (cross-provider seam)', () => {
    const gcal: RawCalendarEvent = {
      ...base,
      calendar_event_id: 'gcal:2',
      urlCandidates: ['https://zoom.us/j/555'],
    };
    const out = normalizeEvents([base, gcal]);
    expect(out).toHaveLength(1);
    // First occurrence wins.
    expect(out[0].calendar_event_id).toBe('m365:1');
  });

  it('keeps same URL at different times as distinct meetings', () => {
    const later: RawCalendarEvent = { ...base, calendar_event_id: 'm365:3', start_time: '2026-07-29T11:00:00Z' };
    const out = normalizeEvents([base, later]);
    expect(out).toHaveLength(2);
  });

  it('strips HTML from description and truncates to 2000 chars', () => {
    const long = '<p>' + 'x'.repeat(5000) + '</p>';
    const out = normalizeEvents([{ ...base, description: long }]);
    expect(out[0].description!.length).toBe(2000);
    expect(out[0].description).not.toContain('<');
  });
});
