// runcli.ts — the single external-process boundary (F4 / AR4 / hardening R7).
//
// Every shell-out to an external binary (audioscript, deepscript, ms365, gws) routes
// through runCli/runCliJson. This is the one place that owns:
//   - exit-code checking (non-zero throws CliError unless allowNonZero)
//   - stderr surfacing (captured on the error, not swallowed)
//   - maxBuffer (large transcripts must not silently truncate — T6)
//   - timeout (every call is bounded)
//   - JSON-shape parsing + validation for JSON-producing tools (T7/CA1/CA7)
//   - `--`-terminated argv so a user-controlled positional can't be read as a flag (T5)

import { spawn, type ChildProcess } from 'child_process';

export interface RunCliOptions {
  /** Working directory for the child process. */
  cwd?: string;
  /** Extra environment variables (merged over process.env). */
  env?: NodeJS.ProcessEnv;
  /** Hard timeout in milliseconds. Default 60s. */
  timeoutMs?: number;
  /** Max stdout/stderr buffer in bytes. Default 64 MiB (transcripts are large). */
  maxBuffer?: number;
  /** If true, a non-zero exit resolves instead of throwing. */
  allowNonZero?: boolean;
}

export interface CliResult {
  stdout: string;
  stderr: string;
  code: number;
}

export class CliError extends Error {
  override name = 'CliError';
  constructor(
    message: string,
    readonly bin: string,
    readonly code: number | null,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(message);
  }
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Build an argv where user-controlled positionals are placed after a `--` terminator,
 * so a value like "--db" (a meeting display name) can never be parsed as an option (T5).
 *   buildArgv(['speakers','label'], ['cluster1', userName], ['--json'])
 *     → ['speakers','label','--json','--','cluster1', userName]
 */
export function buildArgv(
  subcommand: string[],
  positionals: string[],
  flags: string[] = [],
): string[] {
  const head = [...subcommand, ...flags];
  return positionals.length > 0 ? [...head, '--', ...positionals] : head;
}

/** Process groups of CLIs currently running (Wave 9-J). */
const activeGroups = new Set<number>();

/** SIGTERM, then SIGKILL after a grace period, to a whole process group. */
function killGroup(pid: number, graceMs = 5000): void {
  try { process.kill(-pid, 'SIGTERM'); } catch { return; } // group already gone
  const t = setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } }, graceMs);
  t.unref();
}

/**
 * Kill every CLI process group still running. Each CLI runs in its own group (see runCli), which
 * means the terminal's Ctrl+C — delivered to the FOREGROUND group — no longer reaches it, so
 * shutdown must do it. Synchronous so it also works from a process 'exit' handler.
 */
export function killActiveCliGroups(): void {
  for (const pid of activeGroups) {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ }
  }
  activeGroups.clear();
}
process.once('exit', killActiveCliGroups);

/**
 * Run an external binary. Rejects with CliError on spawn failure, timeout, maxBuffer overflow,
 * or (unless allowNonZero) a non-zero exit code.
 *
 * Wave 9-J: this used execFile, whose timeout SIGTERMs only the DIRECT child. audioscript spawns
 * whisper/diarization workers, so after the 30-minute timeout they kept running on the GPU,
 * orphaned. The CLI now starts in its own process group (detached) and timeouts kill the whole
 * group — SIGTERM, then SIGKILL if it lingers.
 */
export function runCli(bin: string, args: string[], opts: RunCliOptions = {}): Promise<CliResult> {
  const {
    cwd, env, timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBuffer = DEFAULT_MAX_BUFFER, allowNonZero = false,
  } = opts;

  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(bin, args, {
        cwd, env: env ? { ...process.env, ...env } : process.env,
        detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(new CliError(`${bin} failed: ${(err as Error).message}`, bin, null, '', ''));
      return;
    }

    const out: Buffer[] = [];
    const errBuf: Buffer[] = [];
    let outLen = 0;
    let errLen = 0;
    let failure: string | null = null; // why WE ended it: timeout / maxBuffer
    let settled = false;

    const fail = (reason: string) => {
      if (failure) return;
      failure = reason;
      if (child.pid) killGroup(child.pid);
    };
    const timer = setTimeout(() => fail(`timed out after ${timeoutMs}ms (ETIMEDOUT)`), timeoutMs);

    child.stdout!.on('data', (d: Buffer) => {
      outLen += d.length;
      if (outLen > maxBuffer) { fail(`stdout exceeded maxBuffer (${maxBuffer} bytes)`); return; }
      out.push(d);
    });
    child.stderr!.on('data', (d: Buffer) => {
      errLen += d.length;
      if (errLen > maxBuffer) { fail(`stderr exceeded maxBuffer (${maxBuffer} bytes)`); return; }
      errBuf.push(d);
    });

    if (child.pid) activeGroups.add(child.pid);
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.pid) activeGroups.delete(child.pid);
      fn();
    };

    child.on('error', (err: NodeJS.ErrnoException) => finish(() => {
      const detail = err.code ? ` (${err.code})` : '';
      reject(new CliError(`${bin} failed${detail}: ${err.message}`, bin, null, '', ''));
    }));

    child.on('close', (code, signal) => finish(() => {
      const stdout = Buffer.concat(out).toString();
      const stderr = Buffer.concat(errBuf).toString();
      if (failure) {
        reject(new CliError(`${bin} failed: ${failure}${stderr ? '\n' + stderr.slice(0, 500) : ''}`, bin, null, stdout, stderr));
        return;
      }
      if (code === 0) { resolve({ stdout, stderr, code: 0 }); return; }
      if (code !== null && allowNonZero) { resolve({ stdout, stderr, code }); return; }
      const why = code !== null ? `exited with code ${code}` : `killed by ${signal}`;
      reject(new CliError(`${bin} failed: ${why}${stderr ? '\n' + stderr.slice(0, 500) : ''}`, bin, code, stdout, stderr));
    }));
  });
}

/**
 * Run an external binary and parse its stdout as JSON (T7 — never regex-scrape).
 * Throws CliError if the process fails, stdout is not valid JSON, or `validate`
 * (when supplied) rejects the parsed shape.
 */
export async function runCliJson<T = unknown>(
  bin: string,
  args: string[],
  opts: RunCliOptions = {},
  validate?: (value: unknown) => boolean,
): Promise<T> {
  const { stdout, stderr } = await runCli(bin, args, opts);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new CliError(
      `${bin} did not return valid JSON: ${stdout.slice(0, 200)}`,
      bin, 0, stdout, stderr,
    );
  }
  if (validate && !validate(parsed)) {
    throw new CliError(`${bin} returned unexpected JSON shape`, bin, 0, stdout, stderr);
  }
  return parsed as T;
}
