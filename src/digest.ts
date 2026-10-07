/**
 * Wave 10 #3: the post-meeting note. Pure — built from the meeting row, its recording, its join
 * attempts and audioscript's artifacts (passed in already read), so content is snapshot-testable.
 * Transcript-derived text (summary, action items) is untrusted spoken content; it is only ever
 * written into the operator's own notes, never executed or sent anywhere.
 */
export interface DigestInput {
  meeting: {
    id: number; title: string; platform: string; start_time: string; status: string;
    actual_start: string | null; actual_end: string | null; participants: string | null;
    failure_reason: string | null; failure_detail: string | null;
    consent_posted: number | null; stopped_by: string | null;
  };
  recording: { status: string; transcript_path: string | null } | null;
  attempts: Array<{ attempt: number; reason: string | null; step: string | null; screenshot_path: string | null }>;
  summary: string | null;
  /** audioscript transcript JSON (for llm_analysis), or null. */
  transcript: any;
  timezone: string;
}

export interface Digest {
  /** File name stem: "2026-10-07 1500 Design review". */
  stem: string;
  markdown: string;
}

const REASON_TEXT: Record<string, string> = {
  waiting_room_timeout: 'stuck in the waiting room — not admitted in time',
  meeting_not_started: 'the host never started the meeting',
  not_admitted: 'not admitted (denied or removed)',
  auth_required: 'the meeting requires signing in',
  join_step_failed: 'a join step failed (the playbook may need updating)',
  camofox_unavailable: 'the Meet browser (camofox) was not running',
  browser_launch_failed: 'the browser failed to start',
  crashed: 'MiBot crashed during the meeting',
  error_in_call: 'an error interrupted the recording',
  missed: 'MiBot was not running when the meeting happened',
  no_audio: 'no audio was captured',
  transcribe_failed: 'transcription failed',
  internal_error: 'an internal error',
};

function localParts(iso: string, tz: string): { date: string; time: string; hhmm: string } {
  const d = new Date(iso);
  const fmt = (o: Intl.DateTimeFormatOptions) => {
    try { return new Intl.DateTimeFormat('en-CA', { ...o, timeZone: tz }).format(d); }
    catch { return new Intl.DateTimeFormat('en-CA', { ...o, timeZone: 'UTC' }).format(d); }
  };
  const date = fmt({ year: 'numeric', month: '2-digit', day: '2-digit' });
  const time = fmt({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return { date, time, hhmm: time.replace(':', '') };
}

/** A filename-safe version of a meeting title (no path separators or reserved characters). */
export function safeTitle(title: string): string {
  return (title || 'Untitled meeting').replace(/[\\/:*?"<>|#\[\]\n\r\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Untitled meeting';
}

const yaml = (v: string) => JSON.stringify(v); // valid YAML scalar for any string

export function buildDigest(input: DigestInput): Digest {
  const { meeting: m, recording: r } = input;
  const { date, time, hhmm } = localParts(m.actual_start ?? m.start_time, input.timezone);
  const title = safeTitle(m.title);
  const recorded = m.status === 'done' && r?.status === 'done';
  const minutes = m.actual_start && m.actual_end
    ? Math.max(0, Math.round((Date.parse(m.actual_end) - Date.parse(m.actual_start)) / 60000)) : null;
  let people: Array<{ name: string; is_bot?: boolean; spoke?: boolean }> = [];
  try { const p = JSON.parse(m.participants ?? '[]'); if (Array.isArray(p)) people = p; } catch { /* none */ }
  const humans = people.filter((p) => !p.is_bot);

  // Why it isn't a normal recording, if it isn't.
  let reason: string | null = null;
  if (!recorded) {
    const code = m.status === 'done' ? (r?.status ?? 'no_audio') : (m.failure_reason ?? 'internal_error');
    reason = code;
  }

  const fm = [
    '---',
    `date: ${date} ${time}`,
    `platform: ${m.platform}`,
    ...(minutes !== null ? [`duration_min: ${minutes}`] : []),
    `outcome: ${recorded ? 'recorded' : `not recorded (${reason})`}`,
    `participants: [${humans.map((p) => yaml(p.name)).join(', ')}]`,
    `mibot_meeting_id: ${m.id}`,
    '---',
  ];
  const out: string[] = [...fm, '', `# ${m.title || 'Untitled meeting'}`, ''];
  out.push(`**${date} ${time}** · ${m.platform}${minutes !== null ? ` · ${minutes} min` : ''}`, '');

  if (m.consent_posted === 0) out.push('> ⚠️ **Participants were not notified** — the recording notice could not be posted to chat.', '');
  if (m.stopped_by) out.push(`> Recording stopped early: **${m.stopped_by}** asked the bot to leave.`, '');

  if (!recorded) {
    const why = reason ? (REASON_TEXT[reason] ?? reason) : 'unknown';
    out.push(`## Not recorded`, '', `Reason: **${why}**${reason && REASON_TEXT[reason] ? ` (\`${reason}\`)` : ''}`);
    if (m.failure_detail) out.push('', `Detail: ${m.failure_detail}`);
    if (input.attempts.length > 0) {
      out.push('', `Join attempts: ${input.attempts.length}`);
      for (const a of input.attempts) {
        out.push(`- #${a.attempt}: ${a.reason ?? 'completed'}${a.step ? ` @ ${a.step}` : ''}${a.screenshot_path ? ` — [screenshot](<${a.screenshot_path}>)` : ''}`);
      }
    }
    out.push('');
  }

  const llm = input.transcript?.llm_analysis ?? {};
  const summary = (input.summary ?? llm.summary ?? '').toString().trim();
  if (summary) out.push('## Summary', '', summary, '');

  const items: any[] = Array.isArray(llm.action_items) ? llm.action_items : [];
  if (items.length) {
    out.push('## Action items', '');
    for (const it of items) {
      const text = typeof it === 'string' ? it : (it?.text ?? it?.task ?? '');
      if (!text) continue;
      const who = it?.assignee ? ` — ${it.assignee}` : '';
      const due = it?.deadline ? ` (due ${it.deadline})` : '';
      out.push(`- [ ] ${text}${who}${due}`);
    }
    out.push('');
  }
  const decisions: any[] = Array.isArray(llm.key_decisions) ? llm.key_decisions : [];
  if (decisions.length) out.push('## Decisions', '', ...decisions.map((d) => `- ${d}`), '');

  if (humans.length) out.push('## Participants', '', ...humans.map((p) => `- ${p.name}${p.spoke ? ' (spoke)' : ''}`), '');
  if (r?.transcript_path) out.push('## Files', '', `- Transcript: [${r.transcript_path.split('/').pop()}](<${r.transcript_path}>)`, '');

  return { stem: `${date} ${hhmm} ${title}`, markdown: out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n' };
}
