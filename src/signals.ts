import { type Page } from 'playwright';
import fs from 'fs';
import path from 'path';
import { OccurrenceDeduper, risingEdgeReactions, HandRaiseTracker } from './signal-dedup.js';
// M12/M16: one shared, correctly-normalized screenshot-similarity check (was duplicated inline
// here and in bot.ts, both dividing the diff count by `samples` instead of the actual count).
import { isSimilarImage } from './image-similarity.js';

// ── Types ─────────────────────────────────────────────────────────────

export interface ChatMessage {
  sender: string;
  text: string;
  timestamp: string;
}

export interface Reaction {
  participant: string;
  type: string;       // like, heart, laugh, applause, surprised
  timestamp: string;
}

export interface HandRaise {
  participant: string;
  raised_at: string;
  lowered_at: string | null;
}

export interface ScreenShare {
  presenter: string;
  started_at: string;
  ended_at: string | null;
  screenshots: string[];   // file paths
}

export interface MeetingSignals {
  chat: ChatMessage[];
  reactions: Reaction[];
  hand_raises: HandRaise[];
  screen_shares: ScreenShare[];
}

// ── Screen-share state machine (M13) ──────────────────────────────────

export type ShareTransition =
  | { kind: 'none' }
  | { kind: 'start'; presenter: string }
  | { kind: 'end' }
  | { kind: 'handoff'; presenter: string };

/**
 * Decide the screen-share transition from the newly-scraped presenter (`sharingNow`, null if
 * nobody is presenting) and the presenter of the currently-open share (`currentPresenter`).
 * The handoff case — a different presenter than the open share — closes the old and opens the
 * new in one step, which the old start/end-only logic missed (M13).
 */
export function shareTransition(
  sharingNow: string | null,
  currentPresenter: string | null,
): ShareTransition {
  if (!sharingNow && !currentPresenter) return { kind: 'none' };
  if (sharingNow && !currentPresenter) return { kind: 'start', presenter: sharingNow };
  if (!sharingNow && currentPresenter) return { kind: 'end' };
  // Both present: same presenter → nothing changed; different → handoff.
  return sharingNow === currentPresenter
    ? { kind: 'none' }
    : { kind: 'handoff', presenter: sharingNow! };
}

// ── Signal Tracker ────────────────────────────────────────────────────

export class SignalTracker {
  private chat: ChatMessage[] = [];
  private reactions: Reaction[] = [];
  // M10: full raise history (a re-raise after lowering used to overwrite the prior raise).
  private handTracker = new HandRaiseTracker();
  private handOpen = new Set<string>(); // for rising/falling-edge log lines only
  private currentShare: ScreenShare | null = null;
  private completedShares: ScreenShare[] = [];
  // M4/R11: content-stable, occurrence-counted chat dedup (survives chat virtualization).
  private chatDedup = new OccurrenceDeduper<{ sender: string; text: string }>(
    (m) => `${m.sender}::${m.text}`,
  );
  // M5/R11: reactions are transient — dedup on the rising edge (present now, absent last poll)
  // so an animation spanning two polls counts once. Threaded poll-to-poll.
  private reactionKeys = new Set<string>();
  private screenshotDir: string;
  private screenshotInterval = 30_000; // 30 seconds
  private lastScreenshot = 0;
  private screenshotCount = 0;
  private lastScreenshotBytes: Buffer | null = null;
  private static readonly MAX_SCREENSHOTS = 240;

  constructor(recordingDir: string, meetingId: number) {
    this.screenshotDir = path.join(recordingDir, `screenshots-${meetingId}`);
  }

  /** Poll all signals from the meeting page. Call this every 5 seconds. */
  async poll(page: Page, platform: string): Promise<void> {
    await Promise.all([
      this.pollChat(page, platform),
      this.pollReactions(page, platform),
      this.pollHandRaises(page, platform),
      this.pollScreenShare(page, platform),
    ]);
  }

  // ── Chat ──────────────────────────────────────────────────────

