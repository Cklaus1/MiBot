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

/** Fetch upcoming calendar events via ms365-cli and sync to local db. */
export async function syncCalendar(): Promise<Meeting[]> {
  const now = new Date();
  const end = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const newMeetings: Meeting[] = [];

  try {
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
  } catch (err) {
    const msg = (err as Error).message;
    const stderr = (err as any).stderr || '';
    console.error(`[mibot] M365 calendar sync failed: ${msg}\n${stderr}`);
  }

  return newMeetings;
}
