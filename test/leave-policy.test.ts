import { describe, it, expect } from 'vitest';
import { LeavePolicy, type LeavePolicyConfig } from '../src/leave-policy.js';

const cfg = (over: Partial<LeavePolicyConfig> = {}): LeavePolicyConfig => ({
  minHumansToStay: 0,
  aloneTimeoutMs: 5 * 60 * 1000,
  leaveGracePeriodMs: 30 * 1000,
  maxDurationMs: 4 * 60 * 60 * 1000,
  leaveButtonMissesToEnd: 2,
  emptyPollsToTrigger: 2,
  ...over,
});

describe('LeavePolicy', () => {
  // M1 regression: polls [2,0,0,0,...] must eventually leave via grace.
  // The old inline counter froze consecutiveEmptyPolls at 1 and never fired.
  it('M1: exits via grace after all humans leave (poll sequence 2,0,0,0…)', () => {
    const p = new LeavePolicy(cfg(), 0);
    let t = 0;
    const step = (humans: number) => p.observe({ humanCount: humans, hasLeaveButton: true }, (t += 5000));

    expect(step(2).action).toBe('stay');           // people present
    expect(step(0).action).toBe('stay');           // 1st empty poll — not yet triggered
    expect(step(0).action).toBe('stay');           // 2nd empty — grace starts
    // grace is 30s; keep polling empty until it expires
    let last = step(0);
    for (let i = 0; i < 10 && last.action === 'stay'; i++) last = step(0);
    expect(last).toEqual({ action: 'leave', reason: 'grace-expired' });
  });

  // M9 regression: minHumansToStay>0 must be able to alone-timeout.
  it('M9: alone-timeout fires when humanCount stays at-or-below threshold', () => {
    const p = new LeavePolicy(cfg({ minHumansToStay: 1, aloneTimeoutMs: 20_000 }), 0);
    let t = 0;
    const step = (humans: number) => p.observe({ humanCount: humans, hasLeaveButton: true }, (t += 5000));
    expect(step(3).action).toBe('stay');
    step(1); // below-threshold poll 1
    step(1); // below-threshold poll 2 → aloneStart
    let last = step(1);
    for (let i = 0; i < 10 && last.action === 'stay'; i++) last = step(1);
    expect(last).toEqual({ action: 'leave', reason: 'alone-timeout' });
  });

  it('resets alone/grace timers when people rejoin', () => {
    const p = new LeavePolicy(cfg(), 0);
    let t = 0;
    const step = (humans: number) => p.observe({ humanCount: humans, hasLeaveButton: true }, (t += 5000));
    step(2); step(0); step(0); // grace started
    expect(step(2).action).toBe('stay'); // rejoined → reset
    // now a fresh empty run must start the grace clock over, not immediately expire
    expect(step(0).action).toBe('stay');
    expect(step(0).action).toBe('stay');
  });

  // M7 regression: single flaky leave-button miss must NOT end the meeting.
  it('M7: requires consecutive leave-button misses before ending', () => {
    const p = new LeavePolicy(cfg(), 0);
    let t = 0;
    expect(p.observe({ humanCount: 2, hasLeaveButton: false }, (t += 5000)).action).toBe('stay'); // 1 miss
    expect(p.observe({ humanCount: 2, hasLeaveButton: true }, (t += 5000)).action).toBe('stay');  // recovered
    expect(p.observe({ humanCount: 2, hasLeaveButton: false }, (t += 5000)).action).toBe('stay'); // 1 miss again
    expect(p.observe({ humanCount: 2, hasLeaveButton: false }, (t += 5000)))
      .toEqual({ action: 'leave', reason: 'meeting-ended' }); // 2 consecutive → end
  });

  it('leaves at max duration regardless of presence', () => {
    const p = new LeavePolicy(cfg({ maxDurationMs: 10_000 }), 0);
    expect(p.observe({ humanCount: 5, hasLeaveButton: true }, 5000).action).toBe('stay');
    expect(p.observe({ humanCount: 5, hasLeaveButton: true }, 15_000))
      .toEqual({ action: 'leave', reason: 'max-duration' });
  });
});
