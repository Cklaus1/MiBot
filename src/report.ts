import { getDb } from './db.js';

/**
 * Wave 10 #1: `mibot report` — is MiBot actually doing its job? The baseline every reliability
 * change is measured against.
 *
 * Eligible = a meeting that was due and is finished: done, failed or missed. Cancelled and
 * skipped meetings didn't happen (or weren't wanted), so they aren't counted against it.
 * Success = done AND its recording ended 'done' (transcribed, with usable audio).
 */
export interface PlatformStats { eligible: number; succeeded: number; rate: number }

export interface Report {
  sinceIso: string;
  overall: PlatformStats;
  byPlatform: Record<string, PlatformStats>;
  /** Why the unsuccessful ones weren't: failure_reason, or the recording outcome for done meetings. */
  reasons: Record<string, number>;
  medianJoinSec: number | null;
  recentFailures: Array<{ title: string; platform: string; start_time: string; reason: string; step: string | null; screenshot: string | null }>;
}

const stats = (eligible: number, succeeded: number): PlatformStats =>
  ({ eligible, succeeded, rate: eligible ? succeeded / eligible : 0 });

export function buildReport(opts: { sinceMs: number; nowMs?: number; platform?: string }): Report {
  const db = getDb();
  const sinceIso = new Date(opts.sinceMs).toISOString();
  const platformFilter = opts.platform ? 'AND m.platform = ?' : '';
  const params = opts.platform ? [sinceIso, opts.platform] : [sinceIso];

  // One row per eligible meeting with its best recording outcome.
  const rows = db.prepare(`
    SELECT m.id, m.title, m.platform, m.start_time, m.status, m.failure_reason,
      (SELECT r.status FROM recordings r WHERE r.meeting_id = m.id
         ORDER BY (r.status = 'done') DESC, r.id DESC LIMIT 1) AS rec_status
    FROM meetings m
    WHERE m.status IN ('done', 'failed', 'missed')
      AND COALESCE(m.failure_reason, '') != 'skipped'  -- intentionally not joined (#5)
      AND COALESCE(m.is_selftest, 0) = 0               -- self-test runs (#6)
      AND datetime(m.start_time) >= datetime(?) ${platformFilter}
  `).all(...params) as Array<{ id: number; title: string; platform: string; start_time: string;
    status: string; failure_reason: string | null; rec_status: string | null }>;

  const per = new Map<string, { e: number; s: number }>();
  const reasons: Record<string, number> = {};
  let e = 0; let s = 0;
  for (const r of rows) {
    const ok = r.status === 'done' && r.rec_status === 'done';
    const p = per.get(r.platform) ?? { e: 0, s: 0 };
    p.e++; e++;
    if (ok) { p.s++; s++; } else {
      const why = r.status === 'done' ? (r.rec_status ?? 'no_audio') : (r.failure_reason ?? 'unknown_legacy');
      reasons[why] = (reasons[why] ?? 0) + 1;
    }
    per.set(r.platform, p);
  }

  const joins = (db.prepare(`
    SELECT (julianday(a.joined_at) - julianday(a.started_at)) * 86400.0 AS sec
    FROM join_attempts a JOIN meetings m ON m.id = a.meeting_id
    WHERE a.joined_at IS NOT NULL AND COALESCE(m.is_selftest, 0) = 0
      AND datetime(a.started_at) >= datetime(?) ${platformFilter}
    ORDER BY sec
  `).all(...params) as { sec: number }[]).map((r) => r.sec);
  const medianJoinSec = joins.length === 0 ? null
    : Math.round(joins.length % 2 ? joins[(joins.length - 1) / 2] : (joins[joins.length / 2 - 1] + joins[joins.length / 2]) / 2);

  const recentFailures = db.prepare(`
    SELECT m.title, m.platform, m.start_time, COALESCE(a.reason, m.failure_reason, 'unknown_legacy') AS reason,
      a.step, a.screenshot_path AS screenshot
    FROM meetings m LEFT JOIN join_attempts a ON a.id = (
      SELECT id FROM join_attempts WHERE meeting_id = m.id AND outcome = 'failed' ORDER BY attempt DESC LIMIT 1)
    WHERE m.status = 'failed' AND COALESCE(m.is_selftest, 0) = 0
      AND datetime(m.start_time) >= datetime(?) ${platformFilter}
    ORDER BY m.start_time DESC LIMIT 10
  `).all(...params) as Report['recentFailures'];

  return {
    sinceIso,
    overall: stats(e, s),
    byPlatform: Object.fromEntries([...per].map(([k, v]) => [k, stats(v.e, v.s)])),
    reasons,
    medianJoinSec,
    recentFailures,
  };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

export function formatReport(r: Report, days: number): string {
  const lines = [`MiBot report — last ${days} day(s) (since ${r.sinceIso.slice(0, 10)})`, ''];
  lines.push(`Success: ${r.overall.succeeded}/${r.overall.eligible} (${pct(r.overall.rate)})  — recorded and transcribed`);
  for (const [p, st] of Object.entries(r.byPlatform).sort()) lines.push(`  ${p.padEnd(6)} ${st.succeeded}/${st.eligible} (${pct(st.rate)})`);
  if (r.medianJoinSec !== null) lines.push(`Median time to join: ${r.medianJoinSec}s`);
  const rs = Object.entries(r.reasons).sort((a, b) => b[1] - a[1]);
  if (rs.length) {
    lines.push('', 'Why the rest failed:');
    for (const [k, v] of rs) lines.push(`  ${String(v).padStart(4)}  ${k}${k === 'unknown_legacy' ? '  (before diagnostics existed)' : ''}`);
  }
  if (r.recentFailures.length) {
    lines.push('', 'Recent failures:');
    for (const f of r.recentFailures) {
      lines.push(`  ${f.start_time.slice(0, 16).replace('T', ' ')}  ${f.platform.padEnd(5)}  ${f.reason}${f.step ? ` @ ${f.step}` : ''}  — ${f.title}`);
      if (f.screenshot) lines.push(`      screenshot: ${f.screenshot}`);
    }
  }
  return lines.join('\n');
}
