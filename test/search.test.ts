import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getDb, closeDb, insertMeeting, insertRecording, updateRecording } from '../src/db.js';
import { indexTranscript, reindexAll, searchTranscripts, toFtsQuery } from '../src/search.js';

// Wave 10 #7: there was no way to find "what did we decide about pricing?" across meetings.
afterAll(() => closeDb());
beforeEach(() => { getDb().exec('DELETE FROM transcript_fts; DELETE FROM recordings; DELETE FROM meetings;'); });

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mibot-search-'));
let n = 0;
function meetingWithTranscript(o: { title: string; platform?: string; start: string; segments: any[]; summary?: string; diarized?: boolean }) {
  const m = insertMeeting({ title: o.title, platform: o.platform ?? 'teams', join_url: `https://x/${n++}`, start_time: o.start });
  const base = path.join(dir, `t${n}`);
  fs.writeFileSync(`${base}.json`, JSON.stringify({ segments: o.segments }));
  fs.writeFileSync(`${base}.md`, '# transcript');
  if (o.summary) fs.writeFileSync(`${base}.summary.txt`, o.summary);
  const r = insertRecording({ meeting_id: m.id, audio_path: `${base}.webm` });
  updateRecording(r.id, { transcript_path: `${base}.md` });
  return { m, r };
}
const seg = (start: number, text: string, speaker?: string) => ({ start, end: start + 5, text, ...(speaker ? { speaker } : {}) });

describe('toFtsQuery', () => {
  it('plain words become quoted terms (stray punctuation can\'t break FTS syntax)', () => {
    expect(toFtsQuery('pricing Q4?')).toBe('"pricing" "Q4"');
    expect(toFtsQuery('can\'t (stop)')).toBe('"can\'t" "stop"');
  });
  it('keeps quoted phrases and prefix*', () => {
    expect(toFtsQuery('"price increase" budg*')).toBe('"price increase" budg*');
  });
  it('empty → null', () => expect(toFtsQuery('  ?! ')).toBeNull());
});

describe('indexing', () => {
  it('indexes each segment with speaker and time, plus the summary; re-indexing never duplicates', () => {
    const { r } = meetingWithTranscript({ title: 'Pricing', start: '2026-09-01T15:00:00Z', summary: 'Agreed to raise prices.',
      segments: [seg(10, 'Let us talk about pricing', 'Ann'), seg(70, 'I agree with the pricing plan', 'Bob')] });
    expect(indexTranscript(r.id)).toBe(3);
    expect(indexTranscript(r.id)).toBe(3);
    expect((getDb().prepare('SELECT COUNT(*) n FROM transcript_fts').get() as any).n).toBe(3);
  });

  it('a transcript without diarization is indexed with no speaker', () => {
    const { r } = meetingWithTranscript({ title: 'Solo', start: '2026-09-01T15:00:00Z', segments: [seg(0, 'quarterly roadmap')] });
    indexTranscript(r.id);
    expect(searchTranscripts('roadmap')[0]).toMatchObject({ speaker: null });
  });

  it('a missing transcript file indexes nothing and does not throw', () => {
    const m = insertMeeting({ title: 'x', platform: 'teams', join_url: 'https://x/missing', start_time: '2026-09-01T15:00:00Z' });
    const r = insertRecording({ meeting_id: m.id, audio_path: '/nope.webm' });
    updateRecording(r.id, { transcript_path: '/nope/none.md' });
    expect(indexTranscript(r.id)).toBe(0);
  });

  it('reindexAll covers every transcribed recording', () => {
    meetingWithTranscript({ title: 'A', start: '2026-09-01T15:00:00Z', segments: [seg(0, 'alpha')] });
    meetingWithTranscript({ title: 'B', start: '2026-09-02T15:00:00Z', segments: [seg(0, 'beta')] });
    expect(reindexAll()).toEqual({ recordings: 2, rows: 2 });
  });
});

describe('searchTranscripts', () => {
  beforeEach(() => {
    const a = meetingWithTranscript({ title: 'Pricing review', platform: 'teams', start: '2026-09-20T15:00:00Z',
      summary: 'Decided on a 10% price increase.',
      segments: [seg(125, 'We should raise the price for enterprise customers', 'Ann'), seg(300, 'Budgeting comes next', 'Bob')] });
    const b = meetingWithTranscript({ title: 'Old sync', platform: 'zoom', start: '2026-01-05T15:00:00Z',
      segments: [seg(30, 'price talk from January', 'Cy')] });
    indexTranscript(a.r.id); indexTranscript(b.r.id);
  });

  it('finds matches across meetings with title, speaker, timestamp and a highlighted snippet', () => {
    const hits = searchTranscripts('price');
    expect(hits.length).toBeGreaterThanOrEqual(3);
    const ann = hits.find((h) => h.speaker === 'Ann')!;
    expect(ann).toMatchObject({ title: 'Pricing review', platform: 'teams', segStart: 125, kind: 'segment' });
    expect(ann.snippet).toContain('[price]');
  });

  it('porter stemming: "budget" finds "Budgeting"', () => expect(searchTranscripts('budget').map((h) => h.speaker)).toContain('Bob'));
  it('prefix search', () => expect(searchTranscripts('enterpr*')).toHaveLength(1));
  it('phrase search', () => {
    expect(searchTranscripts('"price increase"')).toHaveLength(1);
    expect(searchTranscripts('"increase price"')).toHaveLength(0);
  });
  it('filters: --since, --platform, --speaker', () => {
    expect(searchTranscripts('price', { sinceMs: Date.parse('2026-06-01') }).every((h) => h.title === 'Pricing review')).toBe(true);
    expect(searchTranscripts('price', { platform: 'zoom' }).map((h) => h.title)).toEqual(['Old sync']);
    expect(searchTranscripts('price', { speaker: 'cy' }).map((h) => h.speaker)).toEqual(['Cy']);
  });
  it('a query of only punctuation returns nothing instead of an FTS syntax error', () => {
    expect(searchTranscripts('(((')).toEqual([]);
  });
});
