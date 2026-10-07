import { describe, it, expect, afterAll, vi, beforeEach, afterEach } from 'vitest';
import { spawn } from 'child_process';
import { classifyJoinFailure } from '../src/diagnostics.js';
import { PlaybookStepError, PlaybookEngine } from '../src/playbook.js';
import {
  getDb, closeDb, insertMeeting, insertRecording, getMeeting, updateMeeting, applyRecordingStatus,
  startJoinAttempt, markAttemptJoined, finishJoinAttempt, listJoinAttempts, handleJoinFailure,
  recoverStaleMeetings, sweepMissedMeetings, cancelMeeting,
} from '../src/db.js';
import { buildReport } from '../src/report.js';
import { advanceMeeting } from './helpers/status.js';

// Wave 10 #1: 608 of 1,066 production meetings were 'failed' and not one said why.
let spy: ReturnType<typeof vi.spyOn>;
beforeEach(() => { spy = vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => spy.mockRestore());
afterAll(() => closeDb());

const stepErr = (action = 'click') => new PlaybookStepError(7, action, `role=button "Join now"`, new Error('not found within 10000ms'));

describe('classifyJoinFailure', () => {
  it('a playbook step failure names the step', () => {
    expect(classifyJoinFailure({ err: stepErr(), platform: 'teams', pageText: '' })).toEqual({
      reason: 'join_step_failed', step: 'step 7: click role=button "Join now"',
      detail: expect.stringContaining('not found'),
    });
  });

  it('lobby text on screen beats a generic step failure', () => {
    const cases: [string, string, string][] = [
      ['zoom', 'Please wait, the meeting host will let you in soon.', 'waiting_room_timeout'],
      ['zoom', 'Waiting for the host to start this meeting', 'meeting_not_started'],
      ['teams', "Someone in the meeting should let you in soon", 'waiting_room_timeout'],
      ['teams', "Sorry, but you were denied access to the meeting", 'not_admitted'],
      ['meet', 'Asking to join...', 'waiting_room_timeout'],
      ['meet', "You can't join this video call", 'not_admitted'],
      ['meet', 'Sign in to join this meeting', 'auth_required'],
    ];
    for (const [platform, text, reason] of cases) {
      expect(classifyJoinFailure({ err: stepErr(), platform, pageText: `blah\n${text}\nblah` }).reason, text).toBe(reason);
    }
  });

  it('infrastructure failures', () => {
    expect(classifyJoinFailure({ err: new Error('Camofox not running at http://localhost:9377'), platform: 'meet', pageText: '' }).reason)
      .toBe('camofox_unavailable');
    expect(classifyJoinFailure({ err: new Error('browserType.launch: Executable doesn\'t exist'), platform: 'teams', pageText: '' }).reason)
      .toBe('browser_launch_failed');
  });

  it('a failure after the bot was in the call is error_in_call, whatever the message', () => {
    expect(classifyJoinFailure({ err: new Error('boom'), platform: 'zoom', pageText: '', reachedCall: true }).reason).toBe('error_in_call');
  });

  it('anything else is internal_error with the message as detail', () => {
    expect(classifyJoinFailure({ err: new Error('weird'), platform: 'zoom', pageText: '' }))
      .toMatchObject({ reason: 'internal_error', detail: 'weird' });
  });
});

describe('PlaybookStepError from the engine', () => {
  it('a failing required step throws PlaybookStepError with its index and action', async () => {
    const page: any = {
      frames: () => [page], mainFrame: () => page, url: () => 'x',
      getByRole: () => ({ first() { return this; }, isVisible: async () => false }),
      goto: async () => {},
    };
    const err = await new PlaybookEngine(page).run({
      name: 't', variables: {},
      steps: [{ action: 'goto', url: 'https://x' }, { action: 'click', role: 'button', name: 'Join now', timeout: 20 }],
    } as any).catch((e) => e);
    expect(err).toBeInstanceOf(PlaybookStepError);
    expect(err.stepIndex).toBe(2);
    expect(err.action).toBe('click');
  });
});

let n = 0;
const mk = (o: { end?: number; eventId?: boolean } = {}) => {
  getDb();
  return insertMeeting({
    title: `d${n++}`, platform: 'teams', join_url: `https://teams.microsoft.com/d${n}`,
    start_time: new Date(Date.now() - 60_000).toISOString(),
    end_time: new Date(Date.now() + (o.end ?? 30) * 60_000).toISOString(),
    calendar_event_id: o.eventId === false ? undefined : `m365:diag-${Date.now()}-${n}`,
  });
};

describe('join attempts', () => {
  it('a successful run: one attempt, joined_at set, outcome completed', () => {
    const m = mk();
    advanceMeeting(m.id, 'joining');
    const a = startJoinAttempt(m.id);
    markAttemptJoined(a);
    finishJoinAttempt(a, { outcome: 'completed' });
    const rows = listJoinAttempts(m.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ attempt: 1, outcome: 'completed' });
    expect(rows[0].joined_at).toBeTruthy();
    expect(rows[0].ended_at).toBeTruthy();
  });

  it('retries produce numbered attempts, each with its reason; the terminal one lands on the meeting', () => {
    const m = mk({ end: 2.5 }); // room for exactly one 1-min retry... then over
    advanceMeeting(m.id, 'joining');
    const a1 = startJoinAttempt(m.id);
    finishJoinAttempt(a1, { outcome: 'failed', reason: 'waiting_room_timeout', step: 'step 5: wait' });
    handleJoinFailure(m.id, Date.now(), { reason: 'waiting_room_timeout', detail: 'lobby' });
    expect(getMeeting(m.id)!.status).toBe('scheduled');
    expect(getMeeting(m.id)!.failure_reason).toBeNull(); // not terminal yet

    advanceMeeting(m.id, 'joining', 'scheduled');
    const a2 = startJoinAttempt(m.id);
    finishJoinAttempt(a2, { outcome: 'failed', reason: 'not_admitted' });
    handleJoinFailure(m.id, Date.now() + 2 * 60_000, { reason: 'not_admitted', detail: 'denied' });
    const row = getMeeting(m.id)!;
    expect(row.status).toBe('failed');
    expect(row).toMatchObject({ failure_reason: 'not_admitted', failure_detail: 'denied' });
    expect(listJoinAttempts(m.id).map((r) => [r.attempt, r.reason])).toEqual([[1, 'waiting_room_timeout'], [2, 'not_admitted']]);
  });
});

