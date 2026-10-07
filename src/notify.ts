import fs from 'fs';
import os from 'os';
import path from 'path';
import { getDb, listJoinAttempts, type Meeting, type Recording } from './db.js';
import { buildDigest } from './digest.js';
import type { NotifyConfig } from './config.js';

/**
 * Wave 10 #3/#4: results and problems reach the operator without being asked for.
 *
 *  - Outbox (`notifications`): every digest/alert is queued in the DB and delivered with retry +
 *    backoff, so nothing is lost to a restart and a delivery failure can never affect a meeting.
 *  - Alerts (`alerts`): each condition has a key; it fires once (re-fires at most hourly while
 *    active) and a `resolved` entry is written when it clears.
 *  - Channel: a Markdown notes folder (spec OQ-5). One note per meeting; alerts in ALERTS.md.
 */
export interface Notification {
  id: number;
  kind: 'digest' | 'alert' | 'resolved';
  dedupe_key: string | null;
  meeting_id: number | null;
  title: string;
  payload: string;
  attempts: number;
}

export interface Channel {
  deliver(n: Notification): Promise<void>;
}

const nowIso = (ms = Date.now()) => new Date(ms).toISOString();

export function enqueue(n: { kind: Notification['kind']; title: string; payload: string; dedupeKey?: string; meetingId?: number }, nowMs = Date.now()): number {
  return Number(getDb().prepare(`
    INSERT INTO notifications (kind, dedupe_key, meeting_id, title, payload, next_attempt_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(n.kind, n.dedupeKey ?? null, n.meetingId ?? null, n.title, n.payload, nowIso(nowMs), nowIso(nowMs)).lastInsertRowid);
}

const MAX_ATTEMPTS = 8;
/** 1, 2, 4 … min, capped at 1h. */
const backoffMs = (attempts: number) => Math.min(60_000 * 2 ** Math.max(0, attempts - 1), 3_600_000);

/** Deliver what's due. Never throws; returns counts. */
export async function drainOutbox(channel: Channel, nowMs = Date.now()): Promise<{ sent: number; failed: number }> {
  const db = getDb();
  const due = db.prepare(`
    SELECT id, kind, dedupe_key, meeting_id, title, payload, attempts FROM notifications
    WHERE status = 'pending' AND datetime(next_attempt_at) <= datetime(?) ORDER BY id LIMIT 50
  `).all(nowIso(nowMs)) as Notification[];
  let sent = 0; let failed = 0;
  for (const n of due) {
    try {
      await channel.deliver(n);
      db.prepare(`UPDATE notifications SET status = 'sent', sent_at = ?, attempts = attempts + 1 WHERE id = ?`).run(nowIso(nowMs), n.id);
      sent++;
    } catch (err) {
      const attempts = n.attempts + 1;
      db.prepare(`UPDATE notifications SET attempts = ?, last_error = ?, status = ?, next_attempt_at = ? WHERE id = ?`)
        .run(attempts, (err as Error).message.slice(0, 500), attempts >= MAX_ATTEMPTS ? 'failed' : 'pending',
          nowIso(nowMs + backoffMs(attempts)), n.id);
      failed++;
    }
  }
  return { sent, failed };
}

// ── Alerts ──────────────────────────────────────────────────────────────

const REFIRE_MS = 3_600_000;
let alertsEnabled = true;

/** notify.alerts = false silences every alert at the source. */
export function setAlertsEnabled(on: boolean): void { alertsEnabled = on; }

const oneLine = (s: string) => s.replace(/\s*\n\s*/g, ' ').trim();

/** Raise an alert. Fires if it isn't active, or re-fires if it's been active over an hour. */
export function raiseAlert(key: string, title: string, body: string, nowMs = Date.now()): boolean {
  if (!alertsEnabled) return false;
  const db = getDb();
  const row = db.prepare('SELECT active, last_raised_at FROM alerts WHERE key = ?').get(key) as
    { active: number; last_raised_at: string | null } | undefined;
  if (row?.active && row.last_raised_at && nowMs - Date.parse(row.last_raised_at) < REFIRE_MS) return false;
  db.prepare(`INSERT INTO alerts (key, active, last_raised_at) VALUES (?, 1, ?)
              ON CONFLICT(key) DO UPDATE SET active = 1, last_raised_at = excluded.last_raised_at`).run(key, nowIso(nowMs));
  enqueue({ kind: 'alert', title: oneLine(title), payload: oneLine(body), dedupeKey: key }, nowMs);
  return true;
}

/** Clear an active alert and say so. No-op if it isn't active. */
export function resolveAlert(key: string, body: string, nowMs = Date.now()): boolean {
  if (!alertsEnabled) return false;
  const db = getDb();
  const res = db.prepare(`UPDATE alerts SET active = 0, last_resolved_at = ? WHERE key = ? AND active = 1`).run(nowIso(nowMs), key);
  if (res.changes === 0) return false;
  enqueue({ kind: 'resolved', title: `Resolved: ${key}`, payload: oneLine(body), dedupeKey: key }, nowMs);
  return true;
}

/** A one-off notice (e.g. "the watcher restarted after a crash"): fires, never stays active. */
export function noticeAlert(key: string, title: string, body: string, nowMs = Date.now()): void {
  if (raiseAlert(key, title, body, nowMs)) getDb().prepare('UPDATE alerts SET active = 0 WHERE key = ?').run(key);
}

// ── Digests ─────────────────────────────────────────────────────────────

/** Read a file if it exists (artifacts are optional). */
const readIf = (p: string | null | undefined) => { try { return p && fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null; } catch { return null; } };

/**
 * Queue a digest for every meeting that has become final since the last call. Final = done (with
 * its recording past transcription), failed, or missed; cancelled/skipped meetings didn't happen.
 * Marks notified_at in the same transaction, so each meeting gets exactly one note.
 */
export function enqueuePendingDigests(opts: { timezone: string; nowMs?: number; write?: boolean }): number {
  const db = getDb();
  const rows = db.prepare(`
    SELECT m.* FROM meetings m
    WHERE m.notified_at IS NULL AND m.status IN ('done', 'failed', 'missed')
      AND COALESCE(m.failure_reason, '') != 'skipped'  -- intentionally not joined: no note (#5)
      -- Wait for transcription of the meeting's LATEST recording only: an earlier attempt's
      -- recording left non-terminal (old crash) must not block the note forever.
      AND COALESCE((SELECT r.status FROM recordings r WHERE r.meeting_id = m.id ORDER BY r.id DESC LIMIT 1), '')
          NOT IN ('recording', 'recorded')
  `).all() as Meeting[];
  const tx = db.transaction(() => {
    for (const m of rows) {
      const rec = db.prepare(`SELECT * FROM recordings WHERE meeting_id = ? ORDER BY (status = 'done') DESC, id DESC LIMIT 1`)
        .get(m.id) as Recording | undefined;
      const tp = rec?.transcript_path ?? null;
      let transcript: any = null;
      try { const j = readIf(tp?.replace(/\.md$/, '.json')); transcript = j ? JSON.parse(j) : null; } catch { transcript = null; }
      const d = buildDigest({
        meeting: m as any,
        recording: rec ? { status: rec.status, transcript_path: tp } : null,
        attempts: listJoinAttempts(m.id).filter((a) => a.outcome === 'failed'),
        summary: readIf(tp?.replace(/\.md$/, '.summary.txt')),
        transcript,
        timezone: opts.timezone,
      });
      // write: false (notify.digest = 'off') still marks the meeting, so turning digests on later
      // doesn't dump a backlog of old meetings into the notes folder.
      if (opts.write !== false) enqueue({ kind: 'digest', title: d.stem, payload: d.markdown, meetingId: m.id }, opts.nowMs);
      db.prepare('UPDATE meetings SET notified_at = ? WHERE id = ?').run(nowIso(opts.nowMs), m.id);
    }
  });
  tx();
  return rows.length;
}

// ── Channel: Markdown notes folder ─────────────────────────────────────

export function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p;
}

/** Write atomically (temp + rename) so a notes app never sees a half-written file. */
function writeAtomic(file: string, content: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

/** A path that doesn't exist yet: "name.md", else "name (2).md", … — never overwrite a note. */
function freshPath(dir: string, stem: string): string {
  for (let i = 1; ; i++) {
    const p = path.join(dir, i === 1 ? `${stem}.md` : `${stem} (${i}).md`);
    if (!fs.existsSync(p)) return p;
  }
}

export class NotesFolderChannel implements Channel {
  private readonly dir: string;
  constructor(folder: string) { this.dir = expandHome(folder); }

  get alertsFile(): string { return path.join(this.dir, 'ALERTS.md'); }

  async deliver(n: Notification): Promise<void> {
    fs.mkdirSync(this.dir, { recursive: true });
    if (n.kind === 'digest') {
      writeAtomic(freshPath(this.dir, n.title), n.payload);
      return;
    }
    // ALERTS.md: newest first. A 'resolved' entry is inserted directly under its alert.
    const head = '# MiBot alerts\n\nNewest first. Each alert is followed by its resolution, if any.\n\n';
    const existing = fs.existsSync(this.alertsFile) ? fs.readFileSync(this.alertsFile, 'utf8') : head;
    const body = existing.startsWith('# MiBot alerts') ? existing.slice(head.length) : existing;
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const marker = `<!-- alert:${n.dedupe_key ?? n.id} -->`;
    let next: string;
    if (n.kind === 'resolved' && body.includes(marker)) {
      const i = body.indexOf(marker) + marker.length;
      const eol = body.indexOf('\n', body.indexOf('\n', i) + 1); // after the alert's heading line
      const at = eol === -1 ? body.length : eol + 1;
      next = body.slice(0, at) + `  - ✅ Resolved ${stamp}: ${n.payload}\n` + body.slice(at);
    } else if (n.kind === 'resolved') {
      next = `- ✅ ${stamp} ${n.title}: ${n.payload}\n\n` + body;
    } else {
      next = `${marker}\n- ⚠️ **${stamp} — ${n.title}**: ${n.payload}\n\n` + body;
    }
    writeAtomic(this.alertsFile, head + next);
  }
}

/** Wave 10 #4: transcription failures raise an alert; the next success resolves it. */
export function noteTranscriptionOutcome(outcome: string, title: string): void {
  if (outcome === 'transcribe_failed') {
    raiseAlert('transcription', 'Transcription failed', `"${title}" could not be transcribed — check audioscript (the audio is kept).`);
  } else if (outcome === 'done') {
    resolveAlert('transcription', `"${title}" transcribed successfully.`);
  }
}

/** The configured channel (only the notes folder exists this wave; email/Slack later). */
export function channelFor(cfg: NotifyConfig): Channel {
  return new NotesFolderChannel(cfg.folder);
}
