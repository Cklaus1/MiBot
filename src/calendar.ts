import { execFile } from 'child_process';
import { promisify } from 'util';
import { getMeetingByEventId, insertMeeting, type Meeting, type Attendee } from './db.js';
import { detectPlatform } from './bot.js';
import { fmtTime } from './config.js';

const execFileAsync = promisify(execFile);

/** Extract a meeting URL from event body/location/online meeting fields. */
function extractMeetingUrl(event: Record<string, unknown>): string | null {
  // Check location first (organizer's intended platform), then body, then onlineMeeting
  // This ensures a Google Meet link in the location wins over an auto-generated Teams link
  const candidates: string[] = [];
  const loc = event.location as Record<string, unknown> | undefined;
  if (loc?.displayName) candidates.push(loc.displayName as string);
  const body = event.body as Record<string, unknown> | undefined;
  if (body?.content) candidates.push(body.content as string);
  const online = event.onlineMeeting as Record<string, unknown> | undefined;
  if (online?.joinUrl) candidates.push(online.joinUrl as string);

  const urlPattern = /https?:\/\/(?:[\w-]+\.)?(?:zoom\.us|teams\.microsoft\.com|teams\.live\.com|meet\.google\.com)\/[^\s"<>)]+/gi;

  // Check location first (organizer's intended platform), then onlineMeeting, then body
  for (const text of candidates) {
    const matches = text.match(urlPattern);
    if (matches) {
      // Return the first meeting URL found in this field
      // Location is checked first, so if it has a Meet link, that wins over a Teams link in the body
      return matches[0];
    }
  }
  return null;
}

/** Extract attendees from a calendar event. */
function extractAttendees(event: Record<string, unknown>): Attendee[] {
  const attendees: Attendee[] = [];
  const list = event.attendees as Array<Record<string, unknown>> | undefined;
  if (!list) return attendees;
  for (const att of list) {
    const ea = att.emailAddress as Record<string, unknown> | undefined;
    const status = att.status as Record<string, unknown> | undefined;
    attendees.push({
      name: (ea?.name as string) || '',
      email: (ea?.address as string) || '',
      status: (status?.response as string) || 'none',
    });
  }
  return attendees;
}

/** Extract organizer from a calendar event. */
function extractOrganizer(event: Record<string, unknown>): { name: string; email: string } | null {
  const org = event.organizer as Record<string, unknown> | undefined;
  const ea = org?.emailAddress as Record<string, unknown> | undefined;
  if (!ea) return null;
  return { name: (ea.name as string) || '', email: (ea.address as string) || '' };
}

/** Strip HTML tags for plain text description. */
function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Meeting URL regex shared between M365 and Google Calendar extraction. */
const MEETING_URL_PATTERN = /https?:\/\/(?:[\w-]+\.)?(?:zoom\.us|teams\.microsoft\.com|teams\.live\.com|meet\.google\.com)\/[^\s"<>)]+/gi;

/** Extract a meeting URL from a plain text string (for Google Calendar fields). */
function extractMeetingUrlFromText(text: string): string | null {
  const matches = text.match(MEETING_URL_PATTERN);
  return matches ? matches[0] : null;
}

/** Path to gwscli binary (Google Workspace CLI). */
const GWS_PATH = process.env.GWS_PATH || '/root/projects/gwscli/target/release/gws';

/** Sync Google Calendar events via gwscli and insert into local db. */
async function syncGoogleCalendar(): Promise<Meeting[]> {
  const newMeetings: Meeting[] = [];

  // Check if gws binary exists
  const fs = await import('fs');
  if (!fs.existsSync(GWS_PATH)) {
    return newMeetings; // Silently skip — user hasn't set up gwscli
  }

  const now = new Date();
  const end = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(GWS_PATH, [
      'calendar', 'events', 'list',
      '--params', JSON.stringify({
        calendarId: 'primary',
        timeMin: now.toISOString(),
        timeMax: end.toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
      }),
      '--format', 'json',
    ], { timeout: 15000, env: { ...process.env } }));
  } catch (execErr: any) {
    stdout = execErr.stdout || '';
    if (!stdout) throw execErr;
  }

  if (!stdout.trim()) return newMeetings;

  const data = JSON.parse(stdout);
  const events = data.items || (Array.isArray(data) ? data : []);

  for (const event of events) {
    const eventId = `gcal:${event.id}`;
    if (getMeetingByEventId(eventId)) continue;

    // Extract meeting URL from: hangoutLink, location, description, conferenceData
    const candidates: string[] = [];
    if (event.hangoutLink) candidates.push(event.hangoutLink);
    if (event.location) candidates.push(event.location);
    if (event.description) candidates.push(event.description);
    if (event.conferenceData?.entryPoints) {
      for (const ep of event.conferenceData.entryPoints) {
        if (ep.uri) candidates.push(ep.uri);
      }
    }

    let url: string | null = null;
    for (const text of candidates) {
      url = extractMeetingUrlFromText(text);
      if (url) break;
    }
    if (!url) continue;

    const platform = detectPlatform(url);
    if (!platform) continue;

    const startDt = event.start?.dateTime || event.start?.date || now.toISOString();
    const endDt = event.end?.dateTime || event.end?.date || undefined;

    // Extract attendees
    const attendees: Attendee[] = [];
    if (event.attendees) {
      for (const att of event.attendees) {
        attendees.push({
          name: att.displayName || '',
          email: att.email || '',
          status: att.responseStatus || 'none',
        });
      }
    }

    const organizer = event.organizer
      ? { name: event.organizer.displayName || '', email: event.organizer.email || '' }
      : null;

    const meeting = insertMeeting({
      title: event.summary || 'Untitled meeting',
      platform,
      join_url: url,
      start_time: startDt,
      end_time: endDt,
      calendar_event_id: eventId,
      organizer: organizer?.name,
      organizer_email: organizer?.email,
      location: event.location || undefined,
      description: event.description ? stripHtml(event.description).substring(0, 2000) : undefined,
      attendees: attendees.length > 0 ? attendees : undefined,
      is_recurring: !!event.recurringEventId,
      recurrence_id: event.recurringEventId || undefined,
    });

    const attCount = attendees.length;
    const attStr = attCount > 0 ? ` (${attCount} attendees)` : '';
    newMeetings.push(meeting);
    console.error(`[mibot] Found (Google): ${meeting.title} (${platform}) at ${fmtTime(startDt)}${attStr}`);
  }

  return newMeetings;
}

