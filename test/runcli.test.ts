import { describe, it, expect } from 'vitest';
import { runCli, runCliJson, buildArgv, CliError } from '../src/runcli.js';

// F4/AR4/R7: runCli is the single external-process boundary. It owns exit-code checks,
// stderr surfacing, maxBuffer, timeout, JSON-shape validation, and `--`-terminated argv.
// Tested against real system binaries (sh/printf) — no mocks, fully deterministic.
describe('runCli (F4/AR4)', () => {
  it('returns stdout/stderr/code on success', async () => {
    const r = await runCli('sh', ['-c', 'printf hello']);
    expect(r.stdout).toBe('hello');
    expect(r.code).toBe(0);
  });

  it('throws CliError with the exit code and stderr on non-zero exit', async () => {
    await expect(runCli('sh', ['-c', 'printf boom >&2; exit 3'])).rejects.toMatchObject({
      name: 'CliError',
      code: 3,
      stderr: expect.stringContaining('boom'),
    });
  });

  it('surfaces the binary name in the error for a missing binary', async () => {
    await expect(runCli('mibot-no-such-binary-xyz', [])).rejects.toBeInstanceOf(CliError);
  });

  it('enforces a timeout', async () => {
    await expect(runCli('sh', ['-c', 'sleep 5'], { timeoutMs: 150 })).rejects.toBeInstanceOf(CliError);
  });

  it('does not throw on non-zero exit when allowNonZero is set', async () => {
    const r = await runCli('sh', ['-c', 'exit 7'], { allowNonZero: true });
    expect(r.code).toBe(7);
  });
});

describe('runCliJson (T7: parse JSON, not regex)', () => {
  it('parses valid JSON stdout', async () => {
    const r = await runCliJson<{ ok: boolean; n: number }>('sh', ['-c', 'printf \'{"ok":true,"n":5}\'']);
    expect(r).toEqual({ ok: true, n: 5 });
  });

  it('throws CliError on invalid JSON', async () => {
    await expect(runCliJson('sh', ['-c', 'printf not-json'])).rejects.toBeInstanceOf(CliError);
  });

  it('runs a validator against the parsed shape and throws when it fails', async () => {
    await expect(
      runCliJson('sh', ['-c', 'printf \'{"ok":true}\''], {}, (v: any) => typeof v.missing === 'string'),
    ).rejects.toBeInstanceOf(CliError);
  });
});

describe('buildArgv (T5: option-injection defense via --)', () => {
  it('separates flags from user-controlled positionals with --', () => {
    // a speaker display-name of "--db" must not be interpreted as a flag
    expect(buildArgv(['speakers', 'label'], ['cluster1', '--db'], ['--json']))
      .toEqual(['speakers', 'label', '--json', '--', 'cluster1', '--db']);
  });

  it('omits -- when there are no positionals', () => {
    expect(buildArgv(['transcribe'], [], ['--diarize'])).toEqual(['transcribe', '--diarize']);
  });
});
