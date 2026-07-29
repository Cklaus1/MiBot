import type { ChildProcess } from 'child_process';

/**
 * R3 (AU4/AU5/AU6/C14) — a supervised wrapper around the recording ffmpeg child.
 *
 * The raw `spawn('ffmpeg', …)` in recorder.ts had three lifecycle holes:
 *  - no `'error'` handler: a missing/unspawnable binary threw on the process EventEmitter
 *    and took the whole bot down (AU6).
 *  - no `'exit'` handler: a mid-meeting death (pulse restart, ENOSPC, killed sink) went
 *    unnoticed — the bot kept "recording" to a dead pipe and reported a truncated file as
 *    a success (AU5).
 *  - `stop()` sent SIGINT then immediately nulled the handle: `copyFileSync` could race
 *    ffmpeg still finalizing the container → corrupt webm, and an ffmpeg that ignores SIGINT
 *    (or is wedged in a syscall) leaked forever with no SIGKILL escalation (AU4/C14).
 *
 * ManagedFfmpeg owns all three: it forwards errors, distinguishes an expected stop from an
 * unexpected death, keeps a bounded stderr tail for diagnostics, and its `stop()` awaits the
 * real exit with a SIGINT→timeout→SIGKILL escalation.
 */
export interface ManagedFfmpegOptions {
  /** Called if the child emits 'error' (e.g. spawn ENOENT). Never rethrown. */
  onError?: (err: Error) => void;
  /** Called if the child exits BEFORE stop() was requested (mid-meeting death). */
  onUnexpectedExit?: (info: { code: number | null; signal: string | null; stderrTail: string }) => void;
  /** How long to wait after SIGINT before escalating to SIGKILL. Default 5000ms. */
  killTimeoutMs?: number;
}

const STDERR_TAIL_LINES = 8;

export class ManagedFfmpeg {
  private readonly child: ChildProcess;
  private readonly opts: ManagedFfmpegOptions;
  private readonly killTimeoutMs: number;
  private stderrLines: string[] = [];
  private exited = false;
  private stopping = false;
  private exitWaiters: Array<() => void> = [];

  constructor(child: ChildProcess, opts: ManagedFfmpegOptions = {}) {
    this.child = child;
    this.opts = opts;
    this.killTimeoutMs = opts.killTimeoutMs ?? 5000;

    child.stderr?.on('data', (data: Buffer | string) => {
      const msg = data.toString().trim();
      if (!msg) return;
      this.stderrLines.push(msg);
      if (this.stderrLines.length > STDERR_TAIL_LINES) {
        this.stderrLines.splice(0, this.stderrLines.length - STDERR_TAIL_LINES);
      }
    });

    child.on('error', (err: Error) => {
      // A spawn error also means the process never really started; treat as exited so
      // stop() can't hang waiting for an exit that will never come.
      this.exited = true;
      this.flushExitWaiters();
      this.opts.onError?.(err);
    });

    child.on('exit', (code: number | null, signal: string | null) => {
      this.exited = true;
      this.flushExitWaiters();
      if (!this.stopping) {
        this.opts.onUnexpectedExit?.({ code, signal, stderrTail: this.stderrTail() });
      }
    });
  }

  /** The last few stderr lines — surfaces the ffmpeg failure signature (AU5). */
  stderrTail(): string {
    return this.stderrLines.join('\n');
  }

  hasExited(): boolean {
    return this.exited;
  }

  private flushExitWaiters(): void {
    const waiters = this.exitWaiters;
    this.exitWaiters = [];
    for (const w of waiters) w();
  }

  private waitForExit(): Promise<void> {
    if (this.exited) return Promise.resolve();
    return new Promise((resolve) => this.exitWaiters.push(resolve));
  }

  /**
   * Request a clean stop and RESOLVE ONLY once the child has actually exited.
   * SIGINT lets ffmpeg finalize the container; if it hasn't died within killTimeoutMs we
   * escalate to SIGKILL. A no-op (already exited) resolves immediately.
   */
  async stop(): Promise<void> {
    if (this.exited) return;
    this.stopping = true;

    try { this.child.kill('SIGINT'); } catch { /* already gone */ }

    const timer = new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), this.killTimeoutMs),
    );
    const raced = await Promise.race([this.waitForExit().then(() => 'exited' as const), timer]);

    if (raced === 'timeout' && !this.exited) {
      try { this.child.kill('SIGKILL'); } catch { /* already gone */ }
      await this.waitForExit();
    }
  }
}
