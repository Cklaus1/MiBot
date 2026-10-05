import fs from 'fs';
import path from 'path';
import { getDb } from './db.js';
import { webrtcAudioPathFor } from './capture-session.js';

/**
 * Wave 9-L: retention. Nothing was ever pruned — recordings, screenshots-<id> folders, dated
 * logs and meeting rows (missed/cancelled are terminal, one per calendar event) grew forever.
 *
 * Defaults are deliberately conservative:
 *  - logs older than `logRetentionDays` (default 30) are deleted;
 *  - recordings are NEVER deleted unless the operator sets `retentionDays` > 0. Then, for
 *    finished meetings older than that: audio (+ WebRTC sidecar and segments) and screenshot
 *    folders are deleted, and rows of meetings that never recorded anything are removed.
 *  - transcripts and analysis are never touched (small, and they're the product);
 *  - nothing belonging to a meeting that isn't finished is ever touched;
 *  - nothing outside the recordings directory is ever deleted, whatever a row's path says.
 */
export interface PruneOptions {
  retentionDays: number;
  logRetentionDays: number;
  logDir: string;
  recordingsDir: string;
  dryRun?: boolean;
  now?: number;
}

export interface PruneReport {
  logs: string[];
  audio: string[];
  screenshotDirs: string[];
  meetingRows: number;
  bytes: number;
}

const FINISHED = `('done', 'failed', 'missed', 'cancelled')`;
const DAY_MS = 86_400_000;

function inside(dir: string, p: string): boolean {
  const rel = path.relative(path.resolve(dir), path.resolve(p));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function sizeOf(p: string): number {
  try {
    const st = fs.statSync(p);
    if (!st.isDirectory()) return st.size;
    return fs.readdirSync(p).reduce((n, f) => n + sizeOf(path.join(p, f)), 0);
  } catch { return 0; }
}

/** The audio files one recording owns: the file, its WebRTC sidecar, and any segments. */
function audioFamily(audioPath: string): string[] {
  const files = [audioPath, webrtcAudioPathFor(audioPath)];
  const dir = path.dirname(audioPath);
  for (const base of files.slice()) {
    const stem = path.basename(base).replace(/\.webm$/, '');
    try {
      for (const f of fs.readdirSync(dir)) {
        if (f.startsWith(`${stem}.seg`) && f.endsWith('.webm')) files.push(path.join(dir, f));
      }
    } catch { /* dir gone */ }
  }
  return files;
}

export function prune(opts: PruneOptions): PruneReport {
  const now = opts.now ?? Date.now();
  const report: PruneReport = { logs: [], audio: [], screenshotDirs: [], meetingRows: 0, bytes: 0 };
  const remove = (p: string, isDir = false) => {
    report.bytes += sizeOf(p);
    if (!opts.dryRun) fs.rmSync(p, { recursive: isDir, force: true });
  };

  if (opts.logRetentionDays > 0 && fs.existsSync(opts.logDir)) {
    const cutoff = now - opts.logRetentionDays * DAY_MS;
    for (const f of fs.readdirSync(opts.logDir)) {
      const p = path.join(opts.logDir, f);
      if (!f.endsWith('.log')) continue;
      try { if (fs.statSync(p).mtimeMs < cutoff) { report.logs.push(p); remove(p); } } catch { /* raced */ }
    }
  }

  if (opts.retentionDays > 0) {
    const db = getDb();
    const cutoffIso = new Date(now - opts.retentionDays * DAY_MS).toISOString();
    // A finished meeting whose end (or start, if it has no end) is before the cutoff.
    const oldFinished = (t = '') =>
      `${t}status IN ${FINISHED} AND datetime(COALESCE(${t}end_time, ${t}start_time)) < datetime(?)`;

    const recs = db.prepare(`
      SELECT r.audio_path FROM recordings r JOIN meetings m ON m.id = r.meeting_id
      WHERE ${oldFinished('m.')}
    `).all(cutoffIso) as { audio_path: string }[];
    for (const { audio_path } of recs) {
      for (const f of audioFamily(audio_path)) {
        if (fs.existsSync(f) && inside(opts.recordingsDir, f)) { report.audio.push(f); remove(f); }
      }
    }

    const ids = db.prepare(`SELECT id FROM meetings WHERE ${oldFinished()}`).all(cutoffIso) as { id: number }[];
    for (const { id } of ids) {
      const d = path.join(opts.recordingsDir, `screenshots-${id}`);
      if (fs.existsSync(d)) { report.screenshotDirs.push(d); remove(d, true); }
    }

    const rowsWhere = `${oldFinished()} AND NOT EXISTS (SELECT 1 FROM recordings r WHERE r.meeting_id = meetings.id)`;
    report.meetingRows = opts.dryRun
      ? (db.prepare(`SELECT COUNT(*) AS n FROM meetings WHERE ${rowsWhere}`).get(cutoffIso) as { n: number }).n
      : db.prepare(`DELETE FROM meetings WHERE ${rowsWhere}`).run(cutoffIso).changes;
  }
  return report;
}