describe('every terminal failure path records a reason', () => {
  it('missed', () => {
    getDb();
    const m = insertMeeting({ title: 'old', platform: 'zoom', join_url: 'https://zoom.us/j/old', start_time: '2000-01-01T00:00:00.000Z' });
    sweepMissedMeetings();
    expect(getMeeting(m.id)).toMatchObject({ status: 'missed', failure_reason: 'missed' });
  });

  it('cancelled', () => {
    const m = mk();
    cancelMeeting(m.calendar_event_id!);
    expect(getMeeting(m.id)).toMatchObject({ status: 'cancelled', failure_reason: 'cancelled' });
  });

  it('crashed: recovery closes the open attempt too', async () => {
    const m = mk();
    advanceMeeting(m.id, 'in_call');
    const a = startJoinAttempt(m.id);
    const c = spawn('true'); await new Promise((r) => c.on('exit', r));
    updateMeeting(m.id, { owner_pid: c.pid });
    getDb().prepare('UPDATE meetings SET heartbeat = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', m.id);
    recoverStaleMeetings();
    expect(getMeeting(m.id)).toMatchObject({ status: 'failed', failure_reason: 'crashed' });
    expect(listJoinAttempts(m.id).find((r) => r.id === a)).toMatchObject({ outcome: 'failed', reason: 'crashed' });
  });

  it('a non-retryable bot failure', () => {
    const m = mk({ eventId: false }); // manual join: never retried
    advanceMeeting(m.id, 'joining');
    handleJoinFailure(m.id, Date.now(), { reason: 'browser_launch_failed', detail: 'no chromium' });
    expect(getMeeting(m.id)).toMatchObject({ status: 'failed', failure_reason: 'browser_launch_failed' });
  });
});

describe('buildReport', () => {
  it('success rate, reasons, join time and recent failures, by platform', () => {
    getDb().exec('DELETE FROM join_attempts; DELETE FROM recordings; DELETE FROM meetings;');
    const now = Date.now();
    const meeting = (platform: string, status: string, rec: string | null, reason: string | null) => {
      const m = insertMeeting({ title: `${platform}-${status}-${n++}`, platform, join_url: `https://x/${n}`, start_time: new Date(now - 3600_000).toISOString() });
      getDb().prepare('UPDATE meetings SET status = ?, failure_reason = ? WHERE id = ?').run(status, reason, m.id);
      if (rec) { const r = insertRecording({ meeting_id: m.id, audio_path: `/tmp/${n}.webm` }); getDb().prepare('UPDATE recordings SET status = ? WHERE id = ?').run(rec, r.id); }
      return m;
    };
    const ok = meeting('teams', 'done', 'done', null);
    meeting('teams', 'done', 'no_audio', null);
    meeting('teams', 'failed', 'failed', 'waiting_room_timeout');
    meeting('zoom', 'failed', null, 'not_admitted');
    meeting('zoom', 'missed', null, 'missed');
    meeting('meet', 'cancelled', null, 'cancelled'); // not eligible: the meeting didn't happen
    const a = startJoinAttempt(ok.id);
    getDb().prepare('UPDATE join_attempts SET started_at = ?, joined_at = ? WHERE id = ?')
      .run(new Date(now - 100_000).toISOString(), new Date(now - 70_000).toISOString(), a);

    const r = buildReport({ sinceMs: now - 7 * 86_400_000, nowMs: now });
    expect(r.overall).toMatchObject({ eligible: 5, succeeded: 1 });
    expect(r.byPlatform.teams).toMatchObject({ eligible: 3, succeeded: 1 });
    expect(r.byPlatform.zoom).toMatchObject({ eligible: 2, succeeded: 0 });
    expect(r.reasons).toMatchObject({ no_audio: 1, waiting_room_timeout: 1, not_admitted: 1, missed: 1 });
    expect(r.reasons.cancelled).toBeUndefined();
    expect(r.medianJoinSec).toBe(30);
    expect(r.recentFailures[0]).toHaveProperty('reason');
  });
});
