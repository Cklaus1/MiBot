// LeavePolicy — pure meeting-leave decision logic, backend-agnostic.
//
// Extracted from the inline counters in meeting.ts (which had bugs M1/M9) so it can be
// unit-tested in isolation and reused by BOTH the Playwright loop (meeting.ts) and the
// Camofox loop (bot.ts, which had NO alone-detection at all — M15).
//
// The caller feeds one observation per poll with a monotonic `nowMs`; the policy returns
// `{action:'stay'}` or `{action:'leave', reason}`.

export interface LeavePolicyConfig {
  /** Bot stays as long as humanCount is strictly above this. */
  minHumansToStay: number;
  /** How long to wait, once at/below threshold for enough polls, before leaving. */
  aloneTimeoutMs: number;
  /** How long to wait, once fully empty for enough polls, before leaving. */
  leaveGracePeriodMs: number;
  /** Hard cap on meeting duration. */
  maxDurationMs: number;
  /** Consecutive missing-leave-button polls required to declare the meeting ended. */
  leaveButtonMissesToEnd: number;
  /** Consecutive at/below-threshold polls before the alone/grace clock starts. */
  emptyPollsToTrigger: number;
}

export type LeaveReason =
  | 'max-duration'
  | 'meeting-ended'
  | 'alone-timeout'
  | 'grace-expired';

export type LeaveDecision =
  | { action: 'stay' }
  | { action: 'leave'; reason: LeaveReason };

export interface PollObservation {
  /** Number of humans currently detected (bot already excluded by the caller). */
  humanCount: number;
  /** Whether the Leave/Hang-up button is currently present. */
  hasLeaveButton: boolean;
}

const STAY: LeaveDecision = { action: 'stay' };

export class LeavePolicy {
  private consecutiveAtOrBelow = 0;
  private leaveButtonMisses = 0;
  private aloneStart: number | null = null;
  private graceStart: number | null = null;

  constructor(
    private readonly config: LeavePolicyConfig,
    private readonly startTimeMs: number,
  ) {}

  /**
   * Feed one poll. `nowMs` must be monotonic (Date.now() in prod, a fake clock in tests).
   * Returns whether to stay or leave (with the reason).
   */
  observe(obs: PollObservation, nowMs: number): LeaveDecision {
    // 1. Hard duration cap — always wins.
    if (nowMs - this.startTimeMs >= this.config.maxDurationMs) {
      return { action: 'leave', reason: 'max-duration' };
    }

    // 2. Leave-button debounce (M7): a single flaky miss must not end the meeting.
    if (!obs.hasLeaveButton) {
      this.leaveButtonMisses++;
      if (this.leaveButtonMisses >= this.config.leaveButtonMissesToEnd) {
        return { action: 'leave', reason: 'meeting-ended' };
      }
    } else {
      this.leaveButtonMisses = 0;
    }

    // 3. Presence tracking. "At or below threshold" (M9): counter ticks whenever
    //    humanCount <= minHumansToStay, resets only when strictly above. This fixes M1
    //    (the old code only ticked at ===0 and froze at 1) and M9 (minHumansToStay>0
    //    could never trigger).
    const atOrBelow = obs.humanCount <= this.config.minHumansToStay;
    const fullyEmpty = obs.humanCount === 0;

    if (atOrBelow) {
      this.consecutiveAtOrBelow++;
    } else {
      this.consecutiveAtOrBelow = 0;
      this.aloneStart = null;
      this.graceStart = null;
      return STAY;
    }

    const triggered = this.consecutiveAtOrBelow >= this.config.emptyPollsToTrigger;
    if (!triggered) return STAY;

    // 4. Fully-empty → grace period (short). At/below-but-not-empty → alone timeout (long).
    if (fullyEmpty) {
      if (this.graceStart === null) this.graceStart = nowMs;
      if (nowMs - this.graceStart >= this.config.leaveGracePeriodMs) {
        return { action: 'leave', reason: 'grace-expired' };
      }
      return STAY;
    }

    if (this.aloneStart === null) this.aloneStart = nowMs;
    if (nowMs - this.aloneStart >= this.config.aloneTimeoutMs) {
      return { action: 'leave', reason: 'alone-timeout' };
    }
    return STAY;
  }
}
