import { describe, it, expect } from 'vitest';
import { SyncSchedule, LAUNCH_TICK_MS } from '../src/watch-clock.js';

// Wave 9-G: launch checks and calendar sync used to share one pollMinutes timer, so a long
// interval meant joining late by up to the whole interval.
describe('watch cadence', () => {
  it('the launch check runs every minute, independent of pollMinutes', () => {
    expect(LAUNCH_TICK_MS).toBe(60_000);
  });

  it('pollMinutes = 60: over an hour of 1-minute ticks, exactly one sync after the first', () => {
    const s = new SyncSchedule(60);
    let syncs = 0;
    for (let t = 0; t <= 60 * 60_000; t += LAUNCH_TICK_MS) {
      if (s.due(t)) { syncs++; s.markSynced(t); }
    }
    expect(syncs).toBe(2); // at t=0 and t=60min
  });

  it('the first tick always syncs', () => expect(new SyncSchedule(30).due(0)).toBe(true));

  it('a failed sync still counts as an attempt (no CLI hammering every minute)', () => {
    const s = new SyncSchedule(5);
    s.markSynced(0);
    expect(s.due(4 * 60_000)).toBe(false);
    expect(s.due(5 * 60_000)).toBe(true);
  });
});
