import fs from 'fs';
import os from 'os';
import path from 'path';
import { runCli } from './runcli.js';

/**
 * Wave 10 #6: catch breakage before a real meeting does. The silent-recording bug survived for
 * months because nothing exercised the real audio path.
 *
 *  - Preflight: fast, no meeting. Required checks fail the run; optional ones only warn.
 *  - Live: the recorder bot joins the operator's test room while a second "speaker" browser
 *    plays a known tone into it, then the recording must contain audible audio for most of
 *    the window. Everything external is injected, so the orchestration is unit-testable.
 */
export interface CheckResult { name: string; ok: boolean; required: boolean; detail: string }
export interface Check { name: string; required: boolean; run: () => Promise<string> }

/** Run every check (bounded, never throwing); a check passes by resolving, fails by throwing. */
export async function runPreflight(checks: Check[], timeoutMs = 45_000): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  for (const c of checks) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const detail = await Promise.race([
        c.run(),
        new Promise<string>((_, rej) => { timer = setTimeout(() => rej(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs); }),
      ]);
      out.push({ name: c.name, ok: true, required: c.required, detail });
    } catch (err) {
      out.push({ name: c.name, ok: false, required: c.required, detail: (err as Error).message.split('\n')[0].slice(0, 200) });
    } finally { clearTimeout(timer); }
  }
  return out;
}

export const preflightPassed = (r: CheckResult[]) => r.every((c) => c.ok || !c.required);

export function formatPreflight(results: CheckResult[]): string {
  const lines = results.map((r) => `${r.ok ? '✓' : r.required ? '✗' : '!'} ${r.name.padEnd(26)} ${r.detail}`);
  const failed = results.filter((r) => !r.ok && r.required).length;
  const warned = results.filter((r) => !r.ok && !r.required).length;
  lines.push('', failed ? `FAILED: ${failed} required check(s).` : `OK${warned ? ` (${warned} warning${warned > 1 ? 's' : ''})` : ''}.`);
  return lines.join('\n');
}

/**
 * Turn a failed CLI call into its real reason. The process-level message ("killed by SIGTERM",
 * "exited with code 2") hid that both calendar logins had expired; the cause is in the tool's
 * own output. An auth failure gets the command that fixes it.
 */
export function explainCliFailure(err: unknown, loginHint?: string): string {
  const e = err as { message?: string; stdout?: string; stderr?: string };
  const text = [e.stderr, e.stdout, e.message].filter(Boolean).join('\n');
  if (/invalid_grant|refresh token has expired|AADSTS70008|Authentication failed|unauthorized|\b401\b|not logged in|no cached account/i.test(text)) {
    const expired = /expired|inactiv/i.test(text) ? 'login expired' : 'login rejected';
    return loginHint ? `${expired} — run: ${loginHint}` : expired;
  }
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  return (lines.find((l) => /error/i.test(l)) ?? lines[0] ?? 'failed').slice(0, 200);
}

/** Free bytes on the filesystem holding `dir` (its nearest existing ancestor). */
export function freeBytes(dir: string): number {
  let d = dir;
  while (!fs.existsSync(d) && path.dirname(d) !== d) d = path.dirname(d);
  const st = fs.statfsSync(d);
  return st.bavail * st.bsize;
}

export interface PreflightEnv {
  recordingsDir: string;
  notesFolder: string;
  minFreeBytes: number;
  dbVersion: () => { current: number; latest: number };
  camofoxReachable: () => Promise<void>;
  launchChromium: () => Promise<void>;
  calendars: Array<{ name: string; probe: () => Promise<void> }>;
  playbooks: () => string[]; // platforms whose playbook loaded and validated
}

