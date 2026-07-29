import { describe, it, expect, afterAll } from 'vitest';
import { getDb, closeDb, insertMeeting, getMeeting, updateMeetingStatus, recoverStaleMeetings } from '../src/db.js';

// D3 P1: recoverStaleMeetings used `heartbeat IS NULL OR heartbeat < now-2min`, treating a
// NULL heartbeat as INSTANTLY stale. A freshly-inserted `joining` row (bot still in the
// waiting room) or a legacy row with no heartbeat was force-marked `failed` on the very
// next watcher poll. Fix: fall back to created_at when heartbeat is NULL, so a brand-new
// row gets the same 2-minute grace window instead of an instant kill.
describe('recoverStaleMeetings NULL-heartbeat grace (D3)', () => {
  afterAll(() => closeDb());

  const mk = () => {
    getDb();
    return insertMeeting({
      title: 'd3', platform: 'teams',
      join_url: 'https://teams.microsoft.com/x', start_time: new Date().toISOString(),
    });
  };

  it('does NOT kill a fresh joining row whose heartbeat is NULL (recent created_at)', () => {
    const m = mk();
    updateMeetingStatus(m.id, 'joining');
    // Simulate a row with no heartbeat but just created.
    getDb().prepare('UPDATE meetings SET heartbeat = NULL WHERE id = ?').run(m.id);
    recoverStaleMeetings();
    expect(getMeeting(m.id)!.status).toBe('joining');
  });

  it('DOES kill a row with NULL heartbeat AND old created_at', () => {
    const m = mk();
    updateMeetingStatus(m.id, 'in_call');
    getDb().prepare("UPDATE meetings SET heartbeat = NULL, created_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(m.id);
    const killed = recoverStaleMeetings();
    expect(killed).toBeGreaterThanOrEqual(1);
    expect(getMeeting(m.id)!.status).toBe('failed');
  });

  it('does NOT kill a processing row whose heartbeat is kept fresh (long transcription)', () => {
    const m = mk();
    updateMeetingStatus(m.id, 'processing'); // same-statement stamps a fresh heartbeat
    recoverStaleMeetings();
    expect(getMeeting(m.id)!.status).toBe('processing');
  });

  it('DOES kill a processing row whose heartbeat went stale (interval died)', () => {
    const m = mk();
    updateMeetingStatus(m.id, 'processing');
    getDb().prepare('UPDATE meetings SET heartbeat = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', m.id);
    recoverStaleMeetings();
    expect(getMeeting(m.id)!.status).toBe('failed');
  });
});
