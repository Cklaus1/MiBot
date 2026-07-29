import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations, MIGRATIONS } from '../src/migrations.js';

// F2 (AD6/AQ3): a versioned migration runner keyed on PRAGMA user_version.
// Migrations are ordered, idempotent, and converge a fresh DB and a legacy DB
// (schema present, user_version still 0) to the same final schema.
const userVersion = (db: Database.Database): number =>
  (db.pragma('user_version', { simple: true }) as number);

const tableCols = (db: Database.Database, table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as any[]).map((c) => c.name);

describe('migration runner (F2)', () => {
  it('brings a fresh DB up to the latest version', () => {
    const db = new Database(':memory:');
    expect(userVersion(db)).toBe(0);
    const final = runMigrations(db);
    const latest = Math.max(...MIGRATIONS.map((m) => m.version));
    expect(final).toBe(latest);
    expect(userVersion(db)).toBe(latest);
    // core tables exist
    expect(tableCols(db, 'meetings')).toContain('status');
    expect(tableCols(db, 'recordings')).toContain('audio_path');
  });

  it('is idempotent — running twice is a no-op the second time', () => {
    const db = new Database(':memory:');
    const first = runMigrations(db);
    const second = runMigrations(db);
    expect(second).toBe(first);
    expect(userVersion(db)).toBe(first);
  });

  it('upgrades a legacy DB (tables present, user_version 0) without loss', () => {
    const db = new Database(':memory:');
    // Simulate a pre-migration-runner DB: baseline tables exist, version still 0.
    db.exec(`
      CREATE TABLE meetings (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
        platform TEXT NOT NULL, join_url TEXT NOT NULL, start_time TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'scheduled', created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE recordings (id INTEGER PRIMARY KEY AUTOINCREMENT,
        meeting_id INTEGER NOT NULL REFERENCES meetings(id), audio_path TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'recording', created_at TEXT NOT NULL DEFAULT (datetime('now')));
    `);
    db.prepare("INSERT INTO meetings (title, platform, join_url, start_time) VALUES (?,?,?,?)")
      .run('legacy', 'teams', 'https://x', new Date().toISOString());

    const final = runMigrations(db);
    expect(final).toBe(Math.max(...MIGRATIONS.map((m) => m.version)));
    // legacy row survived
    expect((db.prepare('SELECT COUNT(*) c FROM meetings').get() as any).c).toBe(1);
    // columns added by later migrations are now present
    expect(tableCols(db, 'meetings')).toContain('heartbeat');
    expect(tableCols(db, 'meetings')).toContain('participants');
    expect(tableCols(db, 'recordings')).toContain('metadata_path');
  });

  it('applies migrations in strictly increasing version order with no gaps', () => {
    const versions = MIGRATIONS.map((m) => m.version);
    const sorted = [...versions].sort((a, b) => a - b);
    expect(versions).toEqual(sorted);
    for (let i = 0; i < sorted.length; i++) expect(sorted[i]).toBe(i + 1);
  });
});
