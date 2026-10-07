import fs from 'fs';
import { getDb, getRecording } from './db.js';

/**
 * Wave 10 #7: full-text search across every transcript — "what did we decide about pricing?".
 * SQLite FTS5 (porter stemming), one row per transcript segment (so a hit says who and when) plus
 * one per meeting summary. Indexing is idempotent: a recording's rows are replaced, never added.
 */
export interface SearchHit {
  meetingId: number;
  recordingId: number;
  title: string;
  platform: string;
  startTime: string;
  speaker: string | null;
  /** Seconds into the recording, or null for a summary hit. */
  segStart: number | null;
  kind: 'segment' | 'summary';
  snippet: string;
}

const readIf = (p: string) => { try { return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null; } catch { return null; } };

/** (Re)index one recording's transcript. Returns rows written; 0 if there's nothing to index. */
export function indexTranscript(recordingId: number): number {
  const rec = getRecording(recordingId);
  const db = getDb();
  db.prepare('DELETE FROM transcript_fts WHERE recording_id = ?').run(recordingId);
  if (!rec?.transcript_path) return 0;
  let segments: any[] = [];
  try {
    const j = readIf(rec.transcript_path.replace(/\.md$/, '.json'));
    const parsed = j ? JSON.parse(j) : null;
    if (Array.isArray(parsed?.segments)) segments = parsed.segments;
  } catch { segments = []; }
  const summary = readIf(rec.transcript_path.replace(/\.md$/, '.summary.txt'))?.trim() ?? '';

  const insert = db.prepare(`INSERT INTO transcript_fts (text, speaker, kind, meeting_id, recording_id, seg_start)
                             VALUES (?, ?, ?, ?, ?, ?)`);
  let rows = 0;
  db.transaction(() => {
    for (const s of segments) {
      const text = typeof s?.text === 'string' ? s.text.trim() : '';
      if (!text) continue;
      const speaker = typeof s.speaker === 'string' && s.speaker ? s.speaker : null;
      insert.run(text, speaker, 'segment', rec.meeting_id, recordingId, Number.isFinite(s.start) ? s.start : null);
      rows++;
    }
    if (summary) { insert.run(summary, null, 'summary', rec.meeting_id, recordingId, null); rows++; }
  })();
  return rows;
}

/** Index every transcribed recording (`mibot search --reindex`). */
export function reindexAll(): { recordings: number; rows: number } {
  const ids = getDb().prepare('SELECT id FROM recordings WHERE transcript_path IS NOT NULL').all() as { id: number }[];
  let rows = 0;
  for (const { id } of ids) rows += indexTranscript(id);
  return { recordings: ids.length, rows };
}

/**
 * User text → a safe FTS5 query. "Quoted phrases" and prefix* terms keep their meaning; every
 * other word is quoted, so punctuation like `?` or `(` can't produce an FTS syntax error.
 * Terms are ANDed. Returns null when nothing searchable remains.
 */
export function toFtsQuery(input: string): string | null {
  const parts: string[] = [];
  const rest = input.replace(/"([^"]+)"/g, (_, phrase: string) => {
    const p = phrase.trim().replace(/"/g, '');
    if (p) parts.push(`"${p}"`);
    return ' ';
  });
  for (const raw of rest.split(/\s+/)) {
    if (/^[\p{L}\p{N}_]+\*$/u.test(raw)) { parts.push(raw); continue; }
    const word = raw.replace(/[^\p{L}\p{N}_']+/gu, '').replace(/^'+|'+$/g, '');
    if (word) parts.push(`"${word}"`);
  }
  return parts.length ? parts.join(' ') : null;
}

export function searchTranscripts(
  input: string,
  opts: { sinceMs?: number; platform?: string; speaker?: string; limit?: number } = {},
): SearchHit[] {
  const q = toFtsQuery(input);
  if (!q) return [];
  const where = ['transcript_fts MATCH ?'];
  const params: unknown[] = [q];
  if (opts.sinceMs !== undefined) { where.push('datetime(m.start_time) >= datetime(?)'); params.push(new Date(opts.sinceMs).toISOString()); }
  if (opts.platform) { where.push('m.platform = ?'); params.push(opts.platform); }
  if (opts.speaker) { where.push("lower(f.speaker) LIKE '%' || lower(?) || '%'"); params.push(opts.speaker); }
  params.push(opts.limit ?? 50);
  try {
    return (getDb().prepare(`
      SELECT f.meeting_id AS meetingId, f.recording_id AS recordingId, m.title, m.platform, m.start_time AS startTime,
             f.speaker, f.seg_start AS segStart, f.kind,
             snippet(transcript_fts, 0, '[', ']', '…', 14) AS snippet
      FROM transcript_fts f JOIN meetings m ON m.id = f.meeting_id
      WHERE ${where.join(' AND ')}
      ORDER BY bm25(transcript_fts) LIMIT ?
    `).all(...params) as SearchHit[]);
  } catch {
    return []; // a query FTS still rejects is "no results", not a crash
  }
}

const mmss = (s: number) => {
  const t = Math.max(0, Math.floor(s));
  const h = Math.floor(t / 3600); const m = Math.floor((t % 3600) / 60); const sec = t % 60;
  return `${h ? `${h}:` : ''}${String(m).padStart(h ? 2 : 1, '0')}:${String(sec).padStart(2, '0')}`;
};

/** Hits grouped by meeting, best match first. */
export function formatSearch(hits: SearchHit[], query: string): string {
  if (hits.length === 0) return `No matches for "${query}". (Run 'mibot search --reindex' if transcripts predate the index.)`;
  const groups = new Map<number, SearchHit[]>();
  for (const h of hits) groups.set(h.meetingId, [...(groups.get(h.meetingId) ?? []), h]);
  const out: string[] = [];
  for (const [, hs] of groups) {
    const h0 = hs[0];
    out.push(`${h0.startTime.slice(0, 16).replace('T', ' ')}  ${h0.title} (${h0.platform})`);
    for (const h of hs) {
      const where = h.kind === 'summary' ? 'summary ' : `${mmss(h.segStart ?? 0).padStart(7)} `;
      out.push(`   ${where} ${h.speaker ? `${h.speaker}: ` : ''}${h.snippet.replace(/\s+/g, ' ')}`);
    }
    out.push('');
  }
  return out.join('\n').trimEnd();
}
