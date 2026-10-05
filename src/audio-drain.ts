import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';

/**
 * DRAIN (OQ5 — unifies AU3 + AU8 + AU12) + AU7, and Wave 9-C.
 *
 * The node-side orchestration of one audio drain, split from the page/CDP mechanics so the
 * ordering guarantee is unit-testable. The invariant this enforces:
 *
 *   read  → append → ack       (never ack before the bytes are safely on disk)
 *
 * Wave 9-C closed two holes in that protocol:
 *
 *  1. DUPLICATES. If append succeeded but the ack call failed (a REST/CDP hiccup), the next read
 *     returned the same chunks and they were appended twice. Chunks now carry sequence numbers:
 *     the in-page buffer tracks the sequence of its first chunk (`__mibotFlushedBase`), node
 *     remembers the next sequence it still needs (`DrainState.nextSeq`, advanced as soon as the
 *     append succeeds), and every read starts there. A failed ack costs nothing.
 *
 *  2. SPLICED STREAMS. A webm file is ONE header and one continuous stream. A page reload (new
 *     window → new MediaRecorder → new header) or draining a different frame appended a second
 *     stream to the same file, which decodes only up to the splice — verified: 4s + 3s appended
 *     decodes as 3s. Each in-page buffer now has a recorder id (`__mibotRecId`, assigned lazily
 *     by the read itself, so a fresh window always gets a fresh id with no hook changes). A new
 *     id starts a new segment file; assembleSegments joins them with ffmpeg's concat demuxer.
 */

/** What one in-page read returns. */
export interface ReadResult {
  b64: string;
  count: number;
  /** Sequence number of the first chunk in this read. */
  startSeq: number;
  /** Identity of the in-page recorder buffer these chunks came from. */
  recId: string;
}

export interface DrainDeps {
  /** Read+encode pending chunks from `fromSeq` on, WITHOUT removing them. If the page's recorder
   *  isn't `knownRecId` (reload / other frame), read from the start of its buffer instead. */
  readEncoded: (fromSeq: number, knownRecId: string | null) => Promise<ReadResult>;
  /** Append decoded bytes to segment `segment`. May throw (ENOSPC) — must run before ack. */
  append: (buf: Buffer, segment: number) => void;
  /** Remove every chunk of recorder `recId` below sequence `uptoSeq` from the page buffer. */
  ack: (uptoSeq: number, recId: string) => Promise<void>;
  /** Bound the read step; a hung in-page read resolves to empty rather than hanging (AU7). */
  timeoutMs: number;
}

/** Per-capture drain bookkeeping. One per output file. */
export class DrainState {
  recId: string | null = null;
  nextSeq = 0;
  /** Index of the segment currently being written (0 = the output file itself). */
  segment = 0;
  /** Number of segments that received bytes. */
  get segmentCount(): number { return this.recId === null ? 0 : this.segment + 1; }
}

export interface DrainResult {
  appended: boolean;
  bytes: number;
  timedOut: boolean;
}

export async function drainAudioOnce(deps: DrainDeps, state: DrainState = new DrainState()): Promise<DrainResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), deps.timeoutMs); });
  const read = await Promise.race([deps.readEncoded(state.nextSeq, state.recId), timeout]).finally(() => clearTimeout(timer));

  if (read === 'timeout') return { appended: false, bytes: 0, timedOut: true };
  if (!read.b64 || read.count === 0) return { appended: false, bytes: 0, timedOut: false };

  // A different recorder than the one we were writing: its stream needs its own file.
  const newRecorder = read.recId !== state.recId;
  const segment = newRecorder && state.recId !== null ? state.segment + 1 : state.segment;

  const buf = Buffer.from(read.b64, 'base64');
  // append MAY throw — deliberately not caught: we skip ack so the window is retried (AU8), and
  // state is untouched so the retry reads the same chunks into the same segment.
  deps.append(buf, segment);
  // Bytes are on disk: from here on, these sequences must never be appended again.
  state.recId = read.recId;
  state.segment = segment;
  state.nextSeq = read.startSeq + read.count;
  try {
    await deps.ack(state.nextSeq, read.recId);
  } catch {
    // The page keeps the chunks a little longer; the next read starts past them anyway.
  }
  return { appended: true, bytes: buf.length, timedOut: false };
}

/**
 * The in-page READ, as an expression string — shared by both engines (Playwright's
 * frame.evaluate and camofox's /eval both take one). Non-destructive: it copies, never splices.
 */
export function buildReadExpr(fromSeq: number, knownRecId: string | null): string {
  return `(() => {
    const w = window;
    if (!w.__mibotRecId) w.__mibotRecId = Math.random().toString(36).slice(2) + Date.now().toString(36);
    if (typeof w.__mibotFlushedBase !== 'number') w.__mibotFlushedBase = 0;
    const recId = w.__mibotRecId, base = w.__mibotFlushedBase;
    const flushed = w.__mibotFlushedChunks;
    const from = recId === ${JSON.stringify(knownRecId)} ? Math.max(${Number(fromSeq)}, base) : base;
    const snapshot = flushed ? flushed.slice(from - base) : [];
    if (snapshot.length === 0) return { b64: '', count: 0, startSeq: from, recId };
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve({ b64: String(reader.result).split(',')[1] || '', count: snapshot.length, startSeq: from, recId });
      reader.onerror = () => resolve({ b64: '', count: 0, startSeq: from, recId }); // AU7: never hang
      reader.onabort = () => resolve({ b64: '', count: 0, startSeq: from, recId });
      reader.readAsDataURL(new Blob(snapshot, { type: 'audio/webm' }));
    });
  })()`;
}

