import { describe, it, expect } from 'vitest';
import { resolveGwsBinary } from '../src/calendar.js';

// CA11: when GWS_PATH is explicitly set but the binary is missing, sync silently returned []
// (misread as "user hasn't set up gwscli") → Google meetings quietly stopped syncing. And the
// default was a hardcoded dev path (/root/projects/gwscli/…) that no-ops on any other machine
// even with no env var set. resolveGwsBinary distinguishes the cases so the caller can warn on a
// genuine misconfiguration while staying silent when Google sync was simply never configured.
describe('CA11 resolveGwsBinary', () => {
  it('explicitly set + present → proceed', () => {
    expect(resolveGwsBinary('/usr/bin/gws', () => true)).toEqual({ action: 'run', path: '/usr/bin/gws' });
  });

  it('explicitly set + MISSING → warn (not a silent skip)', () => {
    const r = resolveGwsBinary('/usr/bin/gws', () => false);
    expect(r.action).toBe('warn');
    expect(r.path).toBe('/usr/bin/gws');
  });

  it('unset + hardcoded default present → proceed', () => {
    const r = resolveGwsBinary(undefined, () => true);
    expect(r.action).toBe('run');
  });

  it('unset + default missing → silent skip (never configured)', () => {
    expect(resolveGwsBinary(undefined, () => false)).toEqual({ action: 'skip' });
  });
});
