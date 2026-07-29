import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { isTerminalRecordingStatus, type RecordingStatus } from './status.js';
import { runMigrations } from './migrations.js';

// MIBOT_DB_PATH overrides the DB location (used by the test suite to point each test file
// at an isolated temp DB instead of the shared ~/.config/mibot/mibot.db, which caused
// cross-suite flakiness). Resolved lazily at first getDb() so the env can be set by test
// setup before the connection opens. Production leaves it unset and uses the config dir.
function resolveDbPath(): string {
  return process.env.MIBOT_DB_PATH || path.join(os.homedir(), '.config', 'mibot', 'mibot.db');
}

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  const dbPath = resolveDbPath();
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true, mode: 0o700 });
  }

  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');

  // Schema is owned by the versioned migration runner (F2), keyed on user_version.
  runMigrations(_db);

  return _db;
}

export function closeDb(): void {
  if (_db) { _db.close(); _db = null; }
}

export function transaction<T>(fn: () => T): T {
  const db = getDb();
  return db.transaction(fn)();
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
  heartbeat: string | null;
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
  // AR6: stamp heartbeat at insert so a freshly-created meeting is immediately "live".
  // CA3: ON CONFLICT DO NOTHING makes a concurrent insert of the same calendar_event_id
  // (two pollers racing between check and insert) a no-op instead of a thrown constraint
  // error; the loser reads back the winner's row below.
  const stmt = db.prepare(`
    INSERT INTO meetings (title, platform, join_url, start_time, end_time,
      calendar_event_id, organizer, organizer_email, location, description,
      attendees, is_recurring, recurrence_id, heartbeat)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT DO NOTHING
  `);
  const result = stmt.run(
    m.title, m.platform, m.join_url, m.start_time, m.end_time ?? null,
    m.calendar_event_id ?? null, m.organizer ?? null, m.organizer_email ?? null,
    m.location ?? null, m.description ?? null,
    m.attendees ? JSON.stringify(m.attendees) : null,
    m.is_recurring ? 1 : 0, m.recurrence_id ?? null, new Date().toISOString(),
  );
  if (result.changes === 0 && m.calendar_event_id) {
    // A concurrent insert won the race; return the existing row rather than a null lookup.
    return getMeetingByEventId(m.calendar_event_id)!;
  }
  return db.prepare('SELECT * FROM meetings WHERE id = ?').get(result.lastInsertRowid) as Meeting;
}

/**
 * Get-or-create keyed by calendar_event_id (C19). The scheduler pre-inserts a `scheduled`
 * row; joinAndRecord must reuse it rather than inserting a duplicate on every (re)join.
 * Meetings with no event id (manual joins) always insert — they have no dedup key.
 */
export function getOrCreateMeeting(m: Parameters<typeof insertMeeting>[0]): Meeting {
  if (m.calendar_event_id) {
    const existing = getMeetingByEventId(m.calendar_event_id);
    if (existing) return existing;
  }
  return insertMeeting(m);
}

const MEETING_COLUMNS = new Set([
  'title', 'platform', 'join_url', 'start_time', 'end_time', 'actual_start', 'actual_end',
  'calendar_event_id', 'organizer', 'organizer_email', 'location', 'description',
  'attendees', 'is_recurring', 'recurrence_id', 'status', 'participants', 'speaker_timeline',
  'heartbeat',
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
  // AR6: every meeting-row write refreshes the heartbeat in the SAME statement, so any
  // status transition atomically proves liveness. Skip only if the caller set it itself.
  if (!('heartbeat' in updates)) {
    sets.push('heartbeat = ?');
    vals.push(new Date().toISOString());
  }
  vals.push(id);
  const res = db.prepare(`UPDATE meetings SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  warnIfNoOp('meetings', id, res.changes);
}

/** D8: an UPDATE that matches no rows (stale/wrong id) is a silent no-op that hides a real
 *  bug — warn, but never throw: a DB warning must not abort the watcher poll. */
function warnIfNoOp(table: string, id: number, changes: number): void {
  if (changes === 0) console.error(`[mibot] WARN: update on ${table} id=${id} changed no rows (stale id?)`);
}

export function updateMeetingStatus(id: number, status: string): void {
  updateMeeting(id, { status });
}

export function updateMeetingParticipants(id: number, participants: Participant[]): void {
  updateMeeting(id, { participants: JSON.stringify(participants) });
}

export function updateHeartbeat(id: number): void {
  getDb().prepare('UPDATE meetings SET heartbeat = ? WHERE id = ?').run(new Date().toISOString(), id);
}

export function recoverStaleMeetings(): number {
  const db = getDb();
  // D3: a NULL heartbeat must NOT mean "instantly stale" — a bot in the waiting room
  // (`joining`) or a legacy row simply hasn't stamped one yet. Fall back to created_at so
  // every active row gets the same 2-minute grace window before being force-failed.
  // D4: fail the orphan recordings of killed meetings in the SAME transaction, without
  // downgrading any recording that already reached a terminal status (C7).
  const staleWhere = `
    status IN ('joining', 'in_call', 'processing')
    AND datetime(COALESCE(heartbeat, created_at)) < datetime('now', '-2 minutes')
  `;
  const recover = db.transaction(() => {
    db.prepare(`
      UPDATE recordings SET status = 'failed'
      WHERE status NOT IN ('done', 'transcribe_failed', 'no_audio', 'failed')
        AND meeting_id IN (SELECT id FROM meetings WHERE ${staleWhere})
    `).run();
    return db.prepare(`UPDATE meetings SET status = 'failed' WHERE ${staleWhere}`).run().changes;
  });
  return recover();
}

/**
 * D7: mark overdue `scheduled` meetings as `missed`. getUpcomingMeetings only sees rows
 * whose start_time is within [now-30min, now+window]; a meeting whose window lapsed (watcher
 * was down 31+ min) would otherwise sit `scheduled` forever and the table would grow without
 * bound. Uses the same 30-minute grace as the upcoming lower bound so the two never disagree.
 */
export function sweepMissedMeetings(): number {
  const db = getDb();
  return db.prepare(`
    UPDATE meetings SET status = 'missed'
    WHERE status = 'scheduled'
      AND datetime(start_time) < datetime('now', '-30 minutes')
  `).run().changes;
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
  const res = db.prepare(`UPDATE recordings SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  warnIfNoOp('recordings', id, res.changes);
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

export function getRecording(id: number): Recording | undefined {
  return getDb().prepare('SELECT * FROM recordings WHERE id = ?').get(id) as Recording | undefined;
}

/**
 * The single choke point for recording-status writes (C7/T1). Reconciles the
 * desired status against what's already persisted so terminal outcomes are never
 * clobbered: once a recording is done / transcribe_failed / no_audio / failed, a
 * later write (a stale 'done' after transcribe, or a catch-all 'failed') is ignored.
 * Returns the status that ended up persisted.
 */
export function applyRecordingStatus(id: number, desired: RecordingStatus): RecordingStatus {
  const current = getRecording(id)?.status as RecordingStatus | undefined;
  const next = current && isTerminalRecordingStatus(current) ? current : desired;
  if (next !== current) updateRecording(id, { status: next });
  return next;
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
