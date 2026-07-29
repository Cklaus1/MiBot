import { describe, it, expect, afterAll } from 'vitest';
import {
  getDb, closeDb, insertMeeting, insertRecording,
  getRecording, applyRecordingStatus,
} from '../src/db.js';

// C7/T1: applyRecordingStatus is the single choke point for recording-status writes.
// It reconciles the desired status against the current one so a post-processing
// catch-all can never downgrade a terminal outcome (e.g. transcribe_failed, no_audio)
// back to 'failed', and a stale 'done' can't clobber a real transcribe_failed.
describe('applyRecordingStatus (C7 reconcile at DB layer)', () => {
  afterAll(() => closeDb());

  const freshRecording = () => {
    getDb();
    const m = insertMeeting({
      title: 'rec-status', platform: 'teams',
      join_url: 'https://teams.microsoft.com/x', start_time: new Date().toISOString(),
    });
    return insertRecording({ meeting_id: m.id, audio_path: '/tmp/x.webm' });
  };

  it('applies a normal forward transition and returns it', () => {
    const r = freshRecording();
    expect(applyRecordingStatus(r.id, 'recorded')).toBe('recorded');
    expect(getRecording(r.id)!.status).toBe('recorded');
  });

  it('does NOT downgrade a terminal transcribe_failed to failed (C7)', () => {
    const r = freshRecording();
    applyRecordingStatus(r.id, 'transcribe_failed');
    const applied = applyRecordingStatus(r.id, 'failed'); // catch-all fires afterward
    expect(applied).toBe('transcribe_failed');
    expect(getRecording(r.id)!.status).toBe('transcribe_failed');
  });

  it('does NOT downgrade a terminal no_audio to failed (C7)', () => {
    const r = freshRecording();
    applyRecordingStatus(r.id, 'no_audio');
    expect(applyRecordingStatus(r.id, 'failed')).toBe('no_audio');
    expect(getRecording(r.id)!.status).toBe('no_audio');
  });

  it('does NOT clobber a real transcribe_failed with a stale done (T1)', () => {
    const r = freshRecording();
    applyRecordingStatus(r.id, 'transcribe_failed');
    // T1: the old code wrote 'done' unconditionally after transcribe(); guard it.
    expect(applyRecordingStatus(r.id, 'done')).toBe('transcribe_failed');
    expect(getRecording(r.id)!.status).toBe('transcribe_failed');
  });

  it('still allows failed when the recording is non-terminal', () => {
    const r = freshRecording();
    applyRecordingStatus(r.id, 'recorded');
    expect(applyRecordingStatus(r.id, 'failed')).toBe('failed');
    expect(getRecording(r.id)!.status).toBe('failed');
  });
});
