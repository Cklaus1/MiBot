import { describe, it, expect, afterAll } from 'vitest';
import {
  getDb, closeDb, insertMeeting, insertRecording, getRecording,
  applyRecordingStatus, updateMeetingStatus, recoverStaleMeetings,
} from '../src/db.js';

// D4 P2: recoverStaleMeetings flips a dead bot's meeting to `failed` but used to leave its
// recordings row stuck at `recording` forever (orphan). Fix: in the SAME transaction, fail
// the non-terminal recordings of any meeting it kills — without downgrading a recording
// that already reached a terminal status (C7: done / transcribe_failed / no_audio).
describe('recoverStaleMeetings orphan recordings (D4)', () => {
  afterAll(() => closeDb());

  const staleMeetingWithRecording = (recStatus?: string) => {
    getDb();
    const m = insertMeeting({
      title: 'orphan', platform: 'teams',
      join_url: 'https://teams.microsoft.com/x', start_time: new Date().toISOString(),
    });
    updateMeetingStatus(m.id, 'in_call');
    const r = insertRecording({ meeting_id: m.id, audio_path: '/tmp/o.webm' });
    if (recStatus) applyRecordingStatus(r.id, recStatus as any);
    // Force the meeting stale so recover kills it.
    getDb().prepare('UPDATE meetings SET heartbeat = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', m.id);
    return { m, r };
  };

  it('fails the non-terminal recording of a killed meeting', () => {
    const { r } = staleMeetingWithRecording(); // default status 'recording'
    recoverStaleMeetings();
    expect(getRecording(r.id)!.status).toBe('failed');
  });

  it('does NOT downgrade a recording that already reached done (C7)', () => {
    const { r } = staleMeetingWithRecording('done');
    recoverStaleMeetings();
    expect(getRecording(r.id)!.status).toBe('done');
  });

  it('does NOT downgrade a terminal transcribe_failed recording (C7)', () => {
    const { r } = staleMeetingWithRecording('transcribe_failed');
    recoverStaleMeetings();
    expect(getRecording(r.id)!.status).toBe('transcribe_failed');
  });

  it('leaves recordings of live meetings untouched', () => {
    getDb();
    const m = insertMeeting({
      title: 'live', platform: 'zoom',
      join_url: 'https://zoom/x', start_time: new Date().toISOString(),
    });
    updateMeetingStatus(m.id, 'in_call'); // fresh heartbeat
    const r = insertRecording({ meeting_id: m.id, audio_path: '/tmp/live.webm' });
    recoverStaleMeetings();
    expect(getRecording(r.id)!.status).toBe('recording');
  });
});
