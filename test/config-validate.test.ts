import { describe, it, expect } from 'vitest';
import { validateConfig, DEFAULTS } from '../src/config.js';

// F3/R10: validateConfig is a pure merge-over-defaults with per-field coercion and
// clamping. It must never throw on garbage input — a corrupt config.json falls back
// to safe defaults field-by-field rather than crashing the bot at startup.
describe('validateConfig (R10)', () => {
  it('returns defaults for empty input', () => {
    expect(validateConfig({})).toEqual(DEFAULTS);
  });

  it('accepts valid overrides', () => {
    const c = validateConfig({ botName: 'Scribe', minHumansToStay: 2, onlyOrganized: true });
    expect(c.botName).toBe('Scribe');
    expect(c.minHumansToStay).toBe(2);
    expect(c.onlyOrganized).toBe(true);
  });

  it('clamps out-of-range numbers to the default (negative alone timeout)', () => {
    expect(validateConfig({ aloneTimeoutMinutes: -5 }).aloneTimeoutMinutes)
      .toBe(DEFAULTS.aloneTimeoutMinutes);
    expect(validateConfig({ maxDurationHours: 9999 }).maxDurationHours)
      .toBe(DEFAULTS.maxDurationHours);
  });

  it('rejects wrong-typed numbers (string where number expected)', () => {
    expect(validateConfig({ minHumansToStay: 'lots' as any }).minHumansToStay)
      .toBe(DEFAULTS.minHumansToStay);
    expect(validateConfig({ pollMinutes: null as any }).pollMinutes)
      .toBe(DEFAULTS.pollMinutes);
  });

  it('rejects non-array pattern fields and keeps defaults', () => {
    expect(validateConfig({ botPatterns: 'otter' as any }).botPatterns)
      .toEqual(DEFAULTS.botPatterns);
    expect(validateConfig({ neverJoin: 42 as any }).neverJoin)
      .toEqual(DEFAULTS.neverJoin);
  });

  it('filters non-string entries out of array fields', () => {
    const c = validateConfig({ botPatterns: ['zoombot', 123 as any, null as any, 'otter'] });
    expect(c.botPatterns).toEqual(['zoombot', 'otter']);
  });

  it('coerces non-boolean booleans by truthiness rejection to default', () => {
    // a stray string should not silently become `true`
    expect(validateConfig({ onlyOrganized: 'yes' as any }).onlyOrganized)
      .toBe(DEFAULTS.onlyOrganized);
  });

  it('keeps a non-empty timezone string, rejects empty', () => {
    expect(validateConfig({ timezone: 'America/Chicago' }).timezone).toBe('America/Chicago');
    expect(validateConfig({ timezone: '' }).timezone).toBe(DEFAULTS.timezone);
  });
});
