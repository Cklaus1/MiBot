import fs from 'fs';
import path from 'path';
import type { Page } from 'playwright';
import { PlaybookStepError } from './playbook.js';
import { loadSelectors } from './selectors.js';
import { imageExtension } from './image-similarity.js';
import type { FailureReason } from './status.js';

/**
 * Wave 10 #1: explain a failed bot run. 608 of 1,066 production meetings were 'failed' with no
 * record of why, so no reliability fix could be measured. classifyJoinFailure is pure;
 * captureFailureContext does the (bounded, never-throwing) page I/O.
 */
export interface FailureDiagnosis {
  reason: FailureReason;
  /** Which playbook step failed, e.g. 'step 7: click role=button "Join now"'. */
  step?: string;
  detail: string;
  screenshotPath?: string;
}

const has = (text: string, phrases: string[]) => {
  const lower = text.toLowerCase();
  return phrases.some((p) => p && lower.includes(p.toLowerCase()));
};

export function classifyJoinFailure(input: {
  err: unknown;
  platform: string;
  /** Visible text of the page at the moment of failure ('' if unavailable). */
  pageText: string;
  /** True if the bot had reached in_call before it failed. */
  reachedCall?: boolean;
}): FailureDiagnosis {
  const err = input.err instanceof Error ? input.err : new Error(String(input.err));
  const step = err instanceof PlaybookStepError ? err.stepLabel : undefined;
  const detail = (err instanceof PlaybookStepError ? err.cause.message : err.message).slice(0, 500);
  const withStep = (reason: FailureReason): FailureDiagnosis => (step ? { reason, step, detail } : { reason, detail });

  if (input.reachedCall) return withStep('error_in_call');
  if (/Camofox not (running|ready)/i.test(err.message)) return withStep('camofox_unavailable');
  if (/browserType\.launch|Failed to launch|Executable doesn't exist/i.test(err.message)) return withStep('browser_launch_failed');

  // What the page says beats what the playbook was doing: a step "failed" because we were
  // still in the lobby is a waiting-room problem, not a selector problem.
  const sel = loadSelectors(input.platform);
  const text = input.pageText || '';
  if (has(text, sel.notAdmittedText)) return withStep('not_admitted');
  if (has(text, sel.authRequiredText)) return withStep('auth_required');
  if (has(text, sel.notStartedText)) return withStep('meeting_not_started');
  if (has(text, sel.waitingRoomText)) return withStep('waiting_room_timeout');

  if (err instanceof PlaybookStepError) return withStep('join_step_failed');
  return withStep('internal_error');
}

/** Minimal camofox surface used here (kept structural to avoid an import cycle). */
interface CamofoxLike {
  snapshot(): Promise<{ snapshot: string }>;
  screenshot(opts?: { path?: string }): Promise<Buffer>;
}

const withTimeout = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
  Promise.race([p.catch(() => fallback), new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);

/**
 * Grab what the bot was looking at when it failed: visible text (all frames — Zoom's client is
 * an iframe) and a screenshot saved to `failuresDir`. Bounded to a few seconds and never throws:
 * it runs on the failure path, which must always complete.
 */
export async function captureFailureContext(opts: {
  page?: Page | null;
  camofox?: CamofoxLike | null;
  failuresDir: string;
  name: string;
  timeoutMs?: number;
}): Promise<{ pageText: string; screenshotPath?: string }> {
  const ms = opts.timeoutMs ?? 5000;
  let pageText = '';
  let shot: Buffer | null = null;
  try {
    if (opts.page && !opts.page.isClosed()) {
      const texts = await withTimeout(Promise.all(opts.page.frames().map((f) =>
        f.evaluate(() => document.body?.innerText ?? '').catch(() => ''))), ms, [] as string[]);
      pageText = texts.join('\n');
      shot = await withTimeout(opts.page.screenshot(), ms, null as Buffer | null);
    } else if (opts.camofox) {
      pageText = (await withTimeout(opts.camofox.snapshot(), ms, { snapshot: '' })).snapshot;
      shot = await withTimeout(opts.camofox.screenshot(), ms, null as Buffer | null);
    }
  } catch { /* best effort */ }

  let screenshotPath: string | undefined;
  if (shot && shot.length > 0) {
    try {
      fs.mkdirSync(opts.failuresDir, { recursive: true });
      screenshotPath = path.join(opts.failuresDir, `${opts.name}.${imageExtension(shot)}`);
      fs.writeFileSync(screenshotPath, shot);
    } catch { screenshotPath = undefined; }
  }
  return { pageText, screenshotPath };
}
