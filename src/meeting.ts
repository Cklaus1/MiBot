import { type Page } from 'playwright';
import { type Participant, type SpeakerSegment } from './db.js';
import { isBot, loadConfig } from './config.js';
import { SignalTracker } from './signals.js';

// ── Types ─────────────────────────────────────────────────────────────

export interface ParticipantState {
  humans: string[];
  bots: string[];
}

// ── Participant scraping ──────────────────────────────────────────────

/** Scrape current participant names from the meeting UI. */
export async function getParticipants(page: Page, platform: string): Promise<ParticipantState> {
  const names: string[] = await page.evaluate((p) => {
    const results: string[] = [];
    // Each platform renders participants differently
    const selectors = p === 'meet'
      ? ['[data-participant-id]', '[data-self-name]', '.zWfAib'] // Meet participant names
      : p === 'teams'
      ? ['[data-tid="participantItem"]', '.ui-chat__messagecontent', '[role="listitem"]']
      : ['[class*="participant"]', '.participants-item__display-name', '[class*="attendee"]']; // Zoom

    for (const sel of selectors) {
      document.querySelectorAll(sel).forEach(el => {
        const name = (el.textContent || '').trim();
        if (name && name.length > 0 && name.length < 100) results.push(name);
      });
    }

    // Fallback: try aria labels that mention participant counts
    const countEl = document.querySelector('[aria-label*="participant"], [data-tid="roster-count"]');
    if (countEl) {
      const match = (countEl.getAttribute('aria-label') || '').match(/(\d+)/);
      if (match && results.length === 0) {
        // Can't get names, but know the count
        for (let i = 0; i < parseInt(match[1]); i++) results.push(`participant-${i}`);
      }
    }

    return [...new Set(results)];
  }, platform);

  // Normalize whitespace in names before dedup
  const normalized = names.map(n => n.replace(/\s+/g, ' ').trim()).filter(n => n.length > 0);
  const uniqueNames = [...new Set(normalized)];

  const humans: string[] = [];
  const bots: string[] = [];

  for (const name of uniqueNames) {
    if (isBot(name)) {
      bots.push(name);
    } else {
      humans.push(name);
    }
  }

  return { humans, bots };
}

// ── Active speaker detection ──────────────────────────────────────────

/** Detect who is currently speaking by checking platform-specific active speaker indicators. */
export async function getActiveSpeaker(page: Page, platform: string): Promise<string | null> {
  return page.evaluate((p) => {
    if (p === 'teams') {
      // Teams highlights the active speaker with a colored border and shows their name
      // The active speaker name appears in several places:

      // 1. The large stage area shows the speaker's name
      const stageLabel = document.querySelector(
        '[data-tid="video-stream-label"], [data-tid="active-speaker-name"]'
      );
      if (stageLabel?.textContent?.trim()) return stageLabel.textContent.trim();

      // 2. Participant with speaking indicator (animated border / voice activity)
      const speakingParticipant = document.querySelector(
        '[data-tid="participantItem"][class*="speaking"], [class*="is-speaking"], [data-is-speaking="true"]'
      );
      if (speakingParticipant?.textContent?.trim()) return speakingParticipant.textContent.trim();

      // 3. The roster shows mic activity icons — look for unmuted + active
      const rosterItems = document.querySelectorAll('[data-tid="participantItem"]');
      for (const item of rosterItems) {
        // Active speaker typically has an animated mic icon or highlighted state
        const hasVoiceActivity = item.querySelector('[class*="voice-activity"], [class*="speaking"]');
        if (hasVoiceActivity) return item.textContent?.trim() || null;
      }
    }

    if (p === 'meet') {
      // Meet shows the active speaker's name at the bottom of the video tile
      // and highlights their video tile border in blue
      const activeTile = document.querySelector('[data-self-name][data-is-speaking="true"]');
      if (activeTile) return activeTile.getAttribute('data-self-name');

      // Look for the speaker name overlay
      const speakerName = document.querySelector('.KV1GEc, .cS7aqe.NkoVdd');
      if (speakerName?.textContent?.trim()) return speakerName.textContent.trim();

      // Participant list shows a speaker icon next to active speaker
      const speakingIcon = document.querySelector('.google-material-icons:has(+ .ZjFb7c)');
      if (speakingIcon?.parentElement?.textContent?.trim()) {
        return speakingIcon.parentElement.textContent.trim();
      }
    }

    if (p === 'zoom') {
      // Zoom highlights the active speaker with a green border
      const activeSpeaker = document.querySelector(
        '.speaker-active-container__name, [class*="active-speaker"] [class*="display-name"]'
      );
      if (activeSpeaker?.textContent?.trim()) return activeSpeaker.textContent.trim();

      // Participant panel shows a mic icon with voice activity
      const participants = document.querySelectorAll('[class*="participants-item"]');
      for (const p of participants) {
        const isSpeaking = p.querySelector('[class*="icon-unmuted"][class*="speaking"], [class*="voice-level"]');
        if (isSpeaking) {
          const name = p.querySelector('[class*="display-name"]');
          if (name?.textContent?.trim()) return name.textContent.trim();
        }
      }
    }

    return null;
  }, platform).catch(() => null);
}

