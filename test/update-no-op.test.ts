import { describe, it, expect, afterAll, vi } from 'vitest';
import {
  getDb, closeDb, insertMeeting, insertRecording,
  updateMeeting, updateRecording,
} from '../src/db.js';

// D8 P3: update* helpers ignored result.changes, so an update targeting a stale/wrong id was
// a SILENT no-op — a status that never actually persisted looked successful. Fix: warn (never
// throw — a warning must not abort a poll) when an UPDATE matches zero rows.
describe('update no-op warning (D8)', () => {
  afterAll(() => closeDb());

  it('warns when updateMeeting matches no rows', () => {
    getDb();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    updateMeeting(999999, { status: 'done' });
    expect(spy).toHaveBeenCalled();
    const msg = spy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(msg.toLowerCase()).toContain('999999');
    spy.mockRestore();
  });

  it('does NOT warn when updateMeeting matches a real row', () => {
    const m = insertMeeting({
      title: 'ok', platform: 'teams',
      join_url: 'https://x', start_time: new Date().toISOString(),
    });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    updateMeeting(m.id, { status: 'in_call' });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('warns when updateRecording matches no rows', () => {
    getDb();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    updateRecording(888888, { status: 'done' });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('does NOT throw on a no-op update (poll must survive)', () => {
    getDb();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => updateMeeting(777777, { status: 'failed' })).not.toThrow();
    spy.mockRestore();
  });
});
