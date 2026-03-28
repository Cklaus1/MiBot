import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import fs from 'fs';

const DB_DIR = path.join(os.homedir(), '.config', 'mibot');
const DB_PATH = path.join(DB_DIR, 'mibot.db');

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true, mode: 0o700 });
  }

  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');

  _db.exec(`
    CREATE TABLE IF NOT EXISTS meetings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      platform TEXT NOT NULL,
      join_url TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT,
      actual_start TEXT,
      actual_end TEXT,

      -- Calendar metadata
      calendar_event_id TEXT,
      organizer TEXT,
      organizer_email TEXT,
      location TEXT,
      description TEXT,
      attendees TEXT,           -- JSON array: [{name, email, status}]
      is_recurring INTEGER DEFAULT 0,
      recurrence_id TEXT,

      -- Runtime state
      status TEXT NOT NULL DEFAULT 'scheduled',
      participants TEXT,        -- JSON array: [{name, joined_at, left_at, is_bot, spoke}]
      speaker_timeline TEXT,    -- JSON array: [{speaker, start, end}]
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS recordings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id INTEGER NOT NULL REFERENCES meetings(id),
      audio_path TEXT NOT NULL,
      transcript_path TEXT,
      metadata_path TEXT,       -- JSON sidecar with full context
      duration_seconds INTEGER,
      status TEXT NOT NULL DEFAULT 'recording',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_meetings_start ON meetings(start_time);
    CREATE INDEX IF NOT EXISTS idx_meetings_status ON meetings(status);
    CREATE INDEX IF NOT EXISTS idx_recordings_meeting ON recordings(meeting_id);
  `);

  // Migrate: add columns if they don't exist (safe for existing databases)
  const cols = _db.prepare("PRAGMA table_info(meetings)").all().map((c: any) => c.name);
  const newCols: Record<string, string> = {
    organizer: 'TEXT', organizer_email: 'TEXT', location: 'TEXT', description: 'TEXT',
    attendees: 'TEXT', is_recurring: 'INTEGER DEFAULT 0', recurrence_id: 'TEXT',
    participants: 'TEXT', speaker_timeline: 'TEXT', actual_start: 'TEXT', actual_end: 'TEXT',
  };
  for (const [col, type] of Object.entries(newCols)) {
    if (!cols.includes(col)) {
      _db.exec(`ALTER TABLE meetings ADD COLUMN ${col} ${type}`);
    }
  }
  const recCols = _db.prepare("PRAGMA table_info(recordings)").all().map((c: any) => c.name);
  if (!recCols.includes('metadata_path')) {
    _db.exec('ALTER TABLE recordings ADD COLUMN metadata_path TEXT');
  }

  return _db;
}

export function closeDb(): void {
  if (_db) { _db.close(); _db = null; }
}

// ── Types ─────────────────────────────────────────────────────────────

export interface Attendee {
  name: string;
  email: string;
  status: string;     // accepted, tentative, declined, none
}

export interface Participant {
  name: string;
  joined_at: string;
  left_at: string | null;
  is_bot: boolean;
  spoke: boolean;
}

export interface SpeakerSegment {
  speaker: string;
  start: string;       // ISO timestamp
  end: string | null;   // null = still speaking
}

export interface Meeting {
  id: number;
  title: string;
  platform: string;
  join_url: string;
  start_time: string;
  end_time: string | null;
  actual_start: string | null;
  actual_end: string | null;
  calendar_event_id: string | null;
  organizer: string | null;
  organizer_email: string | null;
  location: string | null;
  description: string | null;
  attendees: string | null;      // JSON
  is_recurring: number;
  recurrence_id: string | null;
  participants: string | null;   // JSON
  speaker_timeline: string | null; // JSON
  status: string;
  created_at: string;
}

export interface Recording {
  id: number;
  meeting_id: number;
  audio_path: string;
  transcript_path: string | null;
  metadata_path: string | null;
  duration_seconds: number | null;
  status: string;
  created_at: string;
}

// ── Writes ────────────────────────────────────────────────────────────

export function insertMeeting(m: {
  title: string;
  platform: string;
  join_url: string;
  start_time: string;
  end_time?: string;
  calendar_event_id?: string;
  organizer?: string;
  organizer_email?: string;
  location?: string;
  description?: string;
  attendees?: Attendee[];
  is_recurring?: boolean;
  recurrence_id?: string;
}): Meeting {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO meetings (title, platform, join_url, start_time, end_time,
      calendar_event_id, organizer, organizer_email, location, description,
      attendees, is_recurring, recurrence_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    m.title, m.platform, m.join_url, m.start_time, m.end_time ?? null,
    m.calendar_event_id ?? null, m.organizer ?? null, m.organizer_email ?? null,
    m.location ?? null, m.description ?? null,
    m.attendees ? JSON.stringify(m.attendees) : null,
    m.is_recurring ? 1 : 0, m.recurrence_id ?? null,
  );
  return db.prepare('SELECT * FROM meetings WHERE id = ?').get(result.lastInsertRowid) as Meeting;
}

