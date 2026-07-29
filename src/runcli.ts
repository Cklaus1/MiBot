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

import { execFile } from 'child_process';

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

/** Run an external binary. Rejects with CliError on spawn failure, timeout, or
 *  (unless allowNonZero) a non-zero exit code. */
export function runCli(bin: string, args: string[], opts: RunCliOptions = {}): Promise<CliResult> {
  const {
    cwd, env, timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBuffer = DEFAULT_MAX_BUFFER, allowNonZero = false,
  } = opts;

  return new Promise((resolve, reject) => {
    execFile(
      bin, args,
      { cwd, env: env ? { ...process.env, ...env } : process.env, timeout: timeoutMs, maxBuffer },
      (err, stdout, stderr) => {
        const out = stdout?.toString() ?? '';
        const errOut = stderr?.toString() ?? '';
        if (err) {
          // execFile sets err.code to the exit code (number) or a string like 'ENOENT'/'ETIMEDOUT'.
          const rawCode = (err as any).code;
          const code = typeof rawCode === 'number' ? rawCode : null;
          if (allowNonZero && code !== null) {
            resolve({ stdout: out, stderr: errOut, code });
            return;
          }
          const detail = typeof rawCode === 'string' ? ` (${rawCode})` : '';
          reject(new CliError(
            `${bin} failed${detail}: ${err.message}${errOut ? '\n' + errOut.slice(0, 500) : ''}`,
            bin, code, out, errOut,
          ));
          return;
        }
        resolve({ stdout: out, stderr: errOut, code: 0 });
      },
    );
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
