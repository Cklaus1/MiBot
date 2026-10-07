import { describe, it, expect, afterAll, vi, beforeEach, afterEach } from 'vitest';
import { meetingSkipReason, DEFAULTS } from '../src/config.js';
import {
  getDb, closeDb, insertMeeting, getMeeting, setUserSkip, requestLeave, leaveRequested,
  markRuleSkipped, sweepMissedMeetings,
} from '../src/db.js';
import { reconcileProvider, type NormalizedMeeting } from '../src/calendar.js';
import { enqueuePendingDigests } from '../src/notify.js';
import { buildReport } from '../src/report.js';
import { advanceMeeting } from './helpers/status.js';

// Wave 10 #5: the only filters were global; nothing could skip one meeting or make a running
// bot leave.
let spy: ReturnType<typeof vi.spyOn>;
beforeEach(() => { spy = vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => spy.mockRestore());
afterAll(() => closeDb());

const cfg = (o: object = {}) => ({ ...DEFAULTS, neverJoin: [], ...o });
const m = (o: object = {}) => ({ title: 'Sync', description: null, attendees: null, organizer_email: 'me@x', is_organizer: 1, user_skip: 0, ...o }) as any;

describe('event keywords', () => {
  it('[no-bot] in the title or description skips, case-insensitively', () => {
    expect(meetingSkipReason(m({ title: 'Board call [NO-BOT]' }), cfg())).toMatch(/no-bot/i);
    expect(meetingSkipReason(m({ description: 'agenda…\n[no-bot]' }), cfg())).toMatch(/no-bot/i);
  });
  it('[bot] forces a join past onlyOrganized and minAttendees', () => {
    const strict = cfg({ onlyOrganized: true, minAttendees: 5 });
    expect(meetingSkipReason(m({ is_organizer: 0 }), strict)).not.toBeNull();
    expect(meetingSkipReason(m({ is_organizer: 0, title: 'Partner sync [bot]' }), strict)).toBeNull();
  });
  it('[bot] does not override an explicit skip', () => {
    expect(meetingSkipReason(m({ title: '[bot] [no-bot]' }), cfg())).toMatch(/no-bot/i);
    expect(meetingSkipReason(m({ title: '[bot]', user_skip: 1 }), cfg())).toMatch(/mibot skip/);
  });
  it('keywords are configurable', () => {
    expect(meetingSkipReason(m({ title: 'x #private' }), cfg({ skipKeyword: '#private' }))).not.toBeNull();
  });
});

let n = 0;
const ev = (id: string, start: string): NormalizedMeeting => ({
  title: 'Standup', platform: 'zoom', join_url: `https://zoom.us/j/ctl${n++}`, start_time: start, calendar_event_id: id,
} as NormalizedMeeting);

describe('mibot skip / unskip', () => {
  it('skip sticks through a calendar sync that moves the meeting', () => {
    const id = `m365:skip-${Date.now()}`;
    reconcileProvider('m365:', [ev(id, '2026-10-08T15:00:00.000Z')], '');
    const row = getMeeting((getDb().prepare('SELECT id FROM meetings WHERE calendar_event_id = ?').get(id) as any).id)!;
    expect(setUserSkip(row.id, true)).toBe(true);
    reconcileProvider('m365:', [ev(id, '2026-10-08T16:00:00.000Z')], '');
    const after = getMeeting(row.id)!;
    expect(after.user_skip).toBe(1);
    expect(new Date(after.start_time).toISOString()).toBe('2026-10-08T16:00:00.000Z');
  });
  it('unskip clears it', () => {
    getDb();
    const r = insertMeeting({ title: 'u', platform: 'zoom', join_url: 'https://zoom.us/j/u', start_time: new Date().toISOString() });
    setUserSkip(r.id, true); setUserSkip(r.id, false);
    expect(getMeeting(r.id)).toMatchObject({ user_skip: 0, failure_reason: null });
  });
  it('only a not-yet-started meeting can be skipped (a running one needs mibot leave)', () => {
    getDb();
    const r = insertMeeting({ title: 'run', platform: 'zoom', join_url: 'https://zoom.us/j/run', start_time: new Date().toISOString() });
    advanceMeeting(r.id, 'in_call');
    expect(setUserSkip(r.id, true)).toBe(false);
  });
});

describe('skipped meetings are not failures', () => {
  it('when its time passes, a skipped meeting is recorded as skipped (not missed), gets no note, and is not counted', () => {
    getDb().exec('DELETE FROM notifications; DELETE FROM join_attempts; DELETE FROM recordings; DELETE FROM meetings;');
    const old = '2000-01-01T00:00:00.000Z';
    const byOp = insertMeeting({ title: 'op', platform: 'zoom', join_url: 'https://zoom.us/j/a', start_time: old });
    const byRule = insertMeeting({ title: 'rule', platform: 'zoom', join_url: 'https://zoom.us/j/b', start_time: old });
    const missed = insertMeeting({ title: 'missed', platform: 'zoom', join_url: 'https://zoom.us/j/c', start_time: old });
    setUserSkip(byOp.id, true);
    markRuleSkipped(byRule.id, 'skip keyword [no-bot]');
    sweepMissedMeetings();
    expect(getMeeting(byOp.id)).toMatchObject({ status: 'missed', failure_reason: 'skipped' });
    expect(getMeeting(byRule.id)).toMatchObject({ status: 'missed', failure_reason: 'skipped' });
    expect(getMeeting(missed.id)).toMatchObject({ status: 'missed', failure_reason: 'missed' });
    expect(enqueuePendingDigests({ timezone: 'UTC' })).toBe(1); // only the genuinely missed one
    expect(buildReport({ sinceMs: 0 }).overall.eligible).toBe(1);
  });

  it('a meeting skipped by a rule that no longer applies joins normally, without a stale reason', () => {
    getDb();
    const r = insertMeeting({ title: 'x', platform: 'zoom', join_url: 'https://zoom.us/j/x2', start_time: new Date().toISOString() });
    markRuleSkipped(r.id, 'skip keyword');
    advanceMeeting(r.id, 'joining');
    expect(getMeeting(r.id)!.failure_reason).toBeNull();
  });
});

describe('mibot leave', () => {
  it('flags a running meeting; the monitor loops read it', () => {
    getDb();
    const r = insertMeeting({ title: 'live', platform: 'zoom', join_url: 'https://zoom.us/j/live', start_time: new Date().toISOString() });
    advanceMeeting(r.id, 'in_call');
    expect(leaveRequested(r.id)).toBeNull();
    expect(requestLeave(r.id)).toBe(true);
    expect(leaveRequested(r.id)).toMatch(/mibot leave/);
  });
  it('refuses a meeting that is not running', () => {
    getDb();
    const r = insertMeeting({ title: 'later', platform: 'zoom', join_url: 'https://zoom.us/j/later', start_time: new Date().toISOString() });
    expect(requestLeave(r.id)).toBe(false);
  });
});
