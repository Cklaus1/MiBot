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

/** Per-hook deadline. A hook that hasn't settled by now is abandoned (not cancelled — we
 *  can't cancel a promise) so the remaining hooks still run. Generous enough that a normal
 *  ffmpeg stop or browser close finishes well inside it. */
export const HOOK_TIMEOUT_MS = 10000;

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
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // A hook that never settles used to block every hook after it — including closeDb and
      // log.close — so one wedged ffmpeg stranded the whole teardown with no force-exit.
      // Bound each hook: on expiry we move on and let the straggler be reaped by process exit.
      const deadline = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), HOOK_TIMEOUT_MS);
      });
      const outcome = await Promise.race([hook.fn(), deadline]);
      if (outcome === 'timeout') {
        console.error(`[mibot] shutdown hook "${hook.name}" timed out after ${HOOK_TIMEOUT_MS}ms — continuing`);
      }
    } catch (err) {
      // Best effort — a broken hook must not block the others.
      console.error(`[mibot] shutdown hook "${hook.name}" failed: ${(err as Error).message}`);
    } finally {
      if (timer) clearTimeout(timer);
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

  // An uncaught throw or rejection bypassed teardown entirely and orphaned ffmpeg and
  // Chromium — precisely the failure this module exists to prevent. Run the same graceful
  // path, then exit non-zero so a supervisor sees the crash.
  const onFatal = (kind: string) => (err: unknown) => {
    console.error(`[mibot] ${kind}: ${(err as Error)?.stack || String(err)}`);
    void runShutdown().finally(() => process.exit(1));
  };
  process.once('uncaughtException', onFatal('uncaught exception'));
  process.once('unhandledRejection', onFatal('unhandled rejection'));

  // Normal exit path (e.g. `mibot join` / `mibot show` returning). `beforeExit` does NOT
  // await a returned promise, so the process could leave before the awaited ffmpeg stop and
  // log flush finished. Keep the loop alive across the async teardown by holding a handle
  // until it resolves, then exit deliberately.
  process.once('beforeExit', () => {
    const keepAlive = setTimeout(() => {}, HOOK_TIMEOUT_MS * (hooks.length + 1));
    void runShutdown().finally(() => {
      clearTimeout(keepAlive);
    });
  });
}

/** Test hook: clear registered hooks and the one-shot latch between cases. */
export function __resetShutdownForTest(): void {
  hooks = [];
  shuttingDown = false;
  installed = false;
}
