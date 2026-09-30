import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { toUtcIso, windowsToIana, __resetZoneWarningsForTest } from '../src/tz.js';

// Fix 4 (P1): CA9's table held 44 hand-picked zones; any other Windows zone silently fell back
// to UTC, so e.g. a Brisbane mailbox's meetings landed 10h off and were swept to 'missed' — the
// very bug CA9 fixed. The table is now the full CLDR mapping, and an unresolvable zone warns.

let spy: ReturnType<typeof vi.spyOn>;
beforeEach(() => { __resetZoneWarningsForTest(); spy = vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => spy.mockRestore());

const T = '2026-01-15T09:00:00.0000000';

describe('previously unmapped zones now convert (fix 4)', () => {
  const cases: [string, string][] = [
    ['E. Australia Standard Time', '2026-01-14T23:00:00.000Z'],   // Brisbane UTC+10, no DST
    ['SE Asia Standard Time', '2026-01-15T02:00:00.000Z'],        // Bangkok UTC+7
    ['Arab Standard Time', '2026-01-15T06:00:00.000Z'],           // Riyadh UTC+3
    ['Pakistan Standard Time', '2026-01-15T04:00:00.000Z'],       // Karachi UTC+5
    ['Iran Standard Time', '2026-01-15T05:30:00.000Z'],           // Tehran UTC+3:30 (half hour)
    ['Nepal Standard Time', '2026-01-15T03:15:00.000Z'],          // Kathmandu UTC+5:45 (quarter)
    ['Cen. Australia Standard Time', '2026-01-14T22:30:00.000Z'], // Adelaide UTC+10:30 (summer DST)
    ['Pacific SA Standard Time', '2026-01-15T12:00:00.000Z'],     // Santiago UTC-3 (summer DST)
  ];
  for (const [zone, want] of cases) {
    it(`${zone} → ${want}`, () => expect(toUtcIso(T, zone)).toBe(want));
  }

  it('none of those logged an unknown-zone warning', () => {
    for (const [zone] of cases) toUtcIso(T, zone);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('the table itself', () => {
  it('maps Graph\'s tzone://Microsoft/Utc to UTC', () => {
    expect(toUtcIso(T, 'tzone://Microsoft/Utc')).toBe('2026-01-15T09:00:00.000Z');
    expect(spy).not.toHaveBeenCalled();
  });

  it('every mapped IANA zone is one this runtime accepts', () => {
    // Spot-check the breadth through the public API: a bad entry would throw inside Intl.
    for (const name of ['Dateline Standard Time', 'UTC-11', 'Aleutian Standard Time', 'Tonga Standard Time',
      'Line Islands Standard Time', 'Chatham Islands Standard Time', 'Myanmar Standard Time']) {
      const zone = windowsToIana(name);
      expect(zone, name).toBeTruthy();
      expect(() => new Intl.DateTimeFormat('en', { timeZone: zone })).not.toThrow();
    }
  });
});

describe('an unresolvable zone is loud, not silent (fix 4)', () => {
  it('warns, naming the zone, and still falls back to UTC', () => {
    expect(toUtcIso(T, 'tzone://Microsoft/Custom')).toBe('2026-01-15T09:00:00.000Z');
    const msg = spy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(msg).toContain('tzone://Microsoft/Custom');
  });

  it('warns once per zone, not on every poll', () => {
    for (let i = 0; i < 5; i++) toUtcIso(T, 'Atlantis Standard Time');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('no zone at all is not a warning (a UTC-returning mailbox is normal)', () => {
    toUtcIso(T, undefined);
    toUtcIso(T, '');
    expect(spy).not.toHaveBeenCalled();
  });
});
