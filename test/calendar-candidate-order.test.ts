import { describe, it, expect } from 'vitest';
import { m365ToRaw, googleToRaw, extractMeetingUrl } from '../src/calendar.js';

// CA5: the M365 candidate order was location, BODY, then onlineMeeting.joinUrl — so a stale
// meeting link quoted in the body ("last week we met at https://…") won over the authoritative
// joinUrl. Fix: the authoritative joinUrl must beat the body. Location (the organizer's chosen
// platform, e.g. a Meet link) still wins over an auto-generated Teams joinUrl.
describe('CA5 M365 candidate precedence', () => {
  it('authoritative onlineMeeting.joinUrl beats a stale link quoted in the body', () => {
    const raw = m365ToRaw({
      id: '1',
      subject: 'Sync',
      body: { content: 'Recap of https://zoom.us/j/OLD-stale-link from last week' },
      onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/AUTHORITATIVE' },
      start: { dateTime: '2026-07-29T10:00:00Z' },
    });
    expect(extractMeetingUrl(raw.urlCandidates)).toBe('https://teams.microsoft.com/l/meetup-join/AUTHORITATIVE');
  });

  it('a Meet link in location still wins over an auto-generated Teams joinUrl', () => {
    const raw = m365ToRaw({
      id: '2',
      subject: 'Sync',
      location: { displayName: 'https://meet.google.com/abc-defg-hij' },
      onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/AUTO' },
      body: { content: '' },
      start: { dateTime: '2026-07-29T10:00:00Z' },
    });
    expect(extractMeetingUrl(raw.urlCandidates)).toBe('https://meet.google.com/abc-defg-hij');
  });
});

describe('CA5 Google candidate precedence', () => {
  it('hangoutLink wins over a stale link in the description', () => {
    const raw = googleToRaw({
      id: '3',
      summary: 'Sync',
      hangoutLink: 'https://meet.google.com/live-link',
      description: 'previously https://meet.google.com/OLD-link',
      start: { dateTime: '2026-07-29T10:00:00Z' },
    });
    expect(extractMeetingUrl(raw.urlCandidates)).toBe('https://meet.google.com/live-link');
  });
});