/** The in-page ACK: drop chunks below `uptoSeq`, only if the buffer is still recorder `recId`. */
export function buildAckExpr(uptoSeq: number, recId: string): string {
  return `(() => {
    const w = window;
    if (w.__mibotRecId !== ${JSON.stringify(recId)} || !w.__mibotFlushedChunks) return false;
    const base = typeof w.__mibotFlushedBase === 'number' ? w.__mibotFlushedBase : 0;
    const n = Math.min(${Number(uptoSeq)} - base, w.__mibotFlushedChunks.length);
    if (n > 0) { w.__mibotFlushedChunks.splice(0, n); w.__mibotFlushedBase = base + n; }
    return true;
  })()`;
}

/** Path of segment `i`: segment 0 is the output file itself, so the one-recorder case is unchanged. */
export function segmentPath(base: string, i: number): string {
  if (i === 0) return base;
  const anchored = base.replace(/\.webm$/, `.seg${i}.webm`);
  return anchored === base ? `${base}.seg${i}` : anchored;
}

/** A DrainDeps.append that routes each segment to its own file. */
export function appendToSegment(base: string): (buf: Buffer, segment: number) => void {
  return (buf, segment) => fs.appendFileSync(segmentPath(base, segment), buf);
}

/** Seconds of audio ffmpeg can actually decode from `p` (0 if none). */
function decodedSeconds(p: string): Promise<number> {
  return new Promise((resolve) => {
    execFile('ffmpeg', ['-hide_banner', '-nostdin', '-i', p, '-f', 'null', '-'],
      { timeout: 10 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 },
      (_err, _out, stderr) => {
        const times = [...String(stderr).matchAll(/time=(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/g)];
        if (times.length === 0) { resolve(0); return; }
        const [, h, m, sec] = times[times.length - 1];
        resolve(Number(h) * 3600 + Number(m) * 60 + parseFloat(sec));
      });
  });
}

function concatCopy(list: string, out: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('ffmpeg', ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
      '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-f', 'webm', out],
    { timeout: 10 * 60 * 1000 }, (err) => resolve(!err && fs.existsSync(out)));
  });
}

/**
 * Join a multi-recorder capture into `base` with ffmpeg's concat demuxer (stream copy — the
 * segments share codec params: opus/webm from the same MediaRecorder config). Byte-appending them
 * is what produced the undecodable files.
 *
 * Nothing is deleted on trust: concat exits 0 even when a segment is unreadable, so each segment
 * is decoded first and only the decodable ones are joined; the joined file must hold (nearly) their
 * summed length; and only segments verifiably inside the result are removed. Any failure leaves
 * every segment on disk and `base` as it was. Resolves true if `base` is the joined result.
 */
export async function assembleSegments(base: string, count: number): Promise<boolean> {
  if (count <= 1) return true;
  const parts = Array.from({ length: count }, (_, i) => segmentPath(base, i)).filter((p) => fs.existsSync(p));
  if (parts.length <= 1) return true;

  const secs = await Promise.all(parts.map(decodedSeconds));
  const good = parts.filter((_, i) => secs[i] > 0);
  const bad = parts.filter((_, i) => secs[i] <= 0);
  if (bad.length > 0) console.error(`[mibot] WARN: ${bad.length} audio segment(s) undecodable, kept as-is: ${bad.join(', ')}`);
  if (good.length <= 1) return false;

  const expected = good.reduce((sum, p) => sum + secs[parts.indexOf(p)], 0);
  const list = `${base}.concat.txt`;
  const tmp = base.replace(/(\.webm)?$/, '.joined.webm');
  fs.writeFileSync(list, good.map((p) => `file '${path.resolve(p).replace(/'/g, "'\\''")}'`).join('\n') + '\n');
  const ok = await concatCopy(list, tmp);
  try { fs.unlinkSync(list); } catch { /* ignore */ }
  const joinedSec = ok ? await decodedSeconds(tmp) : 0;
  // Allow a little slack for container rounding; a real truncation is far larger.
  if (!ok || joinedSec < expected * 0.95) {
    console.error(`[mibot] WARN: joining ${good.length} audio segments failed (${joinedSec.toFixed(1)}s of ${expected.toFixed(1)}s) — kept them separately next to ${base}`);
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    return false;
  }
  fs.renameSync(tmp, base);
  for (const p of good) if (p !== base) { try { fs.unlinkSync(p); } catch { /* ignore */ } }
  console.error(`[mibot] Joined ${good.length} audio segments (${joinedSec.toFixed(1)}s) — recorder restarted mid-meeting`);
  return bad.length === 0;
}
