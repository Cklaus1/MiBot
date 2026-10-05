import { describe, it, expect, afterEach, vi } from 'vitest';
import { reloadConfig, fmtTime, loadConfig } from '../src/config.js';

// Wave 9-F: MIBOT_TIMEZONE was applied without the isValidTimezone check the file config gets.
// fmtTime then threw RangeError — and persistNew calls it right after insertMeeting, so the throw
// ended each provider's sync after ONE new meeting and skipped the cancellation step; `mibot
// meetings`/`show` crashed too.
const saved = process.env.MIBOT_TIMEZONE;
afterEach(() => {
  if (saved === undefined) delete process.env.MIBOT_TIMEZONE; else process.env.MIBOT_TIMEZONE = saved;
  reloadConfig();
  vi.restoreAllMocks();
});

describe('MIBOT_TIMEZONE validation (Wave 9-F)', () => {
  it('a valid zone is applied', () => {
    process.env.MIBOT_TIMEZONE = 'America/Chicago';
    expect(reloadConfig().timezone).toBe('America/Chicago');
  });

  it('an invalid zone is ignored with a warning, not applied', () => {
    const before = (() => { delete process.env.MIBOT_TIMEZONE; return reloadConfig().timezone; })();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.MIBOT_TIMEZONE = 'Mars/Olympus_Mons';
    expect(reloadConfig().timezone).toBe(before);
    expect(spy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('Mars/Olympus_Mons');
  });

  it('fmtTime never throws, whatever the configured zone (a display helper must not abort a sync)', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.MIBOT_TIMEZONE = 'Mars/Olympus_Mons';
    reloadConfig();
    (loadConfig() as any).timezone = 'Not/AZone'; // even if something slips past validation
    expect(() => fmtTime('2026-10-05T15:00:00.000Z')).not.toThrow();
    expect(fmtTime('2026-10-05T15:00:00.000Z')).toMatch(/Oct/);
  });
});