  private async pollChat(page: Page, platform: string): Promise<void> {
    const messages = await page.evaluate((p) => {
      const results: Array<{ sender: string; text: string }> = [];

      if (p === 'teams') {
        const items = document.querySelectorAll(
          '[data-tid="chat-pane-message"], .ui-chat__message, [class*="chatMessage"]'
        );
        items.forEach(el => {
          const sender = el.querySelector(
            '[data-tid="message-author"], [class*="author"], .ui-chat__message__author'
          )?.textContent?.trim() || '';
          const text = el.querySelector(
            '[data-tid="message-body"], [class*="messageBody"], .ui-chat__message__content'
          )?.textContent?.trim() || '';
          if (sender && text) results.push({ sender, text });
        });
      }

      if (p === 'meet') {
        const items = document.querySelectorAll('[data-message-text]');
        items.forEach(el => {
          const sender = el.querySelector('[data-sender-name]')?.getAttribute('data-sender-name') || '';
          const text = el.getAttribute('data-message-text') || el.textContent?.trim() || '';
          if (text) results.push({ sender, text });
        });
      }

      if (p === 'zoom') {
        // Zoom web client chat panel
        const items = document.querySelectorAll(
          '[class*="chat-message"], [class*="ChatMessage"], [id*="chat-message"]'
        );
        items.forEach(el => {
          const sender = el.querySelector(
            '[class*="sender"], [class*="ChatSender"], [class*="message-author"]'
          )?.textContent?.trim() || '';
          const text = el.querySelector(
            '[class*="content"], [class*="message-text"], [class*="ChatContent"]'
          )?.textContent?.trim() || '';
          if (text) results.push({ sender, text });
        });
      }

      return results;
    }, platform).catch(() => []);

    // M4/R11: dedup on stable content with an occurrence counter, so chat virtualization
    // (which shifts DOM indices as the panel scrolls) no longer re-emits the whole window,
    // while a genuinely repeated identical message still counts as new.
    const now = new Date().toISOString();
    for (const msg of this.chatDedup.add(messages)) {
      this.chat.push({ sender: msg.sender, text: msg.text, timestamp: now });
      console.error(`[mibot] Chat: ${msg.sender}: ${msg.text.substring(0, 80)}`);
    }
  }

  // ── Reactions ─────────────────────────────────────────────────

  private async pollReactions(page: Page, platform: string): Promise<void> {
    const reactions = await page.evaluate((p) => {
      const results: Array<{ participant: string; type: string }> = [];

      if (p === 'teams') {
        // Teams shows floating reaction animations
        const reactionEls = document.querySelectorAll(
          '[data-tid*="reaction"], [class*="reaction-animation"], [class*="meeting-reaction"]'
        );
        reactionEls.forEach(el => {
          const type = el.getAttribute('data-tid')?.replace('reaction-', '')
            || el.getAttribute('aria-label')
            || el.textContent?.trim() || 'unknown';
          const name = el.closest('[data-tid="participantItem"]')?.textContent?.trim() || '';
          results.push({ participant: name, type });
        });
        // M5: raised hands are NOT reactions — pollHandRaises owns them. Scraping them here
        // re-emitted a phantom reaction every poll for the whole duration of a raised hand.
      }

      if (p === 'zoom') {
        // Zoom shows floating reaction animations over video tiles
        const reactionEls = document.querySelectorAll(
          '[class*="meeting-reaction"], [class*="reactions-animation"], [class*="emoji-reaction"]'
        );
        reactionEls.forEach(el => {
          const type = el.getAttribute('aria-label') || el.textContent?.trim() || 'unknown';
          const tile = el.closest('[class*="video-avatar"], [class*="participant"]');
          const name = tile?.querySelector('[class*="display-name"]')?.textContent?.trim() || '';
          results.push({ participant: name, type });
        });
      }

      return results;
    }, platform).catch(() => []);

    // M5: rising-edge dedup — a reaction animation spanning multiple polls counts once.
    const now = new Date().toISOString();
    const { fresh, keys } = risingEdgeReactions(reactions, this.reactionKeys);
    this.reactionKeys = keys;
    for (const r of fresh) {
      this.reactions.push({ participant: r.participant, type: r.type, timestamp: now });
      console.error(`[mibot] Reaction: ${r.participant} → ${r.type}`);
    }
  }

