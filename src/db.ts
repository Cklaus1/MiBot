import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { planJoinRetry, DEFAULT_MEETING_MINUTES, type JoinRetryPlan } from './join-retry.js';
import {
  isTerminalRecordingStatus, TERMINAL_RECORDING_STATUSES, isKnownMeetingStatus,
  legalPredecessorsOf, type RecordingStatus, type MeetingStatus,
} from './status.js';
import { runMigrations } from './migrations.js';

// MIBOT_DB_PATH overrides the DB location (used by the test suite to point each test file
// at an isolated temp DB instead of the shared ~/.config/mibot/mibot.db, which caused
// cross-suite flakiness). Resolved lazily at first getDb() so the env can be set by test
// setup before the connection opens. Production leaves it unset and uses the config dir.
function resolveDbPath(): string {
  return process.env.MIBOT_DB_PATH || path.join(os.homedir(), '.config', 'mibot', 'mibot.db');
}

/** The watcher's single-instance lock lives beside the DB it guards (so each test DB gets its own). */
export function instanceLockPath(): string {
  return path.join(path.dirname(resolveDbPath()), 'watcher.lock');
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
  /** Failed join attempts so far (join retry). */
  join_attempts: number | null;
  /** A retrying meeting isn't joinable before this instant (backoff). */
  next_join_at: string | null;
  /** PID of the process running this meeting's bot; recovery only fails rows whose owner is gone. */
  owner_pid: number | null;
  /** 1 if the calendar says I organized it, 0 if not, null if unknown (onlyOrganized). */
  is_organizer: number | null;
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
  /** Times a crashed transcription has been resumed (Wave 9-B). */
  transcribe_attempts: number | null;
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
  is_organizer?: boolean;
}): Meeting {
  const db = getDb();
  // AR6: stamp heartbeat at insert so a freshly-created meeting is immediately "live".
  // CA3: ON CONFLICT DO NOTHING makes a concurrent insert of the same calendar_event_id
  // (two pollers racing between check and insert) a no-op instead of a thrown constraint
  // error; the loser reads back the winner's row below.
  const stmt = db.prepare(`
    INSERT INTO meetings (title, platform, join_url, start_time, end_time,
      calendar_event_id, organizer, organizer_email, location, description,
      attendees, is_recurring, recurrence_id, heartbeat, is_organizer)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT DO NOTHING
  `);
  const result = stmt.run(
    m.title, m.platform, m.join_url, m.start_time, m.end_time ?? null,
    m.calendar_event_id ?? null, m.organizer ?? null, m.organizer_email ?? null,
    m.location ?? null, m.description ?? null,
    m.attendees ? JSON.stringify(m.attendees) : null,
    m.is_recurring ? 1 : 0, m.recurrence_id ?? null, new Date().toISOString(),
    m.is_organizer === undefined ? null : m.is_organizer ? 1 : 0,
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
  'heartbeat', 'owner_pid', 'is_organizer',
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

  // MEETING_TRANSITIONS was fully specified in status.ts but never consulted: this function
  // validated the column NAME and never the VALUE, so `done -> joining` (rejoining a finished
  // meeting) and a catch-all `-> failed` after `done` both wrote silently. Enforce it as part
  // of the UPDATE's WHERE -- atomic, like applyRecordingStatus, rather than read-then-write.
  // The whole statement is guarded, so an illegal status can't half-apply its sibling columns.
  let where = 'id = ?';
  const desired = updates.status;
  if (desired !== undefined) {
    if (typeof desired !== 'string' || !isKnownMeetingStatus(desired)) {
      console.error(`[mibot] WARN: refused unknown meeting status "${String(desired)}" for id=${id}`);
      return;
    }
    const allowed = legalPredecessorsOf(desired);
    where += ` AND status IN (${allowed.map(() => '?').join(', ')})`;
    vals.push(...allowed);
  }

  const res = db.prepare(`UPDATE meetings SET ${sets.join(', ')} WHERE ${where}`).run(...vals);
  if (res.changes === 0 && desired !== undefined) {
    const current = getMeeting(id)?.status;
    // Distinguish a refused transition from a genuinely stale id -- they need different fixes.
    if (current) {
      console.error(`[mibot] WARN: refused illegal meeting transition ${current} -> ${desired} (id=${id})`);
      return;
    }
  }
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

/** An active row whose bot hasn't proven liveness for 2 minutes (NULL heartbeat → created_at, D3). */
const STALE_WHERE = `
  status IN ('joining', 'in_call', 'processing')
  AND datetime(COALESCE(heartbeat, created_at)) < datetime('now', '-2 minutes')
`;

/** A meeting interrupted mid-transcription: processing, with a recording still 'recorded'. */
const RESUMABLE_TRANSCRIPTION = `
  status = 'processing'
  AND EXISTS (SELECT 1 FROM recordings r WHERE r.meeting_id = meetings.id AND r.status = 'recorded')
`;

export interface TranscriptionJob {
  meetingId: number;
  recordingId: number;
  audioPath: string;
  participants: Participant[];
  speakerTimeline: SpeakerSegment[];
  /** Including this one. */
  attempts: number;
}

/**
 * Wave 9-B: claim transcriptions orphaned by a crash — the meeting is 'processing', its recording
 * 'recorded' (audio on disk, transcription never finished), the heartbeat stale and the owner
 * gone. Claiming stamps this process as owner and refreshes the heartbeat in one transaction, so
 * a row is never claimed twice; the attempt counter bounds a crash-loop.
 */
export function claimOrphanedTranscriptions(
  ownerAlive: (pid: number, meetingId: number) => boolean = defaultOwnerAlive,
): TranscriptionJob[] {
  const db = getDb();
  const claim = db.transaction(() => {
    const rows = db.prepare(`
      SELECT m.id AS meetingId, m.owner_pid, m.participants, m.speaker_timeline,
             r.id AS recordingId, r.audio_path AS audioPath, COALESCE(r.transcribe_attempts, 0) AS prior
      FROM meetings m JOIN recordings r ON r.meeting_id = m.id AND r.status = 'recorded'
      WHERE m.id IN (SELECT id FROM meetings WHERE ${STALE_WHERE} AND ${RESUMABLE_TRANSCRIPTION})
    `).all() as Array<{ meetingId: number; owner_pid: number | null; participants: string | null;
      speaker_timeline: string | null; recordingId: number; audioPath: string; prior: number }>;
    const now = new Date().toISOString();
    const jobs: TranscriptionJob[] = [];
    for (const row of rows) {
      if (row.owner_pid !== null && ownerAlive(row.owner_pid, row.meetingId)) continue;
      db.prepare('UPDATE meetings SET owner_pid = ?, heartbeat = ? WHERE id = ?').run(process.pid, now, row.meetingId);
      db.prepare('UPDATE recordings SET transcribe_attempts = ? WHERE id = ?').run(row.prior + 1, row.recordingId);
      jobs.push({
        meetingId: row.meetingId, recordingId: row.recordingId, audioPath: row.audioPath,
        participants: safeJson(row.participants), speakerTimeline: safeJson(row.speaker_timeline),
        attempts: row.prior + 1,
      });
    }
    return jobs;
  });
  return claim();
}

function safeJson<T>(s: string | null): T[] {
  if (!s) return [];
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; }
}

/** Does a process with this pid exist? EPERM means it exists but isn't ours — still alive. */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Default liveness: another process is judged by its pid; this process's own rows are NOT
 *  vouched for, since only a caller that tracks its running bots (the watcher) can tell a live
 *  bot of ours from one that ended without updating its row. */
const defaultOwnerAlive = (pid: number): boolean => pid !== process.pid && isPidAlive(pid);

/**
 * Fail meetings whose bot has died, and their unfinished recordings.
 *
 * Wave 9-A: a stale heartbeat alone is NOT proof of death. A host suspend longer than the
 * 2-minute threshold (WSL sleep, a closed laptop lid) stalls every timer, so a perfectly live
 * bot looked dead; recovery failed its row, and the transition guard then refused all of the
 * bot's later writes — participants, timeline and actual_end were silently dropped. Now a stale
 * row is only failed when its owning process is gone (or it has no recorded owner — a legacy
 * row). `ownerAlive(pid, meetingId)` lets the watcher vouch precisely for its own in-process bots.
 */
export function recoverStaleMeetings(
  ownerAlive: (pid: number, meetingId: number) => boolean = defaultOwnerAlive,
): number {
  const db = getDb();
  // D3: a NULL heartbeat must NOT mean "instantly stale" — a bot in the waiting room
  // (`joining`) or a legacy row simply hasn't stamped one yet. Fall back to created_at so
  // every active row gets the same 2-minute grace window before being force-failed.
  // D4: fail the orphan recordings of killed meetings in the SAME transaction, without
  // downgrading any recording that already reached a terminal status (C7).
  // Wave 9-B: a meeting that crashed DURING transcription has its audio safely on disk; it's
  // left for claimOrphanedTranscriptions to resume rather than failed here.
  const staleWhere = `${STALE_WHERE} AND NOT (${RESUMABLE_TRANSCRIPTION})`;
  const recover = db.transaction(() => {
    const stale = db.prepare(`SELECT id, owner_pid FROM meetings WHERE ${staleWhere}`)
      .all() as { id: number; owner_pid: number | null }[];
    const dead = stale
      .filter((r) => r.owner_pid === null || !ownerAlive(r.owner_pid, r.id))
      .map((r) => r.id);
    if (dead.length === 0) return 0;
    const ids = dead.map(() => '?').join(', ');
    db.prepare(`
      UPDATE recordings SET status = 'failed'
      WHERE status NOT IN (${TERMINAL_RECORDING_SQL})
        AND meeting_id IN (${ids})
    `).run(...dead);
    // Re-check staleness in the UPDATE itself so a row that heartbeated meanwhile is spared.
    return db.prepare(`UPDATE meetings SET status = 'failed' WHERE id IN (${ids}) AND ${staleWhere}`)
      .run(...dead).changes;
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
      AND ${EFFECTIVE_END_SQL} <= datetime('now')
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

/** The terminal recording statuses, as a SQL literal list, so the C7 "never downgrade a
 *  terminal outcome" rule can be expressed as a WHERE clause instead of a read-then-write. */
const TERMINAL_RECORDING_SQL = TERMINAL_RECORDING_STATUSES.map((s) => `'${s}'`).join(', ');

// ── Reads ─────────────────────────────────────────────────────────────

/**
 * When a meeting is over, in SQL: its end_time, or start + DEFAULT_MEETING_MINUTES without one.
 * Shared by the scheduler and the missed sweep so "joinable" and "missed" can never disagree —
 * they used to share a hardcoded 30-minutes-after-start cutoff, which is also what made a
 * meeting unretryable half an hour in no matter how long it ran.
 */
const EFFECTIVE_END_SQL =
  `datetime(COALESCE(end_time, datetime(start_time, '+${DEFAULT_MEETING_MINUTES} minutes')))`;

export function getUpcomingMeetings(withinMinutes: number): Meeting[] {
  return getDb().prepare(`
    SELECT * FROM meetings
    WHERE status = 'scheduled'
      AND datetime(start_time) <= datetime('now', '+' || ? || ' minutes')
      AND ${EFFECTIVE_END_SQL} > datetime('now')
      AND (next_join_at IS NULL OR datetime(next_join_at) <= datetime('now'))
    ORDER BY start_time
  `).all(withinMinutes) as Meeting[];
}

/**
 * A bot for this meeting threw. Decide (planJoinRetry) whether it was a JOIN failure worth
 * retrying, and apply it: back to 'scheduled' with an attempt counted and a backoff, or 'failed'.
 * The retry write is guarded on status = 'joining' (raw SQL, like cancel/revive): if the row
 * moved on in the meantime, the stale plan is discarded and it's failed through the normal guard.
 */
export function handleJoinFailure(id: number, nowMs: number = Date.now()): JoinRetryPlan {
  const row = getMeeting(id);
  if (!row) return { retry: false, reason: 'not-a-join-failure' };
  const plan = planJoinRetry(row, nowMs);
  if (plan.retry) {
    const res = getDb().prepare(
      `UPDATE meetings
         SET status = 'scheduled', join_attempts = COALESCE(join_attempts, 0) + 1,
             next_join_at = ?, heartbeat = ?
       WHERE id = ? AND status = 'joining'`,
    ).run(plan.nextJoinAt, new Date(nowMs).toISOString(), id);
    if (res.changes > 0) return plan;
  }
  updateMeetingStatus(id, 'failed');
  return plan.retry ? { retry: false, reason: 'not-a-join-failure' } : plan;
}

export function getMeetingByEventId(eventId: string): Meeting | undefined {
  return getDb().prepare('SELECT * FROM meetings WHERE calendar_event_id = ?').get(eventId) as Meeting | undefined;
}

/**
 * CA4: cross-provider dedup key. The same meeting synced from both M365 and Google carries two
 * different calendar_event_ids, so the eventId dedup and the D6 UNIQUE index can't see the
 * collision. Match on join_url + start_time (compared as datetimes so equivalent ISO spellings
 * still match) to find the already-inserted copy before creating a duplicate row.
 */
export function getMeetingByJoinUrlAndTime(joinUrl: string, startTime: string): Meeting | undefined {
  return getDb().prepare(
    'SELECT * FROM meetings WHERE join_url = ? AND datetime(start_time) = datetime(?) ORDER BY id LIMIT 1',
  ).get(joinUrl, startTime) as Meeting | undefined;
}

export function getMeeting(id: number): Meeting | undefined {
  return getDb().prepare('SELECT * FROM meetings WHERE id = ?').get(id) as Meeting | undefined;
}

/**
 * CA2: the still-schedulable calendar_event_ids for one provider (by id prefix, e.g. 'm365:').
 * These are the rows the reconciler compares against the current sync window — any that no
 * longer appear in the window is a cancellation candidate. Only 'scheduled' rows qualify: a
 * meeting already joining/in_call/done must not be retroactively cancelled.
 */
export function getScheduledEventIds(prefix: string): string[] {
  const rows = getDb().prepare(
    `SELECT calendar_event_id FROM meetings
     WHERE status = 'scheduled' AND calendar_event_id LIKE ? || '%'`,
  ).all(prefix) as { calendar_event_id: string }[];
  return rows.map((r) => r.calendar_event_id);
}

/** CA2: mark a still-scheduled meeting cancelled (organizer removed it before it started).
 *  Guarded on status='scheduled' so a race with join can't cancel a live meeting. */
export function cancelMeeting(eventId: string): boolean {
  const res = getDb().prepare(
    `UPDATE meetings SET status = 'cancelled', heartbeat = ?
     WHERE calendar_event_id = ? AND status = 'scheduled'`,
  ).run(new Date().toISOString(), eventId);
  return res.changes > 0;
}

/**
 * Fix 3: the inverse of cancelMeeting. The CA2 step cancels any scheduled row whose event id is
 * missing from a sync, but absence isn't proof of deletion — the event may have moved beyond the
 * 24h window or landed on an unread page. When the id comes back, the event demonstrably still
 * exists, so return it to 'scheduled' with its current fields. Guarded on status = 'cancelled'
 * (raw SQL, like cancelMeeting) so it can never resurrect a done/failed/missed meeting; the
 * general transition table deliberately keeps 'cancelled' terminal for every other writer.
 */
export function reviveCancelledMeeting(
  id: number,
  fields: { start_time?: string; end_time?: string | null; join_url?: string; title?: string },
): boolean {
  const sets = ["status = 'scheduled'", 'heartbeat = ?'];
  const vals: unknown[] = [new Date().toISOString()];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || !MEETING_COLUMNS.has(k)) continue;
    sets.push(`${k} = ?`);
    vals.push(v);
  }
  vals.push(id);
  const res = getDb().prepare(
    `UPDATE meetings SET ${sets.join(', ')} WHERE id = ? AND status = 'cancelled'`,
  ).run(...vals);
  return res.changes > 0;
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
  // The guard lives IN the UPDATE. It used to be a SELECT followed by a separate UPDATE with
  // no transaction between them — so the C7 invariant only held if nothing wrote in the gap,
  // and this is called from a shutdown hook concurrently with the normal completion path.
  // A single conditional statement makes the choke point actually atomic.
  const res = getDb().prepare(
    `UPDATE recordings SET status = ?
     WHERE id = ? AND status NOT IN (${TERMINAL_RECORDING_SQL})`,
  ).run(desired, id);
  if (res.changes > 0) return desired;
  // No row changed: either the row is already terminal (return what's actually persisted) or
  // the id is stale (nothing to reconcile — report the caller's intent).
  return (getRecording(id)?.status as RecordingStatus | undefined) ?? desired;
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
