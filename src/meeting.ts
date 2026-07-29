import { type Page } from 'playwright';
import os from 'os';
import path from 'path';
import { type Participant, type SpeakerSegment } from './db.js';
import { isBot, loadConfig } from './config.js';
import { SignalTracker } from './signals.js';
import { loadSelectors } from './selectors.js';
import { LeavePolicy } from './leave-policy.js';

/** M14: platform+timestamp debug screenshot path so concurrent meetings don't clobber. */
function endedScreenshotPath(platform: string): string {
  return path.join(os.tmpdir(), `mibot-${platform}-ended-${Date.now()}.png`);
}

// ── Types ─────────────────────────────────────────────────────────────

export interface ParticipantState {
  humans: string[];
  bots: string[];
  /**
   * Roster count from the UI when individual names could NOT be scraped (selector churn).
   * `undefined` when names were scraped successfully. Never used to fabricate names — the
   * caller subtracts self via deriveHumanCount() and feeds the result to the leave gate.
   */
  rosterCount?: number;
}

// ── Participant scraping ──────────────────────────────────────────────

/** Scrape current participant names from the meeting UI. */
export async function getParticipants(page: Page, platform: string): Promise<ParticipantState> {
  const selectors = loadSelectors(platform).participantNames;
  const scraped = await page.evaluate((sels) => {
    const results: string[] = [];

    for (const sel of sels) {
      document.querySelectorAll(sel).forEach(el => {
        const name = (el.textContent || '').trim();
        if (name && name.length > 0 && name.length < 100) results.push(name);
      });
    }

    // Fallback: try aria labels that mention participant counts. We return the COUNT,
    // never fabricated names (M3) — fake "participant-N" names fail isBot() and were
    // counted as humans, so the bot could never leave.
    let rosterCount: number | undefined;
    if (results.length === 0) {
      const countEl = document.querySelector('[aria-label*="participant"], [data-tid="roster-count"]');
      if (countEl) {
        const match = (countEl.getAttribute('aria-label') || '').match(/(\d+)/);
        if (match) rosterCount = parseInt(match[1]);
      }
    }

    return { names: [...new Set(results)], rosterCount };
  }, selectors);

  // Normalize whitespace in names before dedup
  const normalized = scraped.names.map(n => n.replace(/\s+/g, ' ').trim()).filter(n => n.length > 0);
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

  return { humans, bots, rosterCount: scraped.rosterCount };
}

/**
 * Derive the human count to feed the leave gate (M3).
 *
 * Prefers scraped human names. Only when NO names could be scraped does it fall back to
 * `rosterCount − 1` (subtracting the bot itself), clamped at 0. This never fabricates
 * names and never lets a stale roster count override a real human that IS present — which
 * would invert M1 into leaving an active meeting (data loss).
 */
export function deriveHumanCount(state: ParticipantState): number {
  if (state.humans.length > 0) return state.humans.length;
  if (state.rosterCount !== undefined) return Math.max(0, state.rosterCount - 1);
  return 0;
}

// ── Active speaker detection ──────────────────────────────────────────

