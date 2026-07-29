import { describe, it, expect, afterAll } from 'vitest';
import {
  getDb, closeDb, insertMeeting, getMeeting,
  updateMeetingStatus, recoverStaleMeetings,
} from '../src/db.js';

// F6/AR6: heartbeat is the single source of liveness truth. It must be stamped in the
// SAME statement as every status transition (and at insert), so recoverStaleMeetings
// never false-kills a meeting that just transitioned, and there is no "which statuses
// carry a heartbeat?" ambiguity.
describe('heartbeat-as-liveness (F6/AR6)', () => {
  afterAll(() => closeDb());

  const mk = () => {
    getDb();
    return insertMeeting({
      title: 'hb', platform: 'teams',
      join_url: 'https://teams.microsoft.com/x', start_time: new Date().toISOString(),
    });
  };

  it('stamps a heartbeat on insert', () => {
    const m = mk();
    expect(getMeeting(m.id)!.heartbeat).toBeTruthy();
  });

  it('updates the heartbeat on every status transition (same statement)', () => {
    const m = mk();
    // force an old heartbeat, then transition
    getDb().prepare('UPDATE meetings SET heartbeat = ? WHERE id = ?')
      .run('2000-01-01T00:00:00.000Z', m.id);
    updateMeetingStatus(m.id, 'in_call');
    const after = getMeeting(m.id)!;
    expect(after.status).toBe('in_call');
    // heartbeat must have moved forward past the ancient value
    expect(new Date(after.heartbeat!).getTime()).toBeGreaterThan(new Date('2000-01-01').getTime());
  });

  it('recoverStaleMeetings does NOT kill a meeting that just transitioned', () => {
    const m = mk();
    updateMeetingStatus(m.id, 'in_call'); // fresh heartbeat via same statement
    recoverStaleMeetings();
    expect(getMeeting(m.id)!.status).toBe('in_call');
  });

  it('recoverStaleMeetings DOES kill a meeting whose heartbeat went stale', () => {
    const m = mk();
    updateMeetingStatus(m.id, 'in_call');
    getDb().prepare('UPDATE meetings SET heartbeat = ? WHERE id = ?')
      .run('2000-01-01T00:00:00.000Z', m.id);
    const killed = recoverStaleMeetings();
    expect(killed).toBeGreaterThanOrEqual(1);
    expect(getMeeting(m.id)!.status).toBe('failed');
  });
});
