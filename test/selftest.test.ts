import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { runPreflight, preflightPassed, formatPreflight, defaultChecks, runLiveSelftest, explainCliFailure, type LiveDeps, type PreflightEnv } from '../src/selftest.js';

// Wave 10 #6: catch breakage before a real meeting does.
describe('runPreflight', () => {
  it('a check passes by resolving and fails by throwing; required failures fail the run', async () => {
    const r = await runPreflight([
      { name: 'good', required: true, run: async () => 'fine' },
      { name: 'warn', required: false, run: async () => { throw new Error('camofox down'); } },
    ]);
    expect(r.map((c) => [c.name, c.ok])).toEqual([['good', true], ['warn', false]]);
    expect(preflightPassed(r)).toBe(true); // only an optional one failed
    expect(preflightPassed([...r, { name: 'x', ok: false, required: true, detail: '' }])).toBe(false);
  });

  it('a hanging check is cut off and reported, not left to block', async () => {
    const r = await runPreflight([{ name: 'hang', required: true, run: () => new Promise(() => {}) }], 20);
    expect(r[0]).toMatchObject({ ok: false, detail: expect.stringContaining('timed out') });
  });

  it('formats ✓ / ! / ✗ and a verdict', () => {
    const text = formatPreflight([
      { name: 'ffmpeg', ok: true, required: true, detail: 'v6' },
      { name: 'camofox', ok: false, required: false, detail: 'down' },
      { name: 'disk', ok: false, required: true, detail: 'full' },
    ]);
    expect(text).toMatch(/✓ ffmpeg/); expect(text).toMatch(/! camofox/); expect(text).toMatch(/✗ disk/);
    expect(text).toContain('FAILED: 1 required check(s).');
  });
});

describe('defaultChecks', () => {
  const env = (o: Partial<PreflightEnv> = {}): PreflightEnv => ({
    recordingsDir: os.tmpdir(), notesFolder: fs.mkdtempSync(path.join(os.tmpdir(), 'mibot-st-notes-')),
    minFreeBytes: 1, dbVersion: () => ({ current: 12, latest: 12 }),
    camofoxReachable: async () => {}, launchChromium: async () => {}, calendars: [], playbooks: () => ['teams'], ...o,
  });
  const byName = async (e: PreflightEnv, name: string) => (await runPreflight(defaultChecks(e).filter((c) => c.name === name)))[0];
  const haveFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version']); return true; } catch { return false; } })();

  it.skipIf(!haveFfmpeg)('ffmpeg is found', async () => expect((await byName(env(), 'ffmpeg')).ok).toBe(true));
  it('disk space below the floor fails', async () => expect((await byName(env({ minFreeBytes: 1e18 }), 'disk space')).ok).toBe(false));
  it('a stale DB schema fails', async () => {
    expect((await byName(env({ dbVersion: () => ({ current: 9, latest: 12 }) }), 'database schema')))
      .toMatchObject({ ok: false, detail: 'schema v9, expected v12' });
  });
  it('no valid playbook fails', async () => expect((await byName(env({ playbooks: () => [] }), 'playbooks')).ok).toBe(false));
  it('camofox down is only a warning', async () => {
    const r = await byName(env({ camofoxReachable: async () => { throw new Error('ECONNREFUSED'); } }), 'camofox (Google Meet)');
    expect(r).toMatchObject({ ok: false, required: false });
  });
  it('an expired calendar login fails', async () => {
    const r = await byName(env({ calendars: [{ name: 'm365', probe: async () => { throw new Error('token expired'); } }] }), 'calendar: m365');
    expect(r).toMatchObject({ ok: false, required: true, detail: 'token expired' });
  });
});

describe('runLiveSelftest', () => {
  const deps = (o: Partial<LiveDeps> = {}) => {
    const stop = vi.fn().mockResolvedValue(undefined);
    const d: LiveDeps = {
      makeTone: async (out) => { fs.writeFileSync(out, 'wav'); },
      startSpeaker: vi.fn().mockResolvedValue({ stop }),
      runBot: vi.fn().mockResolvedValue({ meetingId: 1, audioPath: '/tmp/a.webm', consentPosted: 1 }),
      usableSeconds: vi.fn().mockResolvedValue(58),
      ...o,
    };
    return { d, stop };
  };

  it('passes when the recording holds audible audio for most of the window', async () => {
    const { d, stop } = deps();
    const r = await runLiveSelftest('https://zoom.us/j/room', 60, d);
    expect(r).toMatchObject({ ok: true, usableSec: 58 });
    expect(stop).toHaveBeenCalled();
  });

  it('FAILS when the recording is silent — the exact bug this exists to catch', async () => {
    const { d } = deps({ usableSeconds: vi.fn().mockResolvedValue(null) });
    const r = await runLiveSelftest('https://zoom.us/j/room', 60, d);
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toMatch(/no audible audio/);
  });

  it('fails on a recording much shorter than the window', async () => {
    const { d } = deps({ usableSeconds: vi.fn().mockResolvedValue(20) });
    expect((await runLiveSelftest('u', 60, d)).problems[0]).toMatch(/only 20s/);
  });

  it('flags a recording notice that could not be posted', async () => {
    const { d } = deps({ runBot: vi.fn().mockResolvedValue({ meetingId: 1, audioPath: 'a', consentPosted: 0 }) });
    expect((await runLiveSelftest('u', 60, d)).problems).toContain('the recording notice could not be posted to chat');
  });

  it('always stops the speaker and removes the tone, even when the bot fails', async () => {
    let tone = '';
    const { d, stop } = deps({
      makeTone: async (out) => { tone = out; fs.writeFileSync(out, 'wav'); },
      runBot: vi.fn().mockRejectedValue(new Error('join failed')),
    });
    const r = await runLiveSelftest('u', 60, d);
    expect(r.problems[0]).toMatch(/aborted: join failed/);
    expect(stop).toHaveBeenCalled();
    expect(fs.existsSync(tone)).toBe(false);
  });

  it('no test meeting configured → clear message, nothing launched', async () => {
    const { d } = deps();
    const r = await runLiveSelftest(undefined, 60, d);
    expect(r.problems[0]).toMatch(/no test meeting configured/);
    expect(d.startSpeaker).not.toHaveBeenCalled();
  });
});

describe('explainCliFailure (found live: both calendar logins had expired behind "killed by SIGTERM")', () => {
  it('an expired Microsoft refresh token → "login expired — run: …"', () => {
    const err = Object.assign(new Error('ms365 failed: killed by SIGTERM'), {
      stderr: 'Error: invalid_grant: AADSTS700082: The refresh token has expired due to inactivity.', stdout: '',
    });
    expect(explainCliFailure(err, 'ms365 auth login')).toBe('login expired — run: ms365 auth login');
  });
  it('a rejected Google grant (error JSON on stdout) → "login rejected — run: …"', () => {
    const err = Object.assign(new Error('gws failed: exited with code 2'), {
      stderr: 'Using keyring backend: keyring',
      stdout: '{ "error": { "code": 401, "message": "Authentication failed: invalid_grant: Bad Request" } }',
    });
    expect(explainCliFailure(err, 'gws auth login')).toBe('login rejected — run: gws auth login');
  });
  it('anything else → the most informative line, not the process status', () => {
    const err = Object.assign(new Error('x failed: exited with code 1'), { stderr: 'warming up\nError: network unreachable', stdout: '' });
    expect(explainCliFailure(err)).toBe('Error: network unreachable');
  });
});