  // ── Raised Hands ──────────────────────────────────────────────

  private async pollHandRaises(page: Page, platform: string): Promise<void> {
    const raisedNames = await page.evaluate((p) => {
      const results: string[] = [];

      if (p === 'teams') {
        const handIcons = document.querySelectorAll(
          '[data-tid*="raised-hand"], [class*="hand-raised"], [aria-label*="hand raised"]'
        );
        handIcons.forEach(el => {
          const item = el.closest('[data-tid="participantItem"], [role="listitem"]');
          const name = item?.textContent?.trim() || '';
          if (name) results.push(name);
        });
      }

      if (p === 'meet') {
        const handIcons = document.querySelectorAll('[aria-label*="hand raised"], [data-is-hand-raised="true"]');
        handIcons.forEach(el => {
          const name = el.closest('[data-participant-id]')?.textContent?.trim() || '';
          if (name) results.push(name);
        });
      }

      if (p === 'zoom') {
        // Zoom shows a raised hand icon next to participant name in the roster
        const handEls = document.querySelectorAll(
          '[class*="raise-hand"], [class*="hand-raised"], [aria-label*="hand raised"]'
        );
        handEls.forEach(el => {
          const item = el.closest('[class*="participants-item"], [class*="participant"]');
          const name = item?.querySelector('[class*="display-name"]')?.textContent?.trim() || '';
          if (name) results.push(name);
        });
      }

      return results;
    }, platform).catch(() => []);

    const now = new Date().toISOString();
    const currentRaised = new Set(raisedNames);

    // Rising/falling-edge log lines (the tracker owns the actual history).
    for (const name of currentRaised) {
      if (!this.handOpen.has(name)) console.error(`[mibot] ✋ Hand raised: ${name}`);
    }
    for (const name of this.handOpen) {
      if (!currentRaised.has(name)) console.error(`[mibot] Hand lowered: ${name}`);
    }
    this.handOpen = currentRaised;

    // M10: append to full history — re-raises no longer overwrite the earlier completed raise.
    this.handTracker.observe(raisedNames, now);
  }

  // ── Screen Sharing ────────────────────────────────────────────

