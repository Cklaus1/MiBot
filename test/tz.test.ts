import { describe, it, expect } from 'vitest';
import { windowsToIana, resolveZone, toUtcIso, hasExplicitOffset } from '../src/tz.js';

// CA9: Microsoft Graph returns `start.dateTime` as a BARE wall-clock string (no Z, no offset)
// paired with a sibling `start.timeZone` naming the zone it is expressed in. m365ToRaw stored
// the bare string and discarded the zone, while fmtTime appended 'Z' and every SQL comparison
// used datetime('now') (UTC) — so for any non-UTC mailbox the join time was wrong by the UTC
// offset, and sweepMissedMeetings silently retired the meeting to `missed`.

describe('hasExplicitOffset', () => {
  it('recognizes Z, +HH:MM, -HHMM', () => {
    expect(hasExplicitOffset('2026-09-07T14:00:00Z')).toBe(true);
    expect(hasExplicitOffset('2026-09-07T14:00:00+02:00')).toBe(true);
    expect(hasExplicitOffset('2026-09-07T14:00:00-0800')).toBe(true);
  });
  it('rejects a bare Graph datetime', () => {
    expect(hasExplicitOffset('2026-09-07T14:00:00.0000000')).toBe(false);
    expect(hasExplicitOffset('2026-09-07T14:00:00')).toBe(false);
  });
});

describe('windowsToIana', () => {
  it('maps common Windows zone names Graph emits', () => {
    expect(windowsToIana('Pacific Standard Time')).toBe('America/Los_Angeles');
    expect(windowsToIana('Eastern Standard Time')).toBe('America/New_York');
    expect(windowsToIana('UTC')).toBe('UTC');
    expect(windowsToIana('W. Europe Standard Time')).toBe('Europe/Berlin');
  });
  it('is case/space tolerant', () => {
    expect(windowsToIana('pacific standard time')).toBe('America/Los_Angeles');
  });
  it('returns undefined for an unknown name', () => {
    expect(windowsToIana('Nowhere Standard Time')).toBeUndefined();
  });
});

describe('resolveZone', () => {
  it('passes an IANA zone straight through', () => {
    expect(resolveZone('America/Chicago')).toBe('America/Chicago');
  });
  it('translates a Windows zone', () => {
    expect(resolveZone('Pacific Standard Time')).toBe('America/Los_Angeles');
  });
  it('returns undefined for junk rather than guessing', () => {
    expect(resolveZone('Not/AZone')).toBeUndefined();
    expect(resolveZone('')).toBeUndefined();
    expect(resolveZone(undefined)).toBeUndefined();
  });
});

describe('toUtcIso (the CA9 fix)', () => {
  it('converts a bare PST wall clock to the correct UTC instant', () => {
    // 2026-01-15 09:00 in America/Los_Angeles is PST (UTC-8) → 17:00Z
    expect(toUtcIso('2026-01-15T09:00:00', 'Pacific Standard Time')).toBe('2026-01-15T17:00:00.000Z');
  });

  it('honours DST — the same zone in July is UTC-7', () => {
    // 2026-07-15 09:00 in America/Los_Angeles is PDT (UTC-7) → 16:00Z
    expect(toUtcIso('2026-07-15T09:00:00', 'Pacific Standard Time')).toBe('2026-07-15T16:00:00.000Z');
  });

  it('strips Graph 7-digit fractional seconds', () => {
    expect(toUtcIso('2026-01-15T09:00:00.0000000', 'Pacific Standard Time')).toBe('2026-01-15T17:00:00.000Z');
  });

  it('handles a positive offset zone', () => {
    // 2026-01-15 09:00 Europe/Berlin is CET (UTC+1) → 08:00Z
    expect(toUtcIso('2026-01-15T09:00:00', 'W. Europe Standard Time')).toBe('2026-01-15T08:00:00.000Z');
  });

  it('leaves an already-offset-bearing timestamp as a normalized instant', () => {
    // Google's shape: never re-interpret it against the zone field.
    expect(toUtcIso('2026-01-15T09:00:00-08:00', 'Pacific Standard Time')).toBe('2026-01-15T17:00:00.000Z');
    expect(toUtcIso('2026-01-15T17:00:00Z', undefined)).toBe('2026-01-15T17:00:00.000Z');
  });

  it('treats a bare datetime with NO zone as UTC (prior behaviour preserved)', () => {
    expect(toUtcIso('2026-01-15T09:00:00', undefined)).toBe('2026-01-15T09:00:00.000Z');
  });

  it('falls back to UTC for an unrecognized zone instead of throwing', () => {
    expect(toUtcIso('2026-01-15T09:00:00', 'Nowhere Standard Time')).toBe('2026-01-15T09:00:00.000Z');
  });

  it('accepts a space-separated datetime', () => {
    expect(toUtcIso('2026-01-15 09:00:00', 'Pacific Standard Time')).toBe('2026-01-15T17:00:00.000Z');
  });

  it('returns undefined for unparseable input rather than fabricating a time', () => {
    expect(toUtcIso('not-a-date', 'UTC')).toBeUndefined();
    expect(toUtcIso('', 'UTC')).toBeUndefined();
    expect(toUtcIso(undefined, 'UTC')).toBeUndefined();
  });
});
