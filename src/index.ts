import { joinAndRecord, detectPlatform } from './bot.js';
import { syncCalendar } from './calendar.js';
import {
  getUpcomingMeetings, listMeetings, listRecordings, getRecordingWithMeeting,
  recoverStaleMeetings, sweepMissedMeetings, getMeeting, isPidAlive, claimOrphanedTranscriptions, type Meeting,
} from './db.js';
import { isTerminalMeetingStatus, type MeetingStatus } from './status.js';
import { loadConfig, saveDefaultConfig, meetingSkipReason, fmtTime } from './config.js';
import { sendCommand, parseControlResponse } from './control.js';
import { safeParseArray, parseJoinArgs } from './cli.js';
import { log } from './log.js';
import { installShutdownHandlers, registerShutdownHook, runShutdown } from './shutdown.js';
import { closeDb } from './db.js';
import { resumeTranscription } from './transcribe-resume.js';
import { SyncSchedule, LAUNCH_TICK_MS } from './watch-clock.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

const args = process.argv.slice(2);
const command = args[0];

async function main(): Promise<void> {
  // Single graceful-teardown path (C1/C13/D9): flush the JSONL log and checkpoint
  // the WAL on Ctrl+C / SIGTERM. Per-bot control channels register their own socket
  // cleanup as hooks; these run last so children stop before the db closes.
  registerShutdownHook('log', () => log.close());
  registerShutdownHook('db', () => closeDb());
  installShutdownHandlers();

  switch (command) {
    case 'start':    await startWatcher(); break;
    case 'join':     { const j = parseJoinArgs(args.slice(1)); await joinCommand(j.url, j.title); break; }
    case 'meetings': showMeetings(); break;
    case 'recordings': showRecordings(); break;
    case 'show':     showRecording(parseInt(args[1], 10)); break;
    case 'sync':     await syncOnce(); break;
    case 'config':   showConfig(); break;
    case 'send':     await sendCmd(parseInt(args[1], 10), args.slice(2).join(' ')); break;
    case 'status':   showStatus(); break;
    default:         printUsage(); break;
  }
}

function printUsage(): void {
  console.log(`mibot — AI meeting bot

Usage:
  mibot start                    Watch calendar, auto-join meetings
  mibot join <meeting-url>       Join a specific meeting now
  mibot sync                     Sync calendar without joining
  mibot meetings                 List meetings
  mibot recordings               List recordings
  mibot show <recording-id>      Show transcript + summary
  mibot config                   Show current configuration
  mibot status                   Show running bots + health
  mibot send <id> <command>      Send command to running bot

Control commands:
  screenshot [path]              Take screenshot of bot's browser
  click "text"                   Click element by visible text (searches all frames)
  type "text"                    Type text via keyboard
  fill <selector> <value>        Fill an input
  press <key>                    Press a key (Enter, Escape, Tab)
  text                           Get visible text from all frames
  frames                         List all frames/iframes

Config: ~/.config/mibot/config.json
Playbooks: ~/.config/mibot/playbooks/
Data:   ~/.config/mibot/mibot.db
Audio:  ~/.config/mibot/recordings/
`);
}

async function joinCommand(url: string | undefined, title?: string): Promise<void> {
  if (!url) { console.error('Usage: mibot join <meeting-url>'); process.exit(1); }
  if (!detectPlatform(url)) { console.error('Unsupported URL. Supported: Zoom, Teams, Google Meet'); process.exit(1); }
  const id = await joinAndRecord({ url, title });
  console.log(`Recording ${id} complete.`);
}

function showMeetings(): void {
  const meetings = listMeetings();
  if (meetings.length === 0) { console.log('No meetings. Run: mibot sync'); return; }
  console.log(`${'ID'.padEnd(6)}${'Status'.padEnd(12)}${'Platform'.padEnd(8)}${'Time'.padEnd(22)}Title`);
  console.log('-'.repeat(70));
  for (const m of meetings) {
    const time = fmtTime(m.start_time);
    console.log(`${String(m.id).padEnd(6)}${m.status.padEnd(12)}${m.platform.padEnd(8)}${time.padEnd(22)}${m.title}`);
  }
}

