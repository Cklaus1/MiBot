import { describe, it, expect } from 'vitest';
import { detectPlatform } from '../src/bot.js';

describe('detectPlatform', () => {
  it('detects Zoom URLs', () => {
    expect(detectPlatform('https://zoom.us/j/98396546217?pwd=abc')).toBe('zoom');
    expect(detectPlatform('https://us04web.zoom.us/j/123456')).toBe('zoom');
  });

  it('detects Teams URLs', () => {
    expect(detectPlatform('https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc')).toBe('teams');
    expect(detectPlatform('https://teams.live.com/meet/123')).toBe('teams');
  });

  it('detects Google Meet URLs', () => {
    expect(detectPlatform('https://meet.google.com/abc-defg-hij')).toBe('meet');
  });

  it('returns null for unsupported URLs', () => {
    expect(detectPlatform('https://example.com')).toBeNull();
    expect(detectPlatform('https://webex.com/meet/123')).toBeNull();
  });

  it('is case-insensitive', () => {
    expect(detectPlatform('https://ZOOM.US/j/123')).toBe('zoom');
    expect(detectPlatform('https://TEAMS.MICROSOFT.COM/l/meetup')).toBe('teams');
  });
});
