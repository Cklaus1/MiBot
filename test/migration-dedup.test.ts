import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations, MIGRATIONS } from '../src/migrations.js';

// D6 P2 (DB gate §5.1 — seeded-dups proof): a UNIQUE index on calendar_event_id is
// defense-in-depth behind C19's get-or-create. But a legacy DB may already contain
// duplicate rows for one event id (created before C19 landed); adding the UNIQUE index
// naively would fail. Migration v3 must first collapse duplicates — keep the lowest id,
// re-point child recordings, delete the rest — THEN create the partial unique index
// (partial so multiple NULL event ids for manual joins stay allowed).

/** Build a legacy DB at version 2 with dup rows already present. */
function legacyDbWithDups(): Database.Database {
  const db = new Database(':memory:');
  // Run only up through v2 so we can seed dups before v3's unique index exists.
  const upTo2 = MIGRATIONS.filter((m) => m.version <= 2);
  for (const m of upTo2) {
    db.transaction(() => { m.up(db); db.pragma(`user_version = ${m.version}`); })();
  }
  return db;
}

describe('migration v3 dedupe + unique index (D6)', () => {
  it('collapses duplicate calendar_event_id rows, keeping the lowest id', () => {
    const db = legacyDbWithDups();
    const ins = db.prepare(
      "INSERT INTO meetings (title, platform, join_url, start_time, calendar_event_id) VALUES (?,?,?,?,?)",
    );
    const a = ins.run('Dup', 'teams', 'https://x', 't1', 'EVT-1').lastInsertRowid as number;
    const b = ins.run('Dup', 'teams', 'https://x', 't2', 'EVT-1').lastInsertRowid as number;
    const c = ins.run('Dup', 'teams', 'https://x', 't3', 'EVT-1').lastInsertRowid as number;
    expect([a, b, c].sort((x, y) => x - y)[0]).toBe(a);

    runMigrations(db); // applies v3

    const rows = db.prepare('SELECT id FROM meetings WHERE calendar_event_id = ?').all('EVT-1') as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(a); // lowest id survives
  });

  it('re-points recordings from removed dup rows to the survivor', () => {
    const db = legacyDbWithDups();
    const ins = db.prepare(
      "INSERT INTO meetings (title, platform, join_url, start_time, calendar_event_id) VALUES (?,?,?,?,?)",
    );
    const keep = ins.run('D', 'teams', 'https://x', 't1', 'EVT-2').lastInsertRowid as number;
    const drop = ins.run('D', 'teams', 'https://x', 't2', 'EVT-2').lastInsertRowid as number;
    db.prepare('INSERT INTO recordings (meeting_id, audio_path) VALUES (?,?)').run(drop, '/tmp/a.webm');

    runMigrations(db);

    const rec = db.prepare('SELECT meeting_id FROM recordings WHERE audio_path = ?').get('/tmp/a.webm') as any;
    expect(rec.meeting_id).toBe(keep); // recording followed the survivor, not orphaned
  });

  it('enforces the unique index after migration (second insert of same event id fails)', () => {
    const db = legacyDbWithDups();
    runMigrations(db);
    const ins = db.prepare(
      "INSERT INTO meetings (title, platform, join_url, start_time, calendar_event_id) VALUES (?,?,?,?,?)",
    );
    ins.run('One', 'teams', 'https://x', 't1', 'EVT-UNIQ');
    expect(() => ins.run('Two', 'teams', 'https://x', 't2', 'EVT-UNIQ')).toThrow();
  });

  it('still allows multiple NULL calendar_event_id rows (manual joins)', () => {
    const db = legacyDbWithDups();
    runMigrations(db);
    const ins = db.prepare(
      "INSERT INTO meetings (title, platform, join_url, start_time, calendar_event_id) VALUES (?,?,?,?,?)",
    );
    ins.run('M1', 'meet', 'https://a', 't1', null);
    ins.run('M2', 'meet', 'https://b', 't2', null);
    const c = (db.prepare('SELECT COUNT(*) c FROM meetings WHERE calendar_event_id IS NULL').get() as any).c;
    expect(c).toBeGreaterThanOrEqual(2);
  });

  it('is idempotent on a DB with no duplicates', () => {
    const db = legacyDbWithDups();
    db.prepare("INSERT INTO meetings (title, platform, join_url, start_time, calendar_event_id) VALUES (?,?,?,?,?)")
      .run('Solo', 'teams', 'https://x', 't1', 'EVT-SOLO');
    const first = runMigrations(db);
    const second = runMigrations(db);
    expect(second).toBe(first);
  });
});
