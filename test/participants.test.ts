import { describe, it, expect } from 'vitest';
import { deriveHumanCount } from '../src/meeting.js';

describe('deriveHumanCount (M3: no fabricated names, roster-count-minus-self into leave gate)', () => {
  it('uses scraped human names when available', () => {
    expect(deriveHumanCount({ humans: ['Alice', 'Bob'], bots: ['MiBot'], rosterCount: undefined }))
      .toBe(2);
  });

  it('falls back to rosterCount minus self when names cannot be scraped', () => {
    // selector churn: no names scraped, but roster shows 3 attendees (2 humans + the bot)
    expect(deriveHumanCount({ humans: [], bots: [], rosterCount: 3 })).toBe(2);
  });

  it('never returns negative when rosterCount is 1 (only the bot)', () => {
    expect(deriveHumanCount({ humans: [], bots: [], rosterCount: 1 })).toBe(0);
  });

  it('prefers real names over rosterCount even if rosterCount disagrees', () => {
    // M3 anti-inversion: a stale roster count must not override a real human present,
    // otherwise the bot would leave an active meeting (data loss).
    expect(deriveHumanCount({ humans: ['Alice'], bots: [], rosterCount: 1 })).toBe(1);
  });

  it('returns 0 when genuinely empty and no roster hint', () => {
    expect(deriveHumanCount({ humans: [], bots: [], rosterCount: undefined })).toBe(0);
  });
});
