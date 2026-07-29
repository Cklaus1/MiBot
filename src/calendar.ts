import { getMeetingByEventId, insertMeeting, type Meeting, type Attendee } from './db.js';
import { detectPlatform } from './bot.js';
import { fmtTime } from './config.js';
import { runCli, CliError } from './runcli.js';

/** Path to gwscli binary (Google Workspace CLI). */
const GWS_PATH = process.env.GWS_PATH || '/root/projects/gwscli/target/release/gws';

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
 * AR7 seam — provider-neutral calendar event. M365 and Google each map their native shape
 * to this; the single normalizer below turns a batch of these into insertable meetings.
 * `urlCandidates` is ordered by platform precedence; `description` may still contain HTML.
 */
export interface RawCalendarEvent {
  calendar_event_id: string;
  title: string;
  urlCandidates: (string | undefined | null)[];
  start_time: string;
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

/** Insert normalized meetings that aren't already in the db, logging each. Shared by both
 *  providers so the "skip-if-seen → insert → log" tail lives once, not per-provider. */
function persistNew(meetings: NormalizedMeeting[], providerLabel: string): Meeting[] {
  const inserted: Meeting[] = [];
  for (const nm of meetings) {
    if (nm.calendar_event_id && getMeetingByEventId(nm.calendar_event_id)) continue;
    const meeting = insertMeeting(nm);
    inserted.push(meeting);
    const attCount = nm.attendees?.length ?? 0;
    const attStr = attCount > 0 ? ` (${attCount} attendees)` : '';
    console.error(`[mibot] Found${providerLabel}: ${meeting.title} (${nm.platform}) at ${fmtTime(nm.start_time)}${attStr}`);
  }
  return inserted;
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
function m365ToRaw(event: Record<string, unknown>): RawCalendarEvent {
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
    // Precedence: organizer's intended platform (location) first, then body, then the
    // auto-generated onlineMeeting.joinUrl last — so a Meet link in location wins over Teams.
    urlCandidates: [
      loc?.displayName as string | undefined,
      body?.content as string | undefined,
      online?.joinUrl as string | undefined,
    ],
    start_time: (start?.dateTime as string) || new Date().toISOString(),
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
function googleToRaw(event: Record<string, any>): RawCalendarEvent {
  const candidates: (string | undefined)[] = [event.hangoutLink, event.location, event.description];
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
    start_time: event.start?.dateTime || event.start?.date || new Date().toISOString(),
    end_time: event.end?.dateTime || event.end?.date || undefined,
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
  if (!fs.existsSync(GWS_PATH)) return []; // Silently skip — user hasn't set up gwscli

  const now = new Date();
  const end = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  // Some of these CLIs print JSON to stdout yet exit non-zero; recover that stdout from the
  // CliError (as the old execFile catch did) and only rethrow if there's nothing usable.
  // CA1 (blockedBy AR7) tightens this exit-code contract next.
  const stdout = await runCliRecoverStdout(GWS_PATH, [
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
  const data = JSON.parse(stdout);
  const events: Record<string, any>[] = data.items || (Array.isArray(data) ? data : []);
  return persistNew(normalizeEvents(events.map(googleToRaw)), ' (Google)');
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
  const data = JSON.parse(stdout);
  const events: Record<string, unknown>[] = Array.isArray(data) ? data : data.value || [];
  return persistNew(normalizeEvents(events.map(m365ToRaw)), '');
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
