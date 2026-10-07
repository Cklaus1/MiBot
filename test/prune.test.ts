import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getDb, closeDb, insertMeeting, insertRecording, getMeeting } from '../src/db.js';
import { prune } from '../src/prune.js';
import { webrtcAudioPathFor } from '../src/capture-session.js';
import { segmentPath } from '../src/audio-drain.js';

// Wave 9-L: nothing was ever pruned. Logs prune by default; recordings only when the operator
// opts in with retentionDays — and transcripts, unfinished meetings and anything outside the
// recordings dir are never touched.
afterAll(() => closeDb());

const NOW = Date.parse('2026-10-05T12:00:00.000Z');
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mibot-prune-'));
  const logDir = path.join(root, 'logs'); const recordingsDir = path.join(root, 'recordings');
  fs.mkdirSync(logDir); fs.mkdirSync(recordingsDir);
  return { root, logDir, recordingsDir };
}
const touch = (p: string, body = 'x', mtime?: number) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  if (mtime) fs.utimesSync(p, mtime / 1000, mtime / 1000);
  return p;
};
let n = 0;
function meeting(w: ReturnType<typeof world>, startDaysAgo: number, status: string, withAudio = true) {
  getDb();
  const m = insertMeeting({ title: `p${n++}`, platform: 'zoom', join_url: `https://zoom.us/j/p${n}`, start_time: daysAgo(startDaysAgo) });
  getDb().prepare('UPDATE meetings SET status = ? WHERE id = ?').run(status, m.id);
  const audio = path.join(w.recordingsDir, `${m.id}-zoom.webm`);
  if (withAudio) {
    touch(audio); touch(webrtcAudioPathFor(audio)); touch(segmentPath(audio, 1));
    insertRecording({ meeting_id: m.id, audio_path: audio });
  }
  const shots = path.join(w.recordingsDir, `screenshots-${m.id}`);
  touch(path.join(shots, 'share-1.png'));
  return { m, audio, shots };
}
const base = (w: ReturnType<typeof world>) => ({ logDir: w.logDir, recordingsDir: w.recordingsDir, now: NOW });

describe('logs', () => {
  it('deletes .log files older than logRetentionDays, keeps newer ones and non-logs', () => {
    const w = world();
    const old = touch(path.join(w.logDir, 'mibot-2026-08-01.log'), 'x', NOW - 40 * 86_400_000);
    const fresh = touch(path.join(w.logDir, 'mibot-2026-10-04.log'), 'x', NOW - 86_400_000);
    const other = touch(path.join(w.logDir, 'notes.txt'), 'x', NOW - 400 * 86_400_000);
    const r = prune({ ...base(w), retentionDays: 0, logRetentionDays: 30 });
    expect(r.logs).toEqual([old]);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(fresh) && fs.existsSync(other)).toBe(true);
  });

  it('logRetentionDays 0 keeps every log', () => {
    const w = world();
    const old = touch(path.join(w.logDir, 'a.log'), 'x', NOW - 999 * 86_400_000);
    prune({ ...base(w), retentionDays: 0, logRetentionDays: 0 });
    expect(fs.existsSync(old)).toBe(true);
  });
});

describe('recordings', () => {
  it('retentionDays 0 (the default) never deletes a recording', () => {
    const w = world();
    const { audio, shots } = meeting(w, 400, 'done');
    const r = prune({ ...base(w), retentionDays: 0, logRetentionDays: 30 });
    expect(r.audio).toEqual([]);
    expect(fs.existsSync(audio) && fs.existsSync(shots)).toBe(true);
  });

  it('deletes the audio family and screenshots of an old finished meeting, keeping its row', () => {
    const w = world();
    const { m, audio, shots } = meeting(w, 100, 'done');
    const r = prune({ ...base(w), retentionDays: 90, logRetentionDays: 30 });
    for (const f of [audio, webrtcAudioPathFor(audio), segmentPath(audio, 1)]) expect(fs.existsSync(f)).toBe(false);
    expect(fs.existsSync(shots)).toBe(false);
    expect(r.audio).toHaveLength(3);
    expect(r.bytes).toBeGreaterThan(0);
    expect(getMeeting(m.id)).toBeDefined(); // it has a recording (and maybe a transcript): row kept
  });

  it('never touches a recent meeting', () => {
    const w = world();
    const { audio } = meeting(w, 10, 'done');
    prune({ ...base(w), retentionDays: 90, logRetentionDays: 30 });
    expect(fs.existsSync(audio)).toBe(true);
  });

  it('never touches an unfinished meeting, however old', () => {
    const w = world();
    for (const status of ['scheduled', 'joining', 'in_call', 'processing']) {
      const { audio } = meeting(w, 500, status);
      prune({ ...base(w), retentionDays: 90, logRetentionDays: 30 });
      expect(fs.existsSync(audio)).toBe(true);
    }
  });

  it('removes rows of old meetings that never recorded (missed/cancelled), keeps ones that did', () => {
    const w = world();
    const missed = meeting(w, 100, 'missed', false);
    const recorded = meeting(w, 100, 'done', true);
    const r = prune({ ...base(w), retentionDays: 90, logRetentionDays: 30 });
    expect(r.meetingRows).toBeGreaterThanOrEqual(1);
    expect(getMeeting(missed.m.id)).toBeUndefined();
    expect(getMeeting(recorded.m.id)).toBeDefined();
  });

  it('never deletes a file outside the recordings directory, whatever the row says', () => {
    const w = world();
    const outside = touch(path.join(w.root, 'precious.webm'));
    getDb();
    const m = insertMeeting({ title: 'evil', platform: 'zoom', join_url: 'https://zoom.us/j/evil', start_time: daysAgo(100) });
    getDb().prepare("UPDATE meetings SET status = 'done' WHERE id = ?").run(m.id);
    insertRecording({ meeting_id: m.id, audio_path: outside });
    prune({ ...base(w), retentionDays: 90, logRetentionDays: 30 });
    expect(fs.existsSync(outside)).toBe(true);
  });

  it('dry run reports everything and deletes nothing', () => {
    const w = world();
    const { m, audio, shots } = meeting(w, 100, 'done');
    const missed = meeting(w, 100, 'cancelled', false);
    const r = prune({ ...base(w), retentionDays: 90, logRetentionDays: 30, dryRun: true });
    expect(r.audio.length).toBe(3);
    expect(r.screenshotDirs).toContain(shots);
    expect(r.meetingRows).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(audio) && fs.existsSync(shots)).toBe(true);
    expect(getMeeting(missed.m.id)).toBeDefined();
    expect(getMeeting(m.id)).toBeDefined();
  });
});

describe('failure screenshots (Wave 10 #1)', () => {
  it('are pruned with their old finished meeting, and only theirs', () => {
    const w = world();
    const old = meeting(w, 100, 'failed', false);
    const recent = meeting(w, 5, 'failed', false);
    const oldShot = touch(path.join(w.recordingsDir, 'failures', `${old.m.id}-1.png`));
    const recentShot = touch(path.join(w.recordingsDir, 'failures', `${recent.m.id}-1.png`));
    prune({ ...base(w), retentionDays: 90, logRetentionDays: 30 });
    expect(fs.existsSync(oldShot)).toBe(false);
    expect(fs.existsSync(recentShot)).toBe(true);
  });
});
