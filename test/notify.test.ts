import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  getDb, closeDb, insertMeeting, insertRecording, startJoinAttempt, finishJoinAttempt,
} from '../src/db.js';
import {
  enqueue, drainOutbox, raiseAlert, resolveAlert, noticeAlert, enqueuePendingDigests,
  NotesFolderChannel, setAlertsEnabled, type Channel, type Notification,
} from '../src/notify.js';
import { buildDigest, safeTitle } from '../src/digest.js';

// Wave 10 #3/#4: results and problems reach the operator without being asked for.
afterAll(() => closeDb());
beforeEach(() => { getDb().exec('DELETE FROM notifications; DELETE FROM alerts;'); setAlertsEnabled(true); });

const folder = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mibot-notes-'));
const pending = () => getDb().prepare("SELECT * FROM notifications WHERE status = 'pending'").all() as any[];

describe('outbox', () => {
  it('delivers due notifications and marks them sent', async () => {
    enqueue({ kind: 'digest', title: 't', payload: 'p' });
    const got: Notification[] = [];
    expect(await drainOutbox({ deliver: async (n) => { got.push(n); } })).toEqual({ sent: 1, failed: 0 });
    expect(got[0].title).toBe('t');
    expect(pending()).toHaveLength(0);
  });

  it('a failing channel never throws, and retries with backoff (not before)', async () => {
    const t0 = Date.parse('2026-10-07T12:00:00Z');
    enqueue({ kind: 'digest', title: 't', payload: 'p' }, t0);
    const broken: Channel = { deliver: async () => { throw new Error('disk full'); } };
    expect(await drainOutbox(broken, t0)).toEqual({ sent: 0, failed: 1 });
    expect(await drainOutbox(broken, t0 + 30_000)).toEqual({ sent: 0, failed: 0 }); // backing off
    const ok: Notification[] = [];
    expect(await drainOutbox({ deliver: async (n) => { ok.push(n); } }, t0 + 61_000)).toEqual({ sent: 1, failed: 0 });
    expect(pending()).toHaveLength(0);
  });
});

describe('alerts', () => {
  it('fire once while active, re-fire after an hour, and resolve exactly once', () => {
    const t0 = Date.parse('2026-10-07T12:00:00Z');
    expect(raiseAlert('calendar:m365', 'Calendar sync failing', 'login expired?', t0)).toBe(true);
    expect(raiseAlert('calendar:m365', 'Calendar sync failing', 'again', t0 + 60_000)).toBe(false);
    expect(raiseAlert('calendar:m365', 'Calendar sync failing', 'still', t0 + 3_700_000)).toBe(true);
    expect(resolveAlert('calendar:m365', 'sync ok', t0 + 3_800_000)).toBe(true);
    expect(resolveAlert('calendar:m365', 'sync ok', t0 + 3_900_000)).toBe(false);
    expect(pending().map((n) => n.kind)).toEqual(['alert', 'alert', 'resolved']);
  });

  it('a one-off notice fires but never stays active', () => {
    noticeAlert('watcher-restart', 'Watcher restarted', 'recovered 2 meetings');
    expect(resolveAlert('watcher-restart', 'x')).toBe(false);
    expect(pending()).toHaveLength(1);
  });

  it('notify.alerts = false silences them', () => {
    setAlertsEnabled(false);
    expect(raiseAlert('x', 'X', 'y')).toBe(false);
    expect(pending()).toHaveLength(0);
  });
});