/** The real checks. Each throws with a one-line explanation on failure. */
export function defaultChecks(env: PreflightEnv): Check[] {
  const bin = (name: string, args: string[], required: boolean): Check => ({
    name, required,
    run: async () => {
      const out = (await runCli(name, args, { timeoutMs: 20_000 })).stdout;
      return out.split('\n').map((l) => l.trim()).find(Boolean)?.slice(0, 60) ?? 'present';
    },
  });
  return [
    bin('ffmpeg', ['-version'], true),
    bin('ffprobe', ['-version'], true),
    bin('audioscript', ['--help'], true),
    { name: 'chromium launches', required: true, run: async () => { await env.launchChromium(); return 'ok'; } },
    { name: 'camofox (Google Meet)', required: false, run: async () => { await env.camofoxReachable(); return 'reachable'; } },
    ...env.calendars.map((c) => ({ name: `calendar: ${c.name}`, required: true, run: async () => { await c.probe(); return 'authenticated'; } })),
    { name: 'playbooks', required: true, run: async () => {
      const ok = env.playbooks();
      if (ok.length === 0) throw new Error('no valid playbook found');
      return ok.join(', ');
    } },
    { name: 'disk space', required: true, run: async () => {
      const free = freeBytes(env.recordingsDir);
      if (free < env.minFreeBytes) throw new Error(`${(free / 1e9).toFixed(1)} GB free, need ${(env.minFreeBytes / 1e9).toFixed(1)} GB`);
      return `${(free / 1e9).toFixed(1)} GB free`;
    } },
    { name: 'database schema', required: true, run: async () => {
      const v = env.dbVersion();
      if (v.current !== v.latest) throw new Error(`schema v${v.current}, expected v${v.latest}`);
      return `v${v.current}`;
    } },
    { name: 'notes folder writable', required: false, run: async () => {
      fs.mkdirSync(env.notesFolder, { recursive: true });
      const probe = path.join(env.notesFolder, `.mibot-write-test-${process.pid}`);
      fs.writeFileSync(probe, 'ok'); fs.unlinkSync(probe);
      return env.notesFolder;
    } },
  ];
}

// ── Live ────────────────────────────────────────────────────────────────

export interface LiveDeps {
  /** Start the speaker browser in the meeting, playing `tonePath`. Returns its stopper. */
  startSpeaker: (url: string, tonePath: string) => Promise<{ stop: () => Promise<void> }>;
  /** Run the recorder bot for `seconds` in the call; resolves with the meeting/recording result. */
  runBot: (url: string, seconds: number) => Promise<{ meetingId: number; audioPath: string; consentPosted: number | null }>;
  /** Seconds of usable (non-silent) audio in a file, or null. */
  usableSeconds: (audioPath: string) => Promise<number | null>;
  /** Write a tone WAV of `seconds` to `out`. */
  makeTone: (out: string, seconds: number) => Promise<void>;
}

export interface LiveResult { ok: boolean; problems: string[]; usableSec: number | null; windowSec: number }

export async function runLiveSelftest(url: string | undefined, windowSec: number, deps: LiveDeps): Promise<LiveResult> {
  if (!url) return { ok: false, problems: ['no test meeting configured for this platform (selftest.testMeetings in config.json)'], usableSec: null, windowSec };
  const tone = path.join(os.tmpdir(), `mibot-selftest-tone-${process.pid}.wav`);
  const problems: string[] = [];
  let speaker: { stop: () => Promise<void> } | null = null;
  let usableSec: number | null = null;
  try {
    await deps.makeTone(tone, windowSec + 120);
    speaker = await deps.startSpeaker(url, tone);
    const r = await deps.runBot(url, windowSec);
    usableSec = await deps.usableSeconds(r.audioPath);
    if (usableSec === null) problems.push('the recording has no audible audio (silent or missing) — the capture path is broken');
    else if (usableSec < windowSec * 0.8) problems.push(`only ${usableSec.toFixed(0)}s of audio in a ${windowSec}s window`);
    if (r.consentPosted === 0) problems.push('the recording notice could not be posted to chat');
  } catch (err) {
    problems.push(`live test aborted: ${(err as Error).message.split('\n')[0]}`);
  } finally {
    if (speaker) await speaker.stop().catch(() => {});
    try { fs.unlinkSync(tone); } catch { /* not created */ }
  }
  return { ok: problems.length === 0, problems, usableSec, windowSec };
}
