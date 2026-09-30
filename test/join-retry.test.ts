import { describe, it, expect } from 'vitest';
import { planJoinRetry, retryDelayMs, effectiveEndMs, DEFAULT_MEETING_MINUTES } from '../src/join-retry.js';

const NOW = Date.parse('2026-09-30T15:02:00.000Z');
const base = {
  status: 'joining', calendar_event_id: 'm365:abc',
  start_time: '2026-09-30T15:00:00.000Z', end_time: '2026-09-30T15:30:00.000Z', join_attempts: 0,
};

describe('retryDelayMs: 1, 2, 4, then capped at 5 minutes', () => {
  it('backs off', () => {
    expect([0, 1, 2, 3, 10].map(retryDelayMs)).toEqual([60_000, 120_000, 240_000, 300_000, 300_000]);
  });
});

describe('effectiveEndMs', () => {
  it('uses end_time when present', () => expect(effectiveEndMs(base)).toBe(Date.parse(base.end_time)));
  it(`falls back to start + ${DEFAULT_MEETING_MINUTES} min when there is no end`, () =>
    expect(effectiveEndMs({ ...base, end_time: null })).toBe(Date.parse(base.start_time) + DEFAULT_MEETING_MINUTES * 60_000));
  it('treats an unparseable end like a missing one', () =>
    expect(effectiveEndMs({ ...base, end_time: 'garbage' })).toBe(Date.parse(base.start_time) + DEFAULT_MEETING_MINUTES * 60_000));
});

describe('planJoinRetry', () => {
  it('a failed join of a calendar meeting with time left is retried after the first backoff', () => {
    expect(planJoinRetry(base, NOW)).toEqual({
      retry: true, attempt: 1, delayMs: 60_000, nextJoinAt: '2026-09-30T15:03:00.000Z',
    });
  });

  it('later attempts back off further', () => {
    const p = planJoinRetry({ ...base, join_attempts: 2 }, NOW);
    expect(p).toMatchObject({ retry: true, attempt: 3, delayMs: 240_000 });
  });

  it('keeps retrying while the meeting is running, even long after it started', () => {
    const p = planJoinRetry({ ...base, end_time: '2026-09-30T17:00:00.000Z' }, Date.parse('2026-09-30T16:30:00.000Z'));
    expect(p.retry).toBe(true);
  });

  it('stops when the next attempt would land after the meeting ends', () => {
    expect(planJoinRetry(base, Date.parse('2026-09-30T15:29:30.000Z')))
      .toEqual({ retry: false, reason: 'meeting-over' });
  });

  it('does not retry a failure after the bot was already in the call', () => {
    for (const status of ['in_call', 'processing']) {
      expect(planJoinRetry({ ...base, status }, NOW)).toEqual({ retry: false, reason: 'not-a-join-failure' });
    }
  });

  it('does not retry a manual `mibot join` (no calendar event)', () => {
    expect(planJoinRetry({ ...base, calendar_event_id: null }, NOW)).toEqual({ retry: false, reason: 'manual-join' });
  });

  it('a missing attempt counter (pre-migration row) counts as zero', () => {
    expect(planJoinRetry({ ...base, join_attempts: null }, NOW)).toMatchObject({ retry: true, attempt: 1 });
  });
});
