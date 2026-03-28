import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getDb, closeDb, insertMeeting, getMeeting, updateMeeting, listMeetings, getUpcomingMeetings } from '../src/db.js';

describe('Database', () => {
  beforeAll(() => {
    // getDb() creates the database and tables on first call
    const db = getDb();
    expect(db).toBeDefined();
  });

  afterAll(() => {
    closeDb();
  });

  it('inserts and retrieves a meeting', () => {
    const meeting = insertMeeting({
      title: 'Test Meeting',
      platform: 'teams',
      join_url: 'https://teams.microsoft.com/test',
      start_time: new Date().toISOString(),
    });
    expect(meeting.id).toBeGreaterThan(0);
    expect(meeting.title).toBe('Test Meeting');
    expect(meeting.platform).toBe('teams');
    expect(meeting.status).toBe('scheduled');

    const retrieved = getMeeting(meeting.id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.title).toBe('Test Meeting');
  });

  it('updates meeting status', () => {
    const meeting = insertMeeting({
      title: 'Status Test',
      platform: 'zoom',
      join_url: 'https://zoom.us/j/123',
      start_time: new Date().toISOString(),
    });
    updateMeeting(meeting.id, { status: 'in_call' });
    const updated = getMeeting(meeting.id);
    expect(updated!.status).toBe('in_call');
  });

  it('rejects invalid column names', () => {
    const meeting = insertMeeting({
      title: 'SQL Injection Test',
      platform: 'teams',
      join_url: 'https://teams.microsoft.com/test',
      start_time: new Date().toISOString(),
    });
    expect(() => {
      updateMeeting(meeting.id, { 'status; DROP TABLE meetings; --': 'hacked' } as any);
    }).toThrow('Invalid column');
  });

  it('lists meetings', () => {
    const meetings = listMeetings(100);
    expect(meetings.length).toBeGreaterThan(0);
  });
});
