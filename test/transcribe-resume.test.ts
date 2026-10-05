import { describe, it, expect, afterAll, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import {
  getDb, closeDb, insertMeeting, insertRecording, getMeeting, getRecording, updateMeeting,
  applyRecordingStatus, recoverStaleMeetings, claimOrphanedTranscriptions,
} from '../src/db.js';
import { resumeTranscription, MAX_TRANSCRIBE_ATTEMPTS } from '../src/transcribe-resume.js';
import { advanceMeeting } from './helpers/status.js';

// Wave 9-B: a crash during the (up to 30 min) transcription left the meeting 'processing' and
// the recording 'recorded' with the audio safely on disk. Recovery then failed both, and nothing
// ever retried — the audio sat untranscribed, labelled failed. Now the watcher resumes it.
let spy: ReturnType<typeof vi.spyOn>;
beforeEach(() => { spy = vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => spy.mockRestore());
afterAll(() => closeDb());

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mibot-resume-'));
const deadPid = async () => { const c = spawn('true'); await new Promise((r) => c.on('exit', r)); return c.pid!; };
const allDead = () => false;

/** A meeting that crashed mid-transcription: processing, recording 'recorded', stale, owner gone. */
const crashedMidTranscription = async (opts: { audio?: boolean } = {}) => {
  getDb();
  const m = insertMeeting({ title: 'crash', platform: 'zoom', join_url: 'https://zoom.us/j/c', start_time: new Date().toISOString() });
  const audio = path.join(dir, `${m.id}.webm`);
  if (opts.audio !== false) fs.writeFileSync(audio, 'x'.repeat(2000));
  const r = insertRecording({ meeting_id: m.id, audio_path: audio });
  advanceMeeting(m.id, 'processing');
  updateMeeting(m.id, {
    owner_pid: await deadPid(),
    participants: JSON.stringify([{ name: 'Ann', joined_at: 'a', left_at: 'b', is_bot: false, spoke: true }]),
    speaker_timeline: JSON.stringify([{ speaker: 'Ann', start: 'a', end: 'b' }]),
  });
  applyRecordingStatus(r.id, 'recorded');
  getDb().prepare('UPDATE meetings SET heartbeat = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', m.id);
  return { m, r, audio };
};

describe('recovery leaves a resumable transcription alone', () => {
  it('processing + recorded audio is NOT failed by recovery', async () => {
    const { m, r } = await crashedMidTranscription();
    recoverStaleMeetings(allDead);
    expect(getMeeting(m.id)!.status).toBe('processing');
    expect(getRecording(r.id)!.status).toBe('recorded');
  });

  it('a crash before any audio was saved (in_call) is still failed', async () => {
    getDb();
    const m = insertMeeting({ title: 'x', platform: 'zoom', join_url: 'https://zoom.us/j/x', start_time: new Date().toISOString() });
    advanceMeeting(m.id, 'in_call');
    getDb().prepare('UPDATE meetings SET heartbeat = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', m.id);
    recoverStaleMeetings(allDead);
    expect(getMeeting(m.id)!.status).toBe('failed');
  });
});

describe('claimOrphanedTranscriptions', () => {
  it('claims the job with its participants/timeline and takes ownership', async () => {
    const { m, r, audio } = await crashedMidTranscription();
    const jobs = claimOrphanedTranscriptions(allDead).filter((j) => j.meetingId === m.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ recordingId: r.id, audioPath: audio, attempts: 1 });
    expect(jobs[0].participants[0].name).toBe('Ann');
    expect(getMeeting(m.id)!.owner_pid).toBe(process.pid);
    // Claimed rows aren't stale anymore — a second claim doesn't double-run it.
    expect(claimOrphanedTranscriptions(allDead).some((j) => j.meetingId === m.id)).toBe(false);
  });

  it('never claims a job whose owner is still alive', async () => {
    const { m } = await crashedMidTranscription();
    expect(claimOrphanedTranscriptions(() => true).some((j) => j.meetingId === m.id)).toBe(false);
  });
});

describe('resumeTranscription', () => {
  const claim = async (o?: { audio?: boolean }) => {
    const c = await crashedMidTranscription(o);
    return { ...c, job: claimOrphanedTranscriptions(allDead).find((j) => j.meetingId === c.m.id)! };
  };

  it('re-runs transcription and finishes the meeting', async () => {
    const { m, r, job } = await claim();
    const transcribe = vi.fn().mockResolvedValue('done');
    await resumeTranscription(job, { transcribe });
    expect(transcribe).toHaveBeenCalledWith(r.id, job.audioPath, job.participants, job.speakerTimeline);
    expect(getRecording(r.id)!.status).toBe('done');
    expect(getMeeting(m.id)!.status).toBe('done');
  });

  it(`gives up after ${MAX_TRANSCRIBE_ATTEMPTS} attempts (a crash-loop must end)`, async () => {
    const { m, r, job } = await claim();
    const transcribe = vi.fn();
    await resumeTranscription({ ...job, attempts: MAX_TRANSCRIBE_ATTEMPTS + 1 }, { transcribe });
    expect(transcribe).not.toHaveBeenCalled();
    expect(getRecording(r.id)!.status).toBe('transcribe_failed');
    expect(getMeeting(m.id)!.status).toBe('done'); // the meeting happened; only transcription failed
  });

  it('missing audio file → recording and meeting failed, nothing run', async () => {
    const { m, r, job } = await claim({ audio: false });
    const transcribe = vi.fn();
    await resumeTranscription(job, { transcribe });
    expect(transcribe).not.toHaveBeenCalled();
    expect(getRecording(r.id)!.status).toBe('failed');
    expect(getMeeting(m.id)!.status).toBe('failed');
  });

  it('a throw leaves it resumable (recorded/processing) for the next attempt', async () => {
    const { m, r, job } = await claim();
    await resumeTranscription(job, { transcribe: vi.fn().mockRejectedValue(new Error('boom')) });
    expect(getRecording(r.id)!.status).toBe('recorded');
    expect(getMeeting(m.id)!.status).toBe('processing');
  });
});