// ── Speaker tracker ───────────────────────────────────────────────────

/** Tracks speaker segments over the duration of the meeting. */
export class SpeakerTracker {
  private segments: SpeakerSegment[] = [];
  private currentSpeaker: string | null = null;
  private currentStart: string | null = null;
  private speakerNames = new Set<string>();

  update(speaker: string | null): void {
    const now = new Date().toISOString();

    if (speaker === this.currentSpeaker) return; // no change

    // Close previous segment
    if (this.currentSpeaker && this.currentStart) {
      this.segments.push({
        speaker: this.currentSpeaker,
        start: this.currentStart,
        end: now,
      });
    }

    // Start new segment
    this.currentSpeaker = speaker;
    this.currentStart = speaker ? now : null;
    if (speaker) {
      if (!this.speakerNames.has(speaker)) {
        console.error(`[mibot] Speaker: ${speaker}`);
        this.speakerNames.add(speaker);
      }
    }
  }

  finish(): SpeakerSegment[] {
    // Close any open segment
    if (this.currentSpeaker && this.currentStart) {
      this.segments.push({
        speaker: this.currentSpeaker,
        start: this.currentStart,
        end: new Date().toISOString(),
      });
    }
    return this.segments;
  }

  /** Mark participants as having spoken based on tracked segments. */
  markSpeakers(participants: Participant[]): void {
    for (const p of participants) {
      if (this.speakerNames.has(p.name)) {
        p.spoke = true;
      }
    }
  }
}

// ── Meeting end detection loop ────────────────────────────────────────