const MEETING_COLUMNS = new Set([
  'title', 'platform', 'join_url', 'start_time', 'end_time', 'actual_start', 'actual_end',
  'calendar_event_id', 'organizer', 'organizer_email', 'location', 'description',
  'attendees', 'is_recurring', 'recurrence_id', 'status', 'participants', 'speaker_timeline',
]);

export function updateMeeting(id: number, updates: Record<string, unknown>): void {
  const db = getDb();
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [key, val] of Object.entries(updates)) {
    if (!MEETING_COLUMNS.has(key)) throw new Error(`Invalid column: ${key}`);
    sets.push(`${key} = ?`);
    vals.push(val);
  }
  if (sets.length === 0) return;
  vals.push(id);
  db.prepare(`UPDATE meetings SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

export function updateMeetingStatus(id: number, status: string): void {
  updateMeeting(id, { status });
}

export function updateMeetingParticipants(id: number, participants: Participant[]): void {
  updateMeeting(id, { participants: JSON.stringify(participants) });
}

export function insertRecording(r: { meeting_id: number; audio_path: string }): Recording {
  const db = getDb();
  const stmt = db.prepare('INSERT INTO recordings (meeting_id, audio_path) VALUES (?, ?)');
  const result = stmt.run(r.meeting_id, r.audio_path);
  return db.prepare('SELECT * FROM recordings WHERE id = ?').get(result.lastInsertRowid) as Recording;
}

export function updateRecording(id: number, updates: {
  transcript_path?: string;
  metadata_path?: string;
  duration_seconds?: number;
  status?: string;
}): void {
  const db = getDb();
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (updates.transcript_path !== undefined) { sets.push('transcript_path = ?'); vals.push(updates.transcript_path); }
  if (updates.metadata_path !== undefined) { sets.push('metadata_path = ?'); vals.push(updates.metadata_path); }
  if (updates.duration_seconds !== undefined) { sets.push('duration_seconds = ?'); vals.push(updates.duration_seconds); }
  if (updates.status !== undefined) { sets.push('status = ?'); vals.push(updates.status); }
  if (sets.length === 0) return;
  vals.push(id);
  db.prepare(`UPDATE recordings SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

// ── Reads ─────────────────────────────────────────────────────────────

export function getUpcomingMeetings(withinMinutes: number): Meeting[] {
  return getDb().prepare(`
    SELECT * FROM meetings
    WHERE status = 'scheduled'
      AND datetime(start_time) <= datetime('now', '+' || ? || ' minutes')
      AND datetime(start_time) >= datetime('now', '-30 minutes')
    ORDER BY start_time
  `).all(withinMinutes) as Meeting[];
}

export function getMeetingByEventId(eventId: string): Meeting | undefined {
  return getDb().prepare('SELECT * FROM meetings WHERE calendar_event_id = ?').get(eventId) as Meeting | undefined;
}

export function getMeeting(id: number): Meeting | undefined {
  return getDb().prepare('SELECT * FROM meetings WHERE id = ?').get(id) as Meeting | undefined;
}

export function listMeetings(limit = 20): Meeting[] {
  return getDb().prepare('SELECT * FROM meetings ORDER BY start_time DESC LIMIT ?').all(limit) as Meeting[];
}

export function listRecordings(limit = 20): (Recording & { title: string; platform: string })[] {
  return getDb().prepare(`
    SELECT r.*, m.title, m.platform
    FROM recordings r JOIN meetings m ON r.meeting_id = m.id
    ORDER BY r.created_at DESC LIMIT ?
  `).all(limit) as (Recording & { title: string; platform: string })[];
}

export function getRecordingWithMeeting(id: number): (Recording & Meeting) | undefined {
  return getDb().prepare(`
    SELECT r.*, m.title, m.platform, m.organizer, m.organizer_email,
      m.location, m.attendees, m.participants, m.start_time, m.end_time,
      m.actual_start, m.actual_end
    FROM recordings r JOIN meetings m ON r.meeting_id = m.id
    WHERE r.id = ?
  `).get(id) as (Recording & Meeting) | undefined;
}
