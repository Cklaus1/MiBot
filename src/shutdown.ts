/**
 * Single graceful-teardown path for the process (C1/C13/D9).
 *
 * Before this, ControlChannel registered its own SIGINT/SIGTERM handlers that
 * called stop() but never exited — so once any control channel started, Ctrl+C
 * and `systemctl stop` did nothing: the process, browser, and ffmpeg kept
 * running. Each meeting also leaked two more signal listeners.
 *
 * Now there is ONE place that owns teardown. Subsystems register a named hook;
 * on a signal (or normal exit) every hook runs exactly once, then the process
 * exits. Hooks unwind in reverse registration order (atexit/`defer` semantics):
 * the earliest-registered, longest-lived resources (log, db) are torn down last,
 * so a bot's browser/ffmpeg (registered later, once a meeting starts) stops
 * first and the log stream is still open to capture its final lines:
 *   … → children (browser/ffmpeg) → socket → closeDb (D9) → log.close (C13).
 *
 * An abrupt process.exit() is deliberately avoided in the hook body: it would
 * skip R3's awaited ffmpeg stop and C13's flush, re-orphaning ffmpeg. Exit is
 * the caller's final step, after runShutdown() resolves.
 */

type ShutdownHook = () => void | Promise<void>;

interface Hook {
  name: string;
  fn: ShutdownHook;
}

let hooks: Hook[] = [];
let shuttingDown = false;
let installed = false;

/**
 * Register a teardown hook. Returns a disposer that removes it — a per-meeting
 * hook must be disposed when the meeting ends normally, or hooks (and their
 * captured browser handles) accumulate across meetings, the exact listener leak
 * C1 called out. Long-lived hooks (log, db) simply never dispose.
 */
export function registerShutdownHook(name: string, fn: ShutdownHook): () => void {
  const hook: Hook = { name, fn };
  hooks.push(hook);
  return () => {
    const i = hooks.indexOf(hook);
    if (i !== -1) hooks.splice(i, 1);
  };
}

/**
 * Run every registered hook exactly once, in order, swallowing per-hook errors
 * so one failed teardown cannot strand the rest. Idempotent: a second call
 * (double signal, or `exit` firing after a signal) is a no-op.
 */
export async function runShutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  // Reverse (LIFO) order: last-registered / shortest-lived resources unwind first,
  // so the log and db (registered at startup) are still open while children stop.
  for (const hook of [...hooks].reverse()) {
    try {
      await hook.fn();
    } catch (err) {
      // Best effort — a broken hook must not block the others.
      console.error(`[mibot] shutdown hook "${hook.name}" failed: ${(err as Error).message}`);
    }
  }
}

/**
 * Install the process-level signal handlers exactly once. On SIGINT/SIGTERM we
 * run the graceful teardown then exit; `once` guarantees a single registration
 * regardless of how many subsystems call this.
 */
export function installShutdownHandlers(): void {
  if (installed) return;
  installed = true;

  const onSignal = (signal: NodeJS.Signals) => {
    void runShutdown().finally(() => {
      // 128 + signal number is the conventional exit code for a signal.
      process.exit(signal === 'SIGINT' ? 130 : 143);
    });
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  // Normal exit path (e.g. watcher promise resolves) — best-effort synchronous hooks only.
  process.once('beforeExit', () => { void runShutdown(); });
}

/** Test hook: clear registered hooks and the one-shot latch between cases. */
export function __resetShutdownForTest(): void {
  hooks = [];
  shuttingDown = false;
  installed = false;
}