/** Sync M365 calendar events via ms365-cli and insert into local db. */
async function syncM365Calendar(): Promise<Meeting[]> {
  const now = new Date();
  const end = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const newMeetings: Meeting[] = [];

  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('ms365', [
      'calendar', 'view',
      '--start', now.toISOString(),
      '--end', end.toISOString(),
      '--select', 'id,subject,start,end,location,onlineMeeting,body,attendees,organizer,type,seriesMasterId',
      '-o', 'json',
    ], { timeout: 15000, env: { ...process.env } }));
  } catch (execErr: any) {
    stdout = execErr.stdout || '';
    if (!stdout) throw execErr;
  }

  const data = JSON.parse(stdout);
  const events = Array.isArray(data) ? data : data.value || [];

  for (const event of events) {
    const eventId = `m365:${event.id}`;
    if (getMeetingByEventId(eventId)) continue;

    const url = extractMeetingUrl(event);
    if (!url) continue;
    const platform = detectPlatform(url);
    if (!platform) continue;

    const startDt = event.start?.dateTime || now.toISOString();
    const endDt = event.end?.dateTime || undefined;
    const organizer = extractOrganizer(event);
    const attendees = extractAttendees(event);
    const loc = (event.location as Record<string, unknown>)?.displayName as string | undefined;
    const bodyContent = (event.body as Record<string, unknown>)?.content as string | undefined;
    const description = bodyContent ? stripHtml(bodyContent).substring(0, 2000) : undefined;

    const meeting = insertMeeting({
      title: event.subject || 'Untitled meeting',
      platform,
      join_url: url,
      start_time: startDt,
      end_time: endDt,
      calendar_event_id: eventId,
      organizer: organizer?.name,
      organizer_email: organizer?.email,
      location: loc,
      description,
      attendees: attendees.length > 0 ? attendees : undefined,
      is_recurring: event.type === 'occurrence' || event.type === 'seriesMaster',
      recurrence_id: event.seriesMasterId as string | undefined,
    });

    const attCount = attendees.length;
    const attStr = attCount > 0 ? ` (${attCount} attendees)` : '';
    newMeetings.push(meeting);
    console.error(`[mibot] Found: ${meeting.title} (${platform}) at ${fmtTime(startDt)}${attStr}`);
  }

  return newMeetings;
}

/** Fetch upcoming calendar events from all configured providers and sync to local db. */
export async function syncCalendar(): Promise<Meeting[]> {
  const newMeetings: Meeting[] = [];

  // 1. Try M365 sync (if MS365_CLI_CLIENT_ID is configured)
  if (process.env.MS365_CLI_CLIENT_ID) {
    try {
      const m365Meetings = await syncM365Calendar();
      newMeetings.push(...m365Meetings);
    } catch (err) {
      const msg = (err as Error).message;
      const stderr = (err as any).stderr || '';
      console.error(`[mibot] M365 calendar sync failed: ${msg}\n${stderr}`);
    }
  }

  // 2. Try Google Calendar sync (via gwscli)
  try {
    const gcalMeetings = await syncGoogleCalendar();
    newMeetings.push(...gcalMeetings);
  } catch (err) {
    const msg = (err as Error).message;
    console.error(`[mibot] Google Calendar sync failed: ${msg}`);
  }

  return newMeetings;
}
