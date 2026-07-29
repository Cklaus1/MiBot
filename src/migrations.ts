// migrations.ts — versioned schema migrations keyed on PRAGMA user_version (F2, AD6/AQ3).
//
// Replaces the ad-hoc "CREATE TABLE IF NOT EXISTS + probe-and-ALTER" block that ran on
// every getDb(). Each migration bumps user_version by exactly one; the runner applies
// only those numbered above the DB's current version, inside a transaction. A fresh DB
// and a legacy DB (baseline tables present, user_version still 0) converge to the same
// schema because every step is written to be idempotent (IF NOT EXISTS / column probes).

import type Database from 'better-sqlite3';

export interface Migration {
  version: number;
  name: string;
  up: (db: Database.Database) => void;
}

/** Add a column only if it isn't already present (legacy-DB safe). */
function addColumnIfMissing(db: Database.Database, table: string, col: string, decl: string): void {
  const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as any[]).map((c) => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'baseline schema',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS meetings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          platform TEXT NOT NULL,
          join_url TEXT NOT NULL,
          start_time TEXT NOT NULL,
          end_time TEXT,
          actual_start TEXT,
          actual_end TEXT,
          calendar_event_id TEXT,
          organizer TEXT,
          organizer_email TEXT,
          location TEXT,
          description TEXT,
          attendees TEXT,
          is_recurring INTEGER DEFAULT 0,
          recurrence_id TEXT,
          status TEXT NOT NULL DEFAULT 'scheduled',
          participants TEXT,
          speaker_timeline TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS recordings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          meeting_id INTEGER NOT NULL REFERENCES meetings(id),
          audio_path TEXT NOT NULL,
          transcript_path TEXT,
          metadata_path TEXT,
          duration_seconds INTEGER,
          status TEXT NOT NULL DEFAULT 'recording',
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_meetings_start ON meetings(start_time);
        CREATE INDEX IF NOT EXISTS idx_meetings_status ON meetings(status);
        CREATE INDEX IF NOT EXISTS idx_recordings_meeting ON recordings(meeting_id);
      `);
    },
  },
  {
    version: 2,
    name: 'calendar/runtime columns + heartbeat (legacy backfill)',
    up: (db) => {
      const meetingCols: Record<string, string> = {
        end_time: 'TEXT', calendar_event_id: 'TEXT',
        organizer: 'TEXT', organizer_email: 'TEXT', location: 'TEXT', description: 'TEXT',
        attendees: 'TEXT', is_recurring: 'INTEGER DEFAULT 0', recurrence_id: 'TEXT',
        participants: 'TEXT', speaker_timeline: 'TEXT', actual_start: 'TEXT', actual_end: 'TEXT',
        heartbeat: 'TEXT',
      };
      for (const [col, decl] of Object.entries(meetingCols)) {
        addColumnIfMissing(db, 'meetings', col, decl);
      }
      addColumnIfMissing(db, 'recordings', 'metadata_path', 'TEXT');
    },
  },
  {
    version: 3,
    name: 'dedupe calendar_event_id + partial unique index (D6)',
    up: (db) => {
      // Collapse any pre-C19 duplicate rows before the unique index can be created.
      // For each event id with >1 row, keep the lowest id, re-point child recordings
      // to it, then delete the losers. Runs inside the caller's migration transaction.
      db.exec(`
        UPDATE recordings SET meeting_id = (
          SELECT MIN(m2.id) FROM meetings m1
          JOIN meetings m2 ON m2.calendar_event_id = m1.calendar_event_id
          WHERE m1.id = recordings.meeting_id AND m1.calendar_event_id IS NOT NULL
        )
        WHERE meeting_id IN (
          SELECT m.id FROM meetings m
          WHERE m.calendar_event_id IS NOT NULL
            AND m.id > (SELECT MIN(m3.id) FROM meetings m3 WHERE m3.calendar_event_id = m.calendar_event_id)
        );

        DELETE FROM meetings WHERE id IN (
          SELECT m.id FROM meetings m
          WHERE m.calendar_event_id IS NOT NULL
            AND m.id > (SELECT MIN(m3.id) FROM meetings m3 WHERE m3.calendar_event_id = m.calendar_event_id)
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_meetings_event_uniq
          ON meetings(calendar_event_id) WHERE calendar_event_id IS NOT NULL;
      `);
    },
  },
];

/**
 * Apply every migration whose version is above the DB's current user_version, in order,
 * each in its own transaction, bumping user_version as it goes. Returns the final version.
 */
export function runMigrations(db: Database.Database): number {
  let current = db.pragma('user_version', { simple: true }) as number;
  const pending = MIGRATIONS.filter((m) => m.version > current).sort((a, b) => a.version - b.version);

  for (const migration of pending) {
    db.transaction(() => {
      migration.up(db);
      // user_version can't be parameterized; version is an integer literal we control.
      db.pragma(`user_version = ${migration.version}`);
    })();
    current = migration.version;
  }

  return current;
}
