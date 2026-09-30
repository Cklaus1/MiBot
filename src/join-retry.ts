/**
 * Join retry policy.
 *
 * A join fails for reasons that are often transient: Zoom's "waiting for the host" screen, a
 * Teams pre-join dialog the playbook didn't expect, a lobby that timed out, a browser hiccup.
 * It used to mark the meeting 'failed' — terminal — and the scheduler only ever picks up
 * 'scheduled' rows, so one bad attempt two minutes before start lost the whole meeting.
 *
 * Now a failed JOIN (the bot never reached in_call) of a calendar meeting goes back to
 * 'scheduled' with a backoff, and is retried until the meeting's end time. Deliberately out of
 * scope: a failure AFTER in_call (a partial recording already exists — a different problem), and
 * a manual `mibot join` (no calendar event; the operator is at the terminal and sees the error).
 */

/** Assumed length when an event has no end time. Calendar providers almost always send one. */
export const DEFAULT_MEETING_MINUTES = 60;
const BASE_DELAY_MS = 60_000;
const MAX_DELAY_MS = 5 * 60_000;

/** Delay before retry N (0-based count of failures so far): 1, 2, 4, then 5 min max. Paces a
 *  permanently broken link so it can't relaunch a browser on every poll for a whole hour. */
export function retryDelayMs(failuresSoFar: number): number {
  return Math.min(BASE_DELAY_MS * 2 ** Math.max(0, failuresSoFar), MAX_DELAY_MS);
}

/** When the meeting is over: its end_time, or start + DEFAULT_MEETING_MINUTES if it has none. */
export function effectiveEndMs(m: { start_time: string; end_time: string | null }): number {
  if (m.end_time) {
    const end = Date.parse(m.end_time);
    if (!Number.isNaN(end)) return end;
  }
  return Date.parse(m.start_time) + DEFAULT_MEETING_MINUTES * 60_000;
}

export interface JoinFailureContext {
  status: string;
  calendar_event_id: string | null;
  start_time: string;
  end_time: string | null;
  join_attempts: number | null;
}

export type JoinRetryPlan =
  | { retry: true; nextJoinAt: string; attempt: number; delayMs: number }
  | { retry: false; reason: 'not-a-join-failure' | 'manual-join' | 'meeting-over' };

/** Decide what a bot failure means for its meeting. Pure — `now` is injected. */
export function planJoinRetry(m: JoinFailureContext, nowMs: number): JoinRetryPlan {
  if (m.status !== 'joining') return { retry: false, reason: 'not-a-join-failure' };
  if (!m.calendar_event_id) return { retry: false, reason: 'manual-join' };
  const failuresSoFar = m.join_attempts ?? 0;
  const delayMs = retryDelayMs(failuresSoFar);
  // Don't schedule a retry that would only fire after the meeting is over.
  if (nowMs + delayMs >= effectiveEndMs(m)) return { retry: false, reason: 'meeting-over' };
  return {
    retry: true,
    nextJoinAt: new Date(nowMs + delayMs).toISOString(),
    attempt: failuresSoFar + 1,
    delayMs,
  };
}
