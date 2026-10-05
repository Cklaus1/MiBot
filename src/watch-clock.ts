/**
 * Wave 9-G: the watcher used to do everything on one timer — calendar sync AND the "is anything
 * due to join?" check — every `pollMinutes`. With the join window being joinBeforeMinutes before
 * the start, a long poll interval meant joining late by up to the whole interval (and, before the
 * join-until-end change, missing meetings outright above ~33 minutes).
 *
 * Now two cadences: the launch check (cheap: a DB query, recovery, the missed sweep) runs every
 * LAUNCH_TICK_MS regardless of config; the calendar sync (two external CLIs, rate-limited APIs)
 * runs every `pollMinutes`. pollMinutes now only controls how fresh the calendar is.
 */
export const LAUNCH_TICK_MS = 60_000;

export class SyncSchedule {
  private lastSyncAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly pollMinutes: number) {}

  /** Is a calendar sync due at `nowMs`? */
  due(nowMs: number): boolean {
    return nowMs - this.lastSyncAt >= this.pollMinutes * 60_000;
  }

  /** Record a sync ATTEMPT (success or failure), so a failing CLI isn't retried every tick. */
  markSynced(nowMs: number): void {
    this.lastSyncAt = nowMs;
  }
}
