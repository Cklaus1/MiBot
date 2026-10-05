import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runCli, CliError, killActiveCliGroups } from '../src/runcli.js';
import { isPidAlive } from '../src/db.js';

// Wave 9-J: execFile's timeout SIGTERMs only the direct child. audioscript spawns whisper /
// diarization workers, so after the 30-min timeout those kept running on the GPU, orphaned.
// runCli now runs each CLI in its own process group and kills the whole group.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mibot-grp-'));
const waitDead = async (pid: number, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (!isPidAlive(pid)) return true; await new Promise((r) => setTimeout(r, 50)); }
  return !isPidAlive(pid);
};

/** A "CLI" that starts a long-lived worker (grandchild), records its pid, then waits on it. */
function spawnsWorker(name: string): { script: string; pidFile: string } {
  const pidFile = path.join(dir, `${name}.pid`);
  const script = path.join(dir, `${name}.sh`);
  fs.writeFileSync(script, `#!/bin/sh\nsleep 60 &\necho $! > '${pidFile}'\nwait\n`, { mode: 0o755 });
  return { script, pidFile };
}
const readPid = async (f: string) => {
  for (let i = 0; i < 100 && !fs.existsSync(f); i++) await new Promise((r) => setTimeout(r, 20));
  return Number(fs.readFileSync(f, 'utf8').trim());
};

describe('runCli kills the whole process group (Wave 9-J)', () => {
  it('a timeout kills the CLI AND the workers it spawned', async () => {
    const { script, pidFile } = spawnsWorker('timeout');
    const p = runCli(script, [], { timeoutMs: 300 });
    const worker = await readPid(pidFile);
    await expect(p).rejects.toThrow(/ETIMEDOUT|timed out/);
    expect(await waitDead(worker)).toBe(true); // was: still running, orphaned
  });

  it('a timeout error is still a CliError naming the binary', async () => {
    const { script } = spawnsWorker('named');
    const err = await runCli(script, [], { timeoutMs: 200 }).catch((e) => e);
    expect(err).toBeInstanceOf(CliError);
    expect(err.message).toContain(script);
  });

  it('shutdown kills groups still running (they no longer get the terminal\'s Ctrl+C)', async () => {
    const { script, pidFile } = spawnsWorker('shutdown');
    const p = runCli(script, [], { timeoutMs: 60_000 }).catch((e) => e);
    const worker = await readPid(pidFile);
    killActiveCliGroups();
    expect(await waitDead(worker)).toBe(true);
    await p;
  });

  it('exceeding maxBuffer kills the group and rejects (not a silent truncation)', async () => {
    const err = await runCli('sh', ['-c', 'yes | head -c 100000; sleep 30'], { maxBuffer: 1000, timeoutMs: 10_000 }).catch((e) => e);
    expect(err).toBeInstanceOf(CliError);
    expect(err.message).toMatch(/maxBuffer/i);
  });
});