describe('notes folder channel', () => {
  it('one note per meeting, never overwriting an existing (possibly edited) note', async () => {
    const dir = folder(); const ch = new NotesFolderChannel(dir);
    const n = (id: number) => ({ id, kind: 'digest', dedupe_key: null, meeting_id: 1, title: '2026-10-07 1500 Sync', payload: `v${id}`, attempts: 0 } as Notification);
    await ch.deliver(n(1));
    fs.writeFileSync(path.join(dir, '2026-10-07 1500 Sync.md'), 'my edits');
    await ch.deliver(n(2));
    expect(fs.readFileSync(path.join(dir, '2026-10-07 1500 Sync.md'), 'utf8')).toBe('my edits');
    expect(fs.readFileSync(path.join(dir, '2026-10-07 1500 Sync (2).md'), 'utf8')).toBe('v2');
    expect(fs.readdirSync(dir).some((f) => f.endsWith('.tmp'))).toBe(false);
  });

  it('ALERTS.md: newest first, resolution placed under its alert', async () => {
    const dir = folder(); const ch = new NotesFolderChannel(dir);
    const a = (id: number, kind: any, key: string, title: string, payload: string) =>
      ({ id, kind, dedupe_key: key, meeting_id: null, title, payload, attempts: 0 } as Notification);
    await ch.deliver(a(1, 'alert', 'calendar:m365', 'Calendar sync failing', 'login expired?'));
    await ch.deliver(a(2, 'alert', 'camofox', 'Camofox down', 'start it'));
    await ch.deliver(a(3, 'resolved', 'calendar:m365', 'Resolved: calendar:m365', 'sync ok'));
    const text = fs.readFileSync(ch.alertsFile, 'utf8');
    expect(text.indexOf('Camofox down')).toBeLessThan(text.indexOf('Calendar sync failing'));
    const cal = text.indexOf('Calendar sync failing');
    expect(text.indexOf('Resolved') > cal && text.indexOf('Resolved') < cal + 200).toBe(true);
  });
});

