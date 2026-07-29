/**
 * DRAIN (OQ5 — unifies AU3 + AU8 + AU12) + AU7.
 *
 * The node-side orchestration of one audio drain, split from the page/CDP mechanics so the
 * ordering guarantee is unit-testable. The invariant this enforces:
 *
 *   read  → append → ack       (never ack before the bytes are safely on disk)
 *
 * The old code did `flushed.splice(0)` in-page BEFORE the payload had crossed CDP and been
 * appended — so a failed transfer or a throwing `appendFileSync` (ENOSPC) permanently lost that
 * window (AU8). Here `ack` (the destructive in-page removal) runs only after `append` succeeds;
 * if `append` throws we propagate and leave the page buffer intact for the next tick to retry.
 * The read is bounded by a timeout so a wedged in-page FileReader can't hang the drain (AU7).
 */
export interface DrainDeps {
  /** Read+encode the pending chunks from the page WITHOUT removing them. Returns count read. */
  readEncoded: () => Promise<{ b64: string; count: number }>;
  /** Append decoded bytes to the output file. May throw (ENOSPC) — must run before ack. */
  append: (buf: Buffer) => void;
  /** Remove exactly `count` already-persisted chunks from the page buffer. */
  ack: (count: number) => Promise<void>;
  /** Bound the read step; a hung in-page read resolves to empty rather than hanging (AU7). */
  timeoutMs: number;
}

export interface DrainResult {
  appended: boolean;
  bytes: number;
  timedOut: boolean;
}

export async function drainAudioOnce(deps: DrainDeps): Promise<DrainResult> {
  const timeout = new Promise<'timeout'>((resolve) =>
    setTimeout(() => resolve('timeout'), deps.timeoutMs),
  );
  const read = await Promise.race([deps.readEncoded(), timeout]);

  if (read === 'timeout') return { appended: false, bytes: 0, timedOut: true };
  if (!read.b64 || read.count === 0) return { appended: false, bytes: 0, timedOut: false };

  const buf = Buffer.from(read.b64, 'base64');
  // append MAY throw — deliberately not caught here: if it does, we skip ack so the window is
  // retried next tick (AU8). The caller (AU11) logs the failure.
  deps.append(buf);
  await deps.ack(read.count);
  return { appended: true, bytes: buf.length, timedOut: false };
}
