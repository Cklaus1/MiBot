import {
  getMeetingByEventId, getMeetingByJoinUrlAndTime, getScheduledEventIds, cancelMeeting,
  insertMeeting, updateMeeting, type Meeting, type Attendee,
} from './db.js';
import { detectPlatform } from './bot.js';
import { fmtTime } from './config.js';
import { runCli, CliError } from './runcli.js';

/** Hardcoded dev fallback for the gwscli binary; only used when GWS_PATH is unset. */
const GWS_DEFAULT_PATH = '/root/projects/gwscli/target/release/gws';

/**
 * CA11: decide how to treat the gwscli binary. An explicitly-set GWS_PATH that points at a
 * missing file is a misconfiguration and must WARN (previously it silently returned [], so
 * Google sync just stopped). An unset var falling back to the hardcoded dev default that
 * isn't present means Google sync was never configured on this machine → silent skip.
 */
export function resolveGwsBinary(
  envPath: string | undefined,
  exists: (p: string) => boolean,
): { action: 'run'; path: string } | { action: 'warn'; path: string } | { action: 'skip' } {
  const explicit = !!envPath;
  const p = envPath || GWS_DEFAULT_PATH;
  if (exists(p)) return { action: 'run', path: p };
  return explicit ? { action: 'warn', path: p } : { action: 'skip' };
}

/** Run a calendar CLI, tolerating a non-zero exit that still printed JSON to stdout (the
 *  prior execFile catch relied on this). Rethrows only when there is no stdout to parse. */
async function runCliRecoverStdout(bin: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await runCli(bin, args, { timeoutMs: 15000 });
    return stdout;
  } catch (err) {
    if (err instanceof CliError && err.stdout.trim()) return err.stdout;
    throw err;
  }
}