describe('digests', () => {
  const base = {
    id: 7, title: 'Design review', platform: 'teams', start_time: '2026-10-07T15:00:00.000Z', status: 'done',
    actual_start: '2026-10-07T15:01:00.000Z', actual_end: '2026-10-07T15:33:00.000Z',
    participants: JSON.stringify([{ name: 'Ann', spoke: true }, { name: 'Bob' }, { name: 'MiBot', is_bot: true }]),
    failure_reason: null, failure_detail: null, consent_posted: 1, stopped_by: null,
  };
  const transcript = { llm_analysis: {
    action_items: [{ text: 'Send the deck', assignee: 'Ann', deadline: 'Friday' }, { text: 'Book room', assignee: null }],
    key_decisions: ['Ship v2 in November'],
  } };

  it('a recorded meeting: front matter, summary, action items, decisions, participants, transcript link', () => {
    const d = buildDigest({ meeting: base, recording: { status: 'done', transcript_path: '/r/output/7.md' },
      attempts: [], summary: 'We agreed to ship.', transcript, timezone: 'UTC' });
    expect(d.stem).toBe('2026-10-07 1501 Design review');
    expect(d.markdown).toMatch(/^---\ndate: 2026-10-07 15:01\nplatform: teams\nduration_min: 32\noutcome: recorded\nparticipants: \["Ann", "Bob"\]/);
    expect(d.markdown).toContain('## Summary\n\nWe agreed to ship.');
    expect(d.markdown).toContain('- [ ] Send the deck — Ann (due Friday)');
    expect(d.markdown).toContain('- [ ] Book room\n');
    expect(d.markdown).toContain('- Ship v2 in November');
    expect(d.markdown).toContain('- Ann (spoke)');
    expect(d.markdown).not.toContain('MiBot');
    expect(d.markdown).toContain('[7.md](</r/output/7.md>)');
  });

  it('flags a notice that failed to post, and an early stop', () => {
    const d = buildDigest({ meeting: { ...base, consent_posted: 0, stopped_by: 'Bob' }, recording: { status: 'done', transcript_path: null },
      attempts: [], summary: null, transcript: null, timezone: 'UTC' });
    expect(d.markdown).toContain('Participants were not notified');
    expect(d.markdown).toContain('**Bob** asked the bot to leave');
  });

  it('a failed meeting explains why, with each attempt and its screenshot', () => {
    const d = buildDigest({
      meeting: { ...base, status: 'failed', actual_start: null, actual_end: null, failure_reason: 'waiting_room_timeout', failure_detail: 'step 5: wait' },
      recording: null, summary: null, transcript: null, timezone: 'UTC',
      attempts: [{ attempt: 1, reason: 'waiting_room_timeout', step: 'step 5: wait', screenshot_path: '/f/7-1.png' }],
    });
    expect(d.markdown).toContain('outcome: not recorded (waiting_room_timeout)');
    expect(d.markdown).toContain('stuck in the waiting room');
    expect(d.markdown).toContain('- #1: waiting_room_timeout @ step 5: wait — [screenshot](</f/7-1.png>)');
  });

  it('titles are made filename-safe', () => {
    expect(safeTitle('Q4: plan / review?*')).toBe('Q4 plan review');
    expect(safeTitle('')).toBe('Untitled meeting');
  });

  it('enqueuePendingDigests: one per finished meeting, waits for transcription, skips cancelled', () => {
    getDb().exec('DELETE FROM join_attempts; DELETE FROM recordings; DELETE FROM meetings;');
    const mk = (status: string, rec?: string) => {
      const m = insertMeeting({ title: status, platform: 'zoom', join_url: `https://zoom.us/j/${status}${rec}`, start_time: new Date().toISOString() });
      getDb().prepare('UPDATE meetings SET status = ? WHERE id = ?').run(status, m.id);
      if (rec) { const r = insertRecording({ meeting_id: m.id, audio_path: '/tmp/x.webm' }); getDb().prepare('UPDATE recordings SET status = ? WHERE id = ?').run(rec, r.id); }
      return m;
    };
    mk('done', 'done'); mk('done', 'recorded'); mk('failed'); mk('missed'); mk('cancelled');
    const a = startJoinAttempt(mk('failed').id); finishJoinAttempt(a, { outcome: 'failed', reason: 'not_admitted' });
    expect(enqueuePendingDigests({ timezone: 'UTC' })).toBe(4); // done/done, failed, missed, failed
    expect(enqueuePendingDigests({ timezone: 'UTC' })).toBe(0); // exactly once
    expect(pending().filter((n) => n.kind === 'digest')).toHaveLength(4);
  });

  it('a stale non-terminal recording from an EARLIER attempt does not block the note', () => {
    getDb().exec('DELETE FROM recordings; DELETE FROM meetings;');
    const m = insertMeeting({ title: 'retried', platform: 'zoom', join_url: 'https://zoom.us/j/stale', start_time: new Date().toISOString() });
    getDb().prepare("UPDATE meetings SET status = 'done' WHERE id = ?").run(m.id);
    const old = insertRecording({ meeting_id: m.id, audio_path: '/tmp/a.webm' });
    getDb().prepare("UPDATE recordings SET status = 'recording' WHERE id = ?").run(old.id);
    const latest = insertRecording({ meeting_id: m.id, audio_path: '/tmp/b.webm' });
    getDb().prepare("UPDATE recordings SET status = 'done' WHERE id = ?").run(latest.id);
    expect(enqueuePendingDigests({ timezone: 'UTC' })).toBe(1);
  });

  it('digest "off" marks meetings without writing, so turning it on later has no backlog', () => {
    getDb().exec('DELETE FROM recordings; DELETE FROM meetings;');
    const m = insertMeeting({ title: 'x', platform: 'zoom', join_url: 'https://zoom.us/j/off', start_time: new Date().toISOString() });
    getDb().prepare("UPDATE meetings SET status = 'failed' WHERE id = ?").run(m.id);
    expect(enqueuePendingDigests({ timezone: 'UTC', write: false })).toBe(1);
    expect(pending()).toHaveLength(0);
    expect(enqueuePendingDigests({ timezone: 'UTC' })).toBe(0);
  });
});