function showRecordings(): void {
  const recordings = listRecordings();
  if (recordings.length === 0) { console.log('No recordings. Run: mibot join <url>'); return; }
  console.log(`${'ID'.padEnd(6)}${'Status'.padEnd(12)}${'Platform'.padEnd(8)}${'Time'.padEnd(22)}Title`);
  console.log('-'.repeat(70));
  for (const r of recordings) {
    const time = fmtTime(r.created_at);
    console.log(`${String(r.id).padEnd(6)}${r.status.padEnd(12)}${r.platform.padEnd(8)}${time.padEnd(22)}${r.title}`);
  }
}

function showRecording(id: number): void {
  if (isNaN(id)) { console.error('Usage: mibot show <recording-id>'); process.exit(1); }
  const r = getRecordingWithMeeting(id);
  if (!r) { console.error(`Recording ${id} not found.`); process.exit(1); }

  console.log(`Title:       ${r.title}`);
  console.log(`Platform:    ${r.platform}`);
  console.log(`Status:      ${r.status}`);
  if (r.organizer) console.log(`Organizer:   ${r.organizer}${r.organizer_email ? ` <${r.organizer_email}>` : ''}`);
  if (r.start_time) console.log(`Scheduled:   ${fmtTime(r.start_time)}${r.end_time ? ' - ' + fmtTime(r.end_time) : ''}`);
  if (r.actual_start) console.log(`Actual:      ${fmtTime(r.actual_start)}${r.actual_end ? ' - ' + fmtTime(r.actual_end) : ''}`);
  if (r.location) console.log(`Location:    ${r.location}`);

  // Attendees (from calendar invite)
  if (r.attendees) {
    try {
      const attendees = JSON.parse(r.attendees);
      if (attendees.length > 0) {
        console.log(`\nInvited (${attendees.length}):`);
        for (const a of attendees) {
          const status = a.status !== 'none' ? ` [${a.status}]` : '';
          console.log(`  ${a.name || a.email}${status}`);
        }
      }
    } catch {}
  }

  // Participants (actually showed up — including drop-ins not on the invite)
  if (r.participants) {
    try {
      const participants = JSON.parse(r.participants);
      const humans = participants.filter((p: any) => !p.is_bot);
      const bots = participants.filter((p: any) => p.is_bot);
      if (humans.length > 0) {
        console.log(`\nParticipants (${humans.length}):`);
        for (const p of humans) {
          const joined = fmtTime(p.joined_at);
          const left = p.left_at ? fmtTime(p.left_at) : 'still in call';
          console.log(`  ${p.name}  (${joined} - ${left})`);
        }
      }
      if (bots.length > 0) {
        console.log(`\nBots (${bots.length}): ${bots.map((b: any) => b.name).join(', ')}`);
      }
    } catch {}
  }

  console.log(`\nAudio:       ${r.audio_path}`);
  if (r.metadata_path) console.log(`Metadata:    ${r.metadata_path}`);
  if (r.transcript_path) {
    console.log(`Transcript:  ${r.transcript_path}`);
    if (fs.existsSync(r.transcript_path)) {
      console.log('---');
      console.log(fs.readFileSync(r.transcript_path, 'utf8'));
    }
  } else {
    console.log('Transcript:  (pending)');
  }
}

/** Show running/recent bot status with health info. */
function showStatus(): void {
  const meetings = listMeetings(20);
  const active = meetings.filter(m => ['joining', 'in_call', 'processing'].includes(m.status));
  const recent = meetings.filter(m => ['done', 'failed'].includes(m.status)).slice(0, 5);

  if (active.length === 0) {
    console.log('No active bots.');
  } else {
    console.log(`Active bots (${active.length}):`);
    for (const m of active) {
      const heartbeat = m.heartbeat ? timeSince(m.heartbeat) : 'no heartbeat';
      const health = m.heartbeat && (Date.now() - new Date(m.heartbeat).getTime()) < 30000 ? 'healthy' : 'stale';
      console.log(`  #${m.id} [${m.status}] ${m.platform} — ${m.title} (${heartbeat}, ${health})`);
    }
  }

  if (recent.length > 0) {
    console.log(`\nRecent (last 5):`);
    for (const m of recent) {
      const time = fmtTime(m.actual_start || m.start_time);
      console.log(`  #${m.id} [${m.status}] ${m.platform} — ${m.title} (${time})`);
    }
  }
}