/** Meeting URL regex — the single source of truth for what counts as a joinable link. */
const MEETING_URL_PATTERN = /https?:\/\/(?:[\w-]+\.)?(?:zoom\.us|teams\.microsoft\.com|teams\.live\.com|meet\.google\.com)\/[^\s"<>)]+/i;

/**
 * AR7: extract the first known-platform meeting URL from an ordered list of candidate
 * strings. Providers build the candidate list in priority order (e.g. joinUrl before body),
 * so "first match wins" here IS the platform-precedence rule — no per-provider divergence.
 * (CA5 lives here: whoever composes the candidate order decides precedence.)
 */
export function extractMeetingUrl(candidates: (string | undefined | null)[]): string | null {
  for (const text of candidates) {
    if (!text) continue;
    const m = text.match(MEETING_URL_PATTERN);
    if (m) return m[0];
  }
  return null;
}

/** Strip HTML tags for a plain-text description. */
function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * CA6: decode the HTML entities that matter for URLs before extraction. A meeting link inside
 * an HTML body arrives as `…?pwd=a&amp;role=1`; the URL charset would capture the literal
 * `&amp;`, storing a broken join_url. Decode ampersand (named + numeric) and the common
 * entities so the regex sees a real URL. Applied only to HTML-bearing candidates (body/desc).
 */
export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

/**
 * AR7 seam — provider-neutral calendar event. M365 and Google each map their native shape
 * to this; the single normalizer below turns a batch of these into insertable meetings.
 * `urlCandidates` is ordered by platform precedence; `description` may still contain HTML.
 */
export interface RawCalendarEvent {
  calendar_event_id: string;
  title: string;
  urlCandidates: (string | undefined | null)[];
  /** CA8: undefined for all-day / start-less events; the normalizer drops these rather than
   *  fabricating a midnight or now() start that would trigger an immediate join. */
  start_time?: string;
  end_time?: string;
  organizer?: string;
  organizer_email?: string;
  location?: string;
  description?: string;
  attendees?: Attendee[];
  is_recurring?: boolean;
  recurrence_id?: string;
}

/** A raw event resolved to a concrete platform + join URL, ready for insertMeeting. */
export type NormalizedMeeting = Parameters<typeof insertMeeting>[0] & { platform: string };

/**
 * AR7: the ONE normalizer. Runs once over a batch (single- or cross-provider):
 *   - URL extraction + platform detection (drops events with no joinable link)
 *   - HTML-strip + 2000-char truncate of description
 *   - in-batch dedup by join_url + start_time (first occurrence wins) — the home CA4 wires
 *     cross-provider dedup into by feeding it both providers' raw events together.
 */
export function normalizeEvents(events: RawCalendarEvent[]): NormalizedMeeting[] {
  const out: NormalizedMeeting[] = [];
  const seen = new Set<string>();
  for (const ev of events) {
    // CA8: skip all-day / start-less events — no dateTime means no join time.
    if (!ev.start_time) continue;
    const url = extractMeetingUrl(ev.urlCandidates);
    if (!url) continue;
    const platform = detectPlatform(url);
    if (!platform) continue;

    const dedupKey = `${url} ${ev.start_time}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    out.push({
      title: ev.title || 'Untitled meeting',
      platform,
      join_url: url,
      start_time: ev.start_time,
      end_time: ev.end_time,
      calendar_event_id: ev.calendar_event_id,
      organizer: ev.organizer,
      organizer_email: ev.organizer_email,
      location: ev.location,
      description: ev.description ? stripHtml(ev.description).substring(0, 2000) : undefined,
      attendees: ev.attendees && ev.attendees.length > 0 ? ev.attendees : undefined,
      is_recurring: ev.is_recurring,
      recurrence_id: ev.recurrence_id,
    });
  }
  return out;
}

/** The joinable fields worth reconciling when a calendar event changes (CA2). */
type MeetingDiff = Partial<Pick<NormalizedMeeting, 'start_time' | 'end_time' | 'join_url' | 'title'>>;

/**
 * CA2: compute what changed on a still-scheduled meeting between the stored row and the freshly
 * synced event. Returns only the fields that actually differ (times compared as instants so
 * equivalent ISO spellings don't churn), or null when nothing joinable changed. A meeting that
 * already left 'scheduled' is never rescheduled — it's mid-flight and its start is now history.
 */
export function diffMeetingFields(existing: Meeting, incoming: NormalizedMeeting): MeetingDiff | null {
  if (existing.status !== 'scheduled') return null;
  const diff: MeetingDiff = {};
  const sameInstant = (a: string | null, b: string | undefined) =>
    (a ?? null) === (b ?? null) || (!!a && !!b && new Date(a).getTime() === new Date(b).getTime());
  if (!sameInstant(existing.start_time, incoming.start_time)) diff.start_time = incoming.start_time;
  if (!sameInstant(existing.end_time, incoming.end_time)) diff.end_time = incoming.end_time ?? undefined;
  if (existing.join_url !== incoming.join_url) diff.join_url = incoming.join_url;
  if (existing.title !== incoming.title) diff.title = incoming.title;
  return Object.keys(diff).length > 0 ? diff : null;
}

/**
 * Insert new meetings and reconcile changed ones (CA2). Shared by both providers so the
 * "known event → reschedule; unknown event → insert (with CA4 cross-provider guard)" logic
 * lives once. Returns the rows that were newly inserted.
 */
function persistNew(meetings: NormalizedMeeting[], providerLabel: string): Meeting[] {
  const inserted: Meeting[] = [];
  for (const nm of meetings) {
    // CA2: a known event id may have been rescheduled/renamed — update in place instead of skip.
    if (nm.calendar_event_id) {
      const existing = getMeetingByEventId(nm.calendar_event_id);
      if (existing) {
        const diff = diffMeetingFields(existing, nm);
        if (diff) {
          updateMeeting(existing.id, diff);
          console.error(`[mibot] Updated${providerLabel}: ${nm.title} — ${Object.keys(diff).join(', ')} changed`);
        }
        continue;
      }
    }
    // CA4: skip if another provider already inserted this same call (same join_url + start_time
    // under a different event id) — otherwise MiBot joins the meeting twice.
    if (getMeetingByJoinUrlAndTime(nm.join_url, nm.start_time)) continue;
    const meeting = insertMeeting(nm);
    inserted.push(meeting);
    const attCount = nm.attendees?.length ?? 0;
    const attStr = attCount > 0 ? ` (${attCount} attendees)` : '';
    console.error(`[mibot] Found${providerLabel}: ${meeting.title} (${nm.platform}) at ${fmtTime(nm.start_time)}${attStr}`);
  }
  return inserted;
}

/**
 * CA2: cancel scheduled meetings whose event id was present before but has now disappeared from
 * this provider's sync window (organizer deleted the event). `seenIds` is every event id the
 * current sync returned for `prefix`; any still-scheduled row under that prefix not in the set
 * is marked cancelled so MiBot doesn't join a meeting that no longer exists.
 */
function cancelDisappeared(prefix: string, seenIds: Set<string>): void {
  for (const id of getScheduledEventIds(prefix)) {
    if (!seenIds.has(id) && cancelMeeting(id)) {
      console.error(`[mibot] Cancelled: event ${id} left the calendar window`);
    }
  }
}

/**
 * CA1: parse a calendar CLI's stdout into the events array, rejecting the failure shapes that
 * were previously swallowed. ms365/gws can exit non-zero and still print valid JSON — either an
 * error object (`{"error":{…}}`) or an unexpected shape — which the old `data.value || []` read
 * as "zero meetings, no error". Here an error payload or a shape with no events array throws, so
 * syncCalendar's catch logs and surfaces it instead of silently dropping the day's meetings.
 */
export function parseEventsPayload(stdout: string): Record<string, any>[] {
  const data = JSON.parse(stdout); // throws on non-JSON — caught upstream
  if (data && typeof data === 'object' && 'error' in data) {
    const code = (data as any).error?.code || (data as any).error?.message || 'unknown';
    throw new Error(`calendar API returned an error payload: ${code}`);
  }
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.value)) return data.value; // M365 Graph
  if (Array.isArray(data?.items)) return data.items; // Google
  throw new Error(`calendar response had no events array (keys: ${Object.keys(data ?? {}).join(',') || 'none'})`);
}

// ── Provider adapters: native event → RawCalendarEvent[] ────────────────

/** Extract attendees from an M365 event. */
function m365Attendees(event: Record<string, unknown>): Attendee[] {
  const list = event.attendees as Array<Record<string, unknown>> | undefined;
  if (!list) return [];
  return list.map((att) => {
    const ea = att.emailAddress as Record<string, unknown> | undefined;
    const status = att.status as Record<string, unknown> | undefined;
    return {
      name: (ea?.name as string) || '',
      email: (ea?.address as string) || '',
      status: (status?.response as string) || 'none',
    };
  });
}

/** Map one M365 Graph event to the provider-neutral RawCalendarEvent. */
export function m365ToRaw(event: Record<string, unknown>): RawCalendarEvent {
  const loc = event.location as Record<string, unknown> | undefined;
  const body = event.body as Record<string, unknown> | undefined;
  const online = event.onlineMeeting as Record<string, unknown> | undefined;
  const org = event.organizer as Record<string, unknown> | undefined;
  const orgEa = org?.emailAddress as Record<string, unknown> | undefined;
  const start = event.start as Record<string, unknown> | undefined;
  const end = event.end as Record<string, unknown> | undefined;
  return {
    calendar_event_id: `m365:${event.id}`,
    title: (event.subject as string) || 'Untitled meeting',
    // CA5 precedence: organizer's chosen platform (location, e.g. a pasted Meet link) first,
    // then the AUTHORITATIVE onlineMeeting.joinUrl, then the body last — so a stale link quoted
    // in the body can never beat the real joinUrl (the previous order had body before joinUrl).
    urlCandidates: [
      loc?.displayName as string | undefined,
      online?.joinUrl as string | undefined,
      // CA6: the body is HTML — decode entities so `&amp;` in a URL doesn't survive into join_url.
      body?.content ? decodeHtmlEntities(body.content as string) : undefined,
    ],
    // CA8: no dateTime → undefined (normalizer drops it); don't fabricate a now() start.
    start_time: (start?.dateTime as string) || undefined,
    end_time: (end?.dateTime as string) || undefined,
    organizer: (orgEa?.name as string) || undefined,
    organizer_email: (orgEa?.address as string) || undefined,
    location: loc?.displayName as string | undefined,
    description: (body?.content as string) || undefined,
    attendees: m365Attendees(event),
    is_recurring: event.type === 'occurrence' || event.type === 'seriesMaster',
    recurrence_id: (event.seriesMasterId as string) || undefined,
  };
}

/** Map one Google Calendar event to the provider-neutral RawCalendarEvent. */
export function googleToRaw(event: Record<string, any>): RawCalendarEvent {
  const candidates: (string | undefined)[] = [
    event.hangoutLink,
    event.location,
    // CA6: description may carry HTML entities in the URL — decode before extraction.
    event.description ? decodeHtmlEntities(event.description) : undefined,
  ];
  if (event.conferenceData?.entryPoints) {
    for (const ep of event.conferenceData.entryPoints) if (ep.uri) candidates.push(ep.uri);
  }
  const attendees: Attendee[] = (event.attendees || []).map((att: any) => ({
    name: att.displayName || '',
    email: att.email || '',
    status: att.responseStatus || 'none',
  }));
  return {
    calendar_event_id: `gcal:${event.id}`,
    title: event.summary || 'Untitled meeting',
    urlCandidates: candidates,
    // CA8: only a real dateTime counts; all-day events (start.date only) get undefined and are
    // dropped by the normalizer instead of being scheduled for a midnight join.
    start_time: event.start?.dateTime || undefined,
    end_time: event.end?.dateTime || undefined,
    organizer: event.organizer?.displayName || undefined,
    organizer_email: event.organizer?.email || undefined,
    location: event.location || undefined,
    description: event.description || undefined,
    attendees,
    is_recurring: !!event.recurringEventId,
    recurrence_id: event.recurringEventId || undefined,
  };
}

// ── Provider syncs ──────────────────────────────────────────────────────

/** Sync Google Calendar events via gwscli and insert into local db. */
async function syncGoogleCalendar(): Promise<Meeting[]> {
  const fs = await import('fs');
  const gws = resolveGwsBinary(process.env.GWS_PATH, (p) => fs.existsSync(p));
  if (gws.action === 'skip') return []; // Never configured — stay silent
  if (gws.action === 'warn') {
    console.error(`[mibot] GWS_PATH is set to "${gws.path}" but no such binary exists — Google Calendar sync skipped`);
    return [];
  }
  const gwsPath = gws.path;

  const now = new Date();
  const end = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  // Some of these CLIs print JSON to stdout yet exit non-zero; recover that stdout from the
  // CliError (as the old execFile catch did) and only rethrow if there's nothing usable.
  // CA1 (blockedBy AR7) tightens this exit-code contract next.
  const stdout = await runCliRecoverStdout(gwsPath, [
    'calendar', 'events', 'list',
    '--params', JSON.stringify({
      calendarId: 'primary',
      timeMin: now.toISOString(),
      timeMax: end.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
    }),
    '--format', 'json',
  ]);

  if (!stdout.trim()) return [];
  const events = parseEventsPayload(stdout);
  return reconcileProvider('gcal:', normalizeEvents(events.map(googleToRaw)), ' (Google)');
}

/** Sync M365 calendar events via ms365-cli and insert into local db. */
async function syncM365Calendar(): Promise<Meeting[]> {
  const now = new Date();
  const end = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  const stdout = await runCliRecoverStdout('ms365', [
    'calendar', 'view',
    '--start', now.toISOString(),
    '--end', end.toISOString(),
    '--select', 'id,subject,start,end,location,onlineMeeting,body,attendees,organizer,type,seriesMasterId',
    '-o', 'json',
  ]);

  if (!stdout.trim()) return [];
  const events = parseEventsPayload(stdout);
  return reconcileProvider('m365:', normalizeEvents(events.map(m365ToRaw)), '');
}

/**
 * CA2: one provider's full reconcile pass — insert/update the meetings it returned, then cancel
 * any scheduled row under this provider's id prefix that the window no longer contains. Runs per
 * provider so a Google outage never mass-cancels M365 meetings (and vice versa).
 */
function reconcileProvider(prefix: string, meetings: NormalizedMeeting[], label: string): Meeting[] {
  const inserted = persistNew(meetings, label);
  const seen = new Set(meetings.map((m) => m.calendar_event_id).filter((id): id is string => !!id));
  cancelDisappeared(prefix, seen);
  return inserted;
}

/** Fetch upcoming calendar events from all configured providers and sync to local db. */
export async function syncCalendar(): Promise<Meeting[]> {
  const newMeetings: Meeting[] = [];

  // 1. Try M365 sync (if MS365_CLI_CLIENT_ID is configured)
  if (process.env.MS365_CLI_CLIENT_ID) {
    try {
      newMeetings.push(...(await syncM365Calendar()));
    } catch (err) {
      const stderr = (err as any).stderr || '';
      console.error(`[mibot] M365 calendar sync failed: ${(err as Error).message}${stderr ? '\n' + stderr : ''}`);
    }
  }

  // 2. Try Google Calendar sync (via gwscli)
  try {
    newMeetings.push(...(await syncGoogleCalendar()));
  } catch (err) {
    console.error(`[mibot] Google Calendar sync failed: ${(err as Error).message}`);
  }

  return newMeetings;
}