  private async pollScreenShare(page: Page, platform: string): Promise<void> {
    const sharing = await page.evaluate((p) => {
      if (p === 'teams') {
        // Teams shows "X is presenting" banner or a sharing indicator
        const banner = document.querySelector(
          '[data-tid*="sharing-indicator"], [data-tid*="screen-sharing"], [class*="sharing-banner"]'
        );
        if (banner) {
          const name = banner.textContent?.replace(/is (presenting|sharing).*/i, '').trim() || 'someone';
          return name;
        }
        // Also check for screen share content area
        const shareContent = document.querySelector('[data-tid="content-share"], [class*="screen-share-video"]');
        if (shareContent) return 'unknown';
      }

      if (p === 'meet') {
        const banner = document.querySelector('[class*="presenting"], [data-is-presenting="true"]');
        if (banner) return banner.textContent?.trim() || 'someone';
      }

      if (p === 'zoom') {
        // Zoom shows "X's screen" or a sharing indicator bar
        const banner = document.querySelector(
          '[class*="sharing-indicator"], [class*="screen-share"], [class*="share-bar"], [aria-label*="screen share"]'
        );
        if (banner) {
          const text = banner.textContent?.trim() || '';
          const nameMatch = text.match(/(.+?)(?:'s screen|is sharing)/i);
          return nameMatch ? nameMatch[1].trim() : text || 'someone';
        }
        // Also check for sharing content view
        const shareView = document.querySelector('[class*="sharing-content"], [class*="share-canvas"]');
        if (shareView) return 'someone';
      }

      return null;
    }, platform).catch(() => null);

    const now = new Date().toISOString();

    // M13: single state machine covers the presenter-handoff case (A stops + B starts within
    // one poll gap), which the old start/end-only branches silently dropped onto A.
    const closeCurrent = () => {
      this.currentShare!.ended_at = now;
      this.completedShares.push(this.currentShare!);
      console.error(`[mibot] Screen share ended: ${this.currentShare!.presenter} (${this.currentShare!.screenshots.length} screenshots)`);
    };
    const transition = shareTransition(sharing, this.currentShare?.presenter ?? null);
    if (transition.kind === 'start') {
      this.currentShare = { presenter: transition.presenter, started_at: now, ended_at: null, screenshots: [] };
      console.error(`[mibot] Screen share started: ${transition.presenter}`);
    } else if (transition.kind === 'end') {
      closeCurrent();
      this.currentShare = null;
    } else if (transition.kind === 'handoff') {
      closeCurrent();
      this.currentShare = { presenter: transition.presenter, started_at: now, ended_at: null, screenshots: [] };
      console.error(`[mibot] Screen share started: ${transition.presenter}`);
    }

    // Take screenshot during active screen share
    if (this.currentShare && Date.now() - this.lastScreenshot >= this.screenshotInterval) {
      await this.takeScreenshot(page);
      this.lastScreenshot = Date.now();
    }
  }

  private async takeScreenshot(page: Page): Promise<void> {
    if (!this.currentShare) return;
    if (this.screenshotCount >= SignalTracker.MAX_SCREENSHOTS) {
      console.error(`[mibot] Max screenshots (${SignalTracker.MAX_SCREENSHOTS}) reached, skipping`);
      return;
    }

    if (!fs.existsSync(this.screenshotDir)) {
      fs.mkdirSync(this.screenshotDir, { recursive: true });
    }

    const filename = `share-${Date.now()}.jpg`;
    const filepath = path.join(this.screenshotDir, filename);

    try {
      await page.screenshot({ path: filepath, type: 'jpeg', quality: 70 });
      // Skip if visually similar to previous screenshot.
      // Compare raw JPEG bytes — sample evenly across the file and measure
      // the byte-level difference ratio. Under 2% = same slide.
      const currentBytes = fs.readFileSync(filepath);
      if (this.lastScreenshotBytes && isSimilarImage(this.lastScreenshotBytes, currentBytes, 0.08)) {
        fs.unlinkSync(filepath);
        return; // Same slide, don't count it
      }
      this.lastScreenshotBytes = currentBytes;
      this.currentShare.screenshots.push(filepath);
      this.screenshotCount++;
    } catch {
      // Page may be in a state where screenshots fail — skip silently
    }
  }

  // ── Finalize ──────────────────────────────────────────────────

  finish(): MeetingSignals {
    // Close any open screen share
    if (this.currentShare) {
      this.currentShare.ended_at = new Date().toISOString();
      this.completedShares.push(this.currentShare);
    }

    // Close any open hand raises (M10: full history, including re-raises).
    const now = new Date().toISOString();
    const handRaises = this.handTracker.finish(now);

    const signals: MeetingSignals = {
      chat: this.chat,
      reactions: this.reactions,
      hand_raises: handRaises,
      screen_shares: this.completedShares,
    };

    if (this.chat.length > 0) console.error(`[mibot] Chat: ${this.chat.length} messages captured`);
    if (this.reactions.length > 0) console.error(`[mibot] Reactions: ${this.reactions.length} captured`);
    if (handRaises.length > 0) console.error(`[mibot] Hand raises: ${handRaises.length} captured`);
    if (this.completedShares.length > 0) {
      const totalScreenshots = this.completedShares.reduce((n, s) => n + s.screenshots.length, 0);
      console.error(`[mibot] Screen shares: ${this.completedShares.length} sessions, ${totalScreenshots} screenshots`);
    }

    return signals;
  }
}