function timeSince(iso: string): string {
  const sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  return `${Math.floor(sec / 3600)}h ago`;
}

async function sendCmd(meetingId: number, command: string): Promise<void> {
  if (isNaN(meetingId) || !command) {
    console.error('Usage: mibot send <meeting-id> <command>');
    console.error('Example: mibot send 42 screenshot');
    process.exit(1);
  }
  try {
    const raw = await sendCommand(meetingId, command);
    // C9: the server returns {ok:false,error} on a normal stream for a failed command.
    // Inspect it so a failure exits non-zero instead of printing raw JSON and exiting 0.
    const result = parseControlResponse(raw);
    console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }
}

async function syncOnce(): Promise<void> {
  const newMeetings = await syncCalendar();
  console.log(newMeetings.length === 0 ? 'No new meetings with join links.' : `Found ${newMeetings.length} new meeting(s).`);
}

function showConfig(): void {
  saveDefaultConfig();
  const config = loadConfig();
  const configPath = path.join(os.homedir(), '.config', 'mibot', 'config.json');
  console.log(`Config: ${configPath}\n`);
  console.log(JSON.stringify(config, null, 2));
}

// ── Watcher ────────────────────────────────────────────────────────────

/** Sort meetings by priority: more attendees first, then by start time. */
function prioritizeMeetings(meetings: Meeting[]): Meeting[] {
  return [...meetings].sort((a, b) => {
    // More attendees = higher priority. safeParseArray (C11): one malformed attendees
    // blob must not throw out of the sort and abort the entire poll iteration.
    const aCount = safeParseArray(a.attendees).length;
    const bCount = safeParseArray(b.attendees).length;
    if (bCount !== aCount) return bCount - aCount;
    // Earlier start time wins ties
    return new Date(a.start_time).getTime() - new Date(b.start_time).getTime();
  });
}

