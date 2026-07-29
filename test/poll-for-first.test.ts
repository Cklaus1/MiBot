import { describe, it, expect } from 'vitest';
import { pollForFirst } from '../src/poll.js';

// F7/R9: findElement must poll candidates repeatedly until a deadline (J4/J8 — the old
// code probed each frame once and gave up), and return NOTHING when nothing matches
// rather than falling back to an arbitrary candidate (J5 — old fallback was frames[last]).
// pollForFirst is that pure driver; the fake clock/sleep make it deterministic.
describe('pollForFirst (R9 deadline poll)', () => {
  const fakeClock = (start = 0) => {
    let t = start;
    return {
      now: () => t,
      sleep: async (ms: number) => { t += ms; },
    };
  };

  it('returns the first matching candidate immediately when present', async () => {
    const clock = fakeClock();
    const result = await pollForFirst(
      ['a', 'b', 'c'],
      async (c) => c === 'b',
      { deadlineMs: 1000, intervalMs: 100, now: clock.now, sleep: clock.sleep },
    );
    expect(result).toBe('b');
  });

  it('returns null (not an arbitrary candidate) when nothing matches by the deadline (J5)', async () => {
    const clock = fakeClock();
    const result = await pollForFirst(
      ['x', 'y', 'z'],
      async () => false,
      { deadlineMs: 500, intervalMs: 100, now: clock.now, sleep: clock.sleep },
    );
    expect(result).toBeNull();
  });

  it('keeps polling across rounds until a late-appearing candidate matches (J4/J8)', async () => {
    const clock = fakeClock();
    let calls = 0;
    // matches only after ~300ms of elapsed time
    const result = await pollForFirst(
      ['a'],
      async () => { calls++; return clock.now() >= 300; },
      { deadlineMs: 1000, intervalMs: 100, now: clock.now, sleep: clock.sleep },
    );
    expect(result).toBe('a');
    expect(calls).toBeGreaterThan(1); // proves it polled more than once
  });

  it('probes every candidate within a round before sleeping', async () => {
    const clock = fakeClock();
    const probed: string[] = [];
    await pollForFirst(
      ['a', 'b', 'c'],
      async (c) => { probed.push(c); return false; },
      { deadlineMs: 150, intervalMs: 100, now: clock.now, sleep: clock.sleep },
    );
    // first round must have probed all three before the deadline lapsed
    expect(probed.slice(0, 3)).toEqual(['a', 'b', 'c']);
  });

  it('swallows probe errors and treats them as "no match"', async () => {
    const clock = fakeClock();
    const result = await pollForFirst(
      ['a', 'b'],
      async (c) => { if (c === 'a') throw new Error('frame detached'); return c === 'b'; },
      { deadlineMs: 500, intervalMs: 100, now: clock.now, sleep: clock.sleep },
    );
    expect(result).toBe('b');
  });
});