/** Detect who is currently speaking by checking platform-specific active speaker indicators. */
export async function getActiveSpeaker(page: Page, platform: string): Promise<string | null> {
  const overlaySelectors = loadSelectors(platform).activeSpeaker;
  return page.evaluate(({ p, overlays }) => {
    // Shared: the name-overlay fallback (fragile minified classes live in config).
    const overlaySel = overlays.join(', ');
    const overlayText = (): string | null => {
      if (!overlaySel) return null;
      const el = document.querySelector(overlaySel);
      return el?.textContent?.trim() || null;
    };

    if (p === 'teams') {
      // Teams highlights the active speaker with a colored border and shows their name
      // 1. The large stage area shows the speaker's name (config-driven overlay)
      const overlay = overlayText();
      if (overlay) return overlay;

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
      // and highlights their video tile border in blue. Stable attribute first.
      const activeTile = document.querySelector('[data-self-name][data-is-speaking="true"]');
      if (activeTile) return activeTile.getAttribute('data-self-name');

      // Fallback: config-driven name overlay (fragile minified classes)
      const overlay = overlayText();
      if (overlay) return overlay;

      // Participant list shows a speaker icon next to active speaker
      const speakingIcon = document.querySelector('.google-material-icons:has(+ .ZjFb7c)');
      if (speakingIcon?.parentElement?.textContent?.trim()) {
        return speakingIcon.parentElement.textContent.trim();
      }
    }

    if (p === 'zoom') {
      // Zoom highlights the active speaker with a green border (config-driven overlay)
      const overlay = overlayText();
      if (overlay) return overlay;

      // Participant panel shows a mic icon with voice activity
      const participants = document.querySelectorAll('[class*="participants-item"]');
      for (const el of participants) {
        const isSpeaking = el.querySelector('[class*="icon-unmuted"][class*="speaking"], [class*="voice-level"]');
        if (isSpeaking) {
          const name = el.querySelector('[class*="display-name"]');
          if (name?.textContent?.trim()) return name.textContent.trim();
        }
      }
    }

    return null;
  }, { p: platform, overlays: overlaySelectors }).catch(() => null);
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
  const startTime = Date.now();
  let lastHumanCount = -1;

  // All leave logic lives in the pure, unit-tested LeavePolicy (M1/M9/M7). The loop just
  // feeds it observations. leaveButtonMissesToEnd=2 preserves the debounce; the first
  // MIN_CALL_SECONDS is a warm-up where we DON'T act on a missing leave button, but we DO
  // still track participants/speakers/signals (M6: the old `continue` dropped early data).
  const policy = new LeavePolicy(
    {
      minHumansToStay: config.minHumansToStay,
      aloneTimeoutMs: config.aloneTimeoutMinutes * 60 * 1000,
      leaveGracePeriodMs: config.leaveGracePeriodSeconds * 1000,
      maxDurationMs: maxMs,
      leaveButtonMissesToEnd: 2,
      emptyPollsToTrigger: 2,
    },
    startTime,
  );

  // Track all participants and active speaker over time
  const participantMap = new Map<string, Participant>();
  const speakerTracker = new SpeakerTracker();

  const MIN_CALL_SECONDS = 60; // Warm-up: don't ACT on "ended" in the first 60 seconds

  while (Date.now() - startTime < maxMs) {
    await page.waitForTimeout(5000);
    const inWarmup = Date.now() - startTime < MIN_CALL_SECONDS * 1000;

    // Detect the Leave button (most reliable end signal). Page-closed → treat as gone.
    let leaveVisible = false;
    let pageClosed = false;
    try {
      leaveVisible = await page.evaluate((p) => {
        if (p === 'meet') return !!document.querySelector('[aria-label="Leave call"]');
        if (p === 'teams') {
          return !!document.querySelector('button:has([data-tid="hangup-button"]), button[aria-label="Leave"], #hangup-button');
        }
        // Zoom
        return !!document.querySelector('[aria-label="Leave"], .footer__leave-btn');
      }, platform);
    } catch {
      // M2: page/browser closed mid-meeting — end via the normal finalize path, don't throw.
      pageClosed = true;
    }
    if (pageClosed) {
      console.error('[mibot] Page closed — meeting ended');
      break;
    }

    // Track participants — process all names in a single pass to avoid classification race
    const { humans, bots, rosterCount } = await getParticipants(page, platform)
      .catch(() => ({ humans: [] as string[], bots: [] as string[], rosterCount: undefined }));
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
    await signalTracker.poll(page, platform).catch(() => {}); // M8: never let a poll crash end the meeting

    // M3: feed roster-count-minus-self into the leave gate when names can't be scraped.
    const humanCount = deriveHumanCount({ humans, bots, rosterCount });

    if (humanCount !== lastHumanCount) {
      const botStr = bots.length > 0 ? ` + ${bots.length} bot(s)` : '';
      console.error(`[mibot] Participants: ${humanCount} human(s)${botStr}`);
      lastHumanCount = humanCount;
    }

    // During warm-up we track but never end on a missing button (avoid false-positive
    // exits before the UI settles); pass hasLeaveButton:true so only real presence-based
    // exits are suppressed by max-duration, which can't fire this early anyway.
    const decision = policy.observe(
      { humanCount, hasLeaveButton: inWarmup ? true : leaveVisible },
      Date.now(),
    );
    if (decision.action === 'leave') {
      if (decision.reason === 'meeting-ended') {
        await page.screenshot({ path: endedScreenshotPath(platform) }).catch(() => {}); // M14
      }
      console.error(`[mibot] Leaving — ${decision.reason}`);
      break;
    }
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