async function startWatcher(): Promise<void> {
  saveDefaultConfig();
  const config = loadConfig();

  // Recover meetings stuck from previous crashes
  const recovered = recoverStaleMeetings();
  if (recovered > 0) {
    console.error(`[mibot] Recovered ${recovered} stale meeting(s) from previous crash`);
  }

  console.error(`[mibot] Configuration:`);
  console.error(`  Join ${config.joinBeforeMinutes}m before start`);
  console.error(`  Leave after ${config.leaveGracePeriodSeconds}s with no humans`);
  console.error(`  Alone timeout: ${config.aloneTimeoutMinutes}m`);
  console.error(`  Max duration: ${config.maxDurationHours}h`);
  console.error(`  Bot patterns: ${config.botPatterns.length} known bots`);
  console.error(`  Never join: ${config.neverJoin.join(', ')}`);
  console.error(`  Calendar sync: every ${config.pollMinutes}m (join check: every ${LAUNCH_TICK_MS / 60000}m)`);
  console.error(`[mibot] Press Ctrl+C to stop\n`);

  const syncSchedule = new SyncSchedule(config.pollMinutes);
  const activeBots = new Set<number>();
  const MAX_CONCURRENT_BOTS = 3;

  // C20: setInterval doesn't serialize an async callback — a slow poll (two 15s CLI
  // timeouts in syncCalendar) can still be running when the next tick fires, overlapping
  // two calendar syncs. Skip a tick while the previous one is in flight.
  let polling = false;
  let resumingTranscriptions = false;
  const skipLogged = new Set<number>();
  const poll = async () => {
    if (polling) { console.error('[mibot] Poll still running, skipping this tick'); return; }
    polling = true;
    try {
      // Wave 9-G: calendar sync on its own (pollMinutes) cadence; everything below runs every
      // tick. Isolated in its own try: a failing calendar CLI used to throw out of the whole
      // poll and block joining meetings that were already known.
      const now = Date.now();
      if (syncSchedule.due(now)) {
        syncSchedule.markSynced(now);
        try { await syncCalendar(); } catch (err) { console.error(`[mibot] Calendar sync error: ${(err as Error).message}`); }
      }

      // D7: retire meetings whose window lapsed while the watcher was down (else they
      // sit `scheduled` forever and the table grows unbounded).
      const missed = sweepMissedMeetings();
      if (missed > 0) console.error(`[mibot] Marked ${missed} overdue meeting(s) missed`);

      // Recover any bots that died since last poll. Our own bots run in this process, so a
      // stale row of ours is only dead if we're no longer tracking its bot (a host suspend
      // stalls heartbeats without killing anything — Wave 9-A).
      const staleRecovered = recoverStaleMeetings((pid, meetingId) =>
        pid === process.pid ? activeBots.has(meetingId) : isPidAlive(pid));
      if (staleRecovered > 0) {
        console.error(`[mibot] Recovered ${staleRecovered} stale bot(s)`);
        // Clean up activeBots — drop ids whose row is no longer running. This used to call
        // listMeetings(50) INSIDE the loop and search its results: O(n) queries, and a bot
        // whose meeting fell outside that 50-row window was never removed, permanently
        // leaking one of the MAX_CONCURRENT_BOTS slots. Look the row up directly, and treat
        // ANY terminal status (or a vanished row) as "no longer active", not just 'failed'.
        for (const id of activeBots) {
          const m = getMeeting(id);
          if (!m || isTerminalMeetingStatus(m.status as MeetingStatus)) activeBots.delete(id);
        }
      }

      // Wave 9-B: resume transcriptions a crash interrupted. One at a time, off the poll path;
      // each is tracked in activeBots while it runs, so ownerAlive vouches for it and it shares
      // the concurrency cap with live bots (both are heavy).
      if (!resumingTranscriptions) {
        const jobs = claimOrphanedTranscriptions((pid, meetingId) =>
          pid === process.pid ? activeBots.has(meetingId) : isPidAlive(pid));
        if (jobs.length > 0) {
          resumingTranscriptions = true;
          for (const j of jobs) activeBots.add(j.meetingId);
          void (async () => {
            for (const job of jobs) {
              try { await resumeTranscription(job); } finally { activeBots.delete(job.meetingId); }
            }
          })().finally(() => { resumingTranscriptions = false; });
        }
      }

      const upcoming = getUpcomingMeetings(config.joinBeforeMinutes + 1);
      const prioritized = prioritizeMeetings(upcoming);

      for (const meeting of prioritized) {
        if (activeBots.has(meeting.id)) continue;
        if (activeBots.size >= MAX_CONCURRENT_BOTS) {
          const attendeeCount = safeParseArray(meeting.attendees).length;
          console.error(`[mibot] Queue full (${MAX_CONCURRENT_BOTS}/${MAX_CONCURRENT_BOTS}), deferred: ${meeting.title} (${attendeeCount} attendees)`);
          break;
        }

        // Apply skip rules (neverJoin, onlyOrganized, minAttendees). Logged once per meeting:
        // a meeting stays joinable until it ends, so it's re-evaluated every tick.
        const skip = meetingSkipReason(meeting, config);
        if (skip) {
          if (!skipLogged.has(meeting.id)) {
            skipLogged.add(meeting.id);
            console.error(`[mibot] Skipping (${skip}): ${meeting.title}`);
          }
          continue;
        }

        activeBots.add(meeting.id);
        console.error(`[mibot] Spawning bot for: ${meeting.title}`);

        joinAndRecord({
          url: meeting.join_url,
          title: meeting.title,
          calendarEventId: meeting.calendar_event_id || undefined,
        }).then((recId) => {
          console.error(`[mibot] Done: ${meeting.title} -> recording ${recId}`);
          activeBots.delete(meeting.id);
        }).catch((err) => {
          console.error(`[mibot] Failed: ${meeting.title} — ${(err as Error).message}`);
          activeBots.delete(meeting.id);
        });
      }
    } catch (err) {
      console.error(`[mibot] Poll error: ${(err as Error).message}`);
    } finally {
      polling = false; // release the re-entrancy guard (C20)
    }
  };

  await poll();
  setInterval(poll, LAUNCH_TICK_MS);
  await new Promise(() => {}); // keep alive
}

main().catch((err) => {
  console.error(`Error: ${(err as Error).message}`);
  process.exit(1);
});