export async function waitForMeetingEnd(
  page: Page,
  platform: string,
  config: ReturnType<typeof loadConfig>,
  signalTracker: SignalTracker,
): Promise<{ participants: Participant[]; speakerTimeline: SpeakerSegment[] }> {
  const maxMs = config.maxDurationHours * 60 * 60 * 1000;
  const aloneMs = config.aloneTimeoutMinutes * 60 * 1000;
  const graceMs = config.leaveGracePeriodSeconds * 1000;

  const startTime = Date.now();
  let aloneStart: number | null = null;
  let graceStart: number | null = null;
  let lastHumanCount = -1;
  let consecutiveEmptyPolls = 0;

  // Track all participants and active speaker over time
  const participantMap = new Map<string, Participant>();
  const speakerTracker = new SpeakerTracker();

  const MIN_CALL_SECONDS = 60; // Don't check for "ended" in the first 60 seconds

  while (Date.now() - startTime < maxMs) {
    await page.waitForTimeout(5000);

    // Check if meeting ended (but not in the first few seconds — avoid false positives)
    if (Date.now() - startTime < MIN_CALL_SECONDS * 1000) continue;

    try {
      // Only check if the Leave button is still visible — most reliable signal.
      // Text heuristics ("meeting has ended") match hidden DOM elements during active calls.
      const leaveVisible = await page.evaluate((p) => {
        if (p === 'meet') return !!document.querySelector('[aria-label="Leave call"]');
        if (p === 'teams') {
          return !!document.querySelector('button:has([data-tid="hangup-button"]), button[aria-label="Leave"], #hangup-button');
        }
        // Zoom
        return !!document.querySelector('[aria-label="Leave"], .footer__leave-btn');
      }, platform);

      if (!leaveVisible) {
        // Take a screenshot for debugging before deciding
        await page.screenshot({ path: '/tmp/teams-ended.png' }).catch(() => {});
        console.error('[mibot] Leave button gone — meeting ended');
        break;
      }
    } catch {
      console.error('[mibot] Page closed — meeting ended');
      break;
    }

    // Track participants — process all names in a single pass to avoid classification race
    const { humans, bots } = await getParticipants(page, platform).catch(() => ({ humans: [] as string[], bots: [] as string[] }));
    const allCurrent = new Map<string, boolean>(); // name → is_bot
    for (const name of humans) allCurrent.set(name, false);
    for (const name of bots) allCurrent.set(name, true); // bot classification wins on conflict

    const now = new Date().toISOString();
    for (const [name, isBotFlag] of allCurrent) {
      if (!participantMap.has(name)) {
        participantMap.set(name, { name, joined_at: now, left_at: null, is_bot: isBotFlag, spoke: false });
        console.error(`[mibot] ${isBotFlag ? 'Bot' : 'Participant'} joined: ${name}`);
      } else {
        const p = participantMap.get(name)!;
        if (p.is_bot !== isBotFlag) p.is_bot = isBotFlag;
        if (p.left_at) { p.left_at = null; console.error(`[mibot] Participant rejoined: ${name}`); }
      }
    }
    // Mark participants who left (not in current set)
    for (const [name, p] of participantMap) {
      if (!allCurrent.has(name) && !p.left_at) {
        p.left_at = now;
        console.error(`[mibot] Participant left: ${name}`);
      }
    }

    // Track active speaker
    const speaker = await getActiveSpeaker(page, platform);
    speakerTracker.update(speaker);

    // Track chat, reactions, hand raises, screen shares
    await signalTracker.poll(page, platform);

    const humanCount = humans.length;

    // Track consecutive empty polls to avoid premature exit on single flaky scrape
    if (humanCount === 0 && lastHumanCount > 0) {
      consecutiveEmptyPolls++;
    } else if (humanCount > 0) {
      consecutiveEmptyPolls = 0;
    }

    if (humanCount !== lastHumanCount) {
      const botStr = bots.length > 0 ? ` + ${bots.length} bot(s)` : '';
      console.error(`[mibot] Participants: ${humanCount} human(s)${botStr}`);
      lastHumanCount = humanCount;
    }

    // Alone timeout (require 2+ consecutive empty polls to trigger grace period)
    if (humanCount <= config.minHumansToStay && consecutiveEmptyPolls >= 2) {
      if (!aloneStart) {
        aloneStart = Date.now();
        console.error(`[mibot] Alone (${humanCount} humans, ${bots.length} bots). Waiting ${config.aloneTimeoutMinutes}m...`);
      } else if (Date.now() - aloneStart > aloneMs) {
        console.error('[mibot] Alone timeout — leaving');
        break;
      }
    }
    if (humanCount > 0 && aloneStart) {
      console.error('[mibot] People rejoined, resetting alone timer');
      aloneStart = null;
    }

    // Grace period (only after 2+ consecutive empty polls)
    if (humanCount === 0 && consecutiveEmptyPolls >= 2 && !graceStart) {
      graceStart = Date.now();
      console.error(`[mibot] All humans left. Grace period: ${config.leaveGracePeriodSeconds}s...`);
    }
    if (graceStart) {
      if (humanCount > 0) {
        console.error('[mibot] Someone rejoined, resetting grace period');
        graceStart = null;
      } else if (Date.now() - graceStart > graceMs) {
        console.error('[mibot] Grace period expired — leaving');
        break;
      }
    }
  }

  if (Date.now() - startTime >= maxMs) {
    console.error(`[mibot] Max duration (${config.maxDurationHours}h) reached, leaving`);
  }

  // Finalize
  const now = new Date().toISOString();
  for (const p of participantMap.values()) {
    if (!p.left_at) p.left_at = now;
  }

  const participants = [...participantMap.values()];
  const speakerTimeline = speakerTracker.finish().filter(s => s.speaker !== null);
  speakerTracker.markSpeakers(participants);

  const totalSpeakers = new Set(speakerTimeline.map(s => s.speaker)).size;
  const totalSegments = speakerTimeline.length;
  if (totalSegments > 0) {
    console.error(`[mibot] Speaker timeline: ${totalSpeakers} speakers, ${totalSegments} segments`);
  }

  return { participants, speakerTimeline };
}
