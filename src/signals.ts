import { type Page } from 'playwright';
import fs from 'fs';
import path from 'path';

/**
 * Compute a perceptual hash of a JPEG image buffer.
 * Extracts a fingerprint by sampling the compressed data at structured intervals,
 * skipping the JPEG header (first 2KB) which contains metadata that varies.
 * Returns a hex string that's stable for visually identical content.
 */
function perceptualHash(buf: Buffer): string {
  // Skip JPEG header/metadata (typically first ~2KB), hash the image data
  const start = Math.min(2048, Math.floor(buf.length * 0.1));
  const end = buf.length;
  const dataLen = end - start;
  if (dataLen < 100) return buf.length.toString(16); // Too small, use size

  // Sample 256 evenly-spaced bytes from the image data and build a hash
  const step = Math.max(1, Math.floor(dataLen / 256));
  let hash = 0;
  for (let i = start; i < end; i += step) {
    // Simple but effective: rotate and XOR
    hash = ((hash << 5) - hash + buf[i]) | 0;
  }
  return hash.toString(16);
}

/**
 * Compare two image buffers for visual similarity.
 * Uses perceptual hashing (skips JPEG headers) + size comparison.
 * threshold: 0.02 = 2%
 */
function isSimilar(a: Buffer, b: Buffer, threshold: number): boolean {
  // Quick check: if sizes differ by more than 15%, definitely different
  const sizeDiff = Math.abs(a.length - b.length) / Math.max(a.length, b.length);
  if (sizeDiff > 0.15) return false;

  // Compare perceptual hashes
  if (perceptualHash(a) === perceptualHash(b)) return true;

  // Fallback: sample image data bytes (skip headers) and compare
  const start = Math.min(2048, Math.floor(Math.min(a.length, b.length) * 0.1));
  const len = Math.min(a.length, b.length) - start;
  const samples = Math.min(500, len);
  const step = Math.max(1, Math.floor(len / samples));
  let diffCount = 0;

  for (let i = start; i < start + len; i += step) {
    if (a[i] !== b[i]) diffCount++;
  }

  return (diffCount / samples) < threshold;
}

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

// ── Signal Tracker ────────────────────────────────────────────────────

export class SignalTracker {
  private chat: ChatMessage[] = [];
  private reactions: Reaction[] = [];
  private handRaises = new Map<string, HandRaise>();
  private currentShare: ScreenShare | null = null;
  private completedShares: ScreenShare[] = [];
  private seenChatHashes = new Set<string>();
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
        const items = document.querySelectorAll('[class*="chat-message"]');
        items.forEach(el => {
          const sender = el.querySelector('[class*="sender"]')?.textContent?.trim() || '';
          const text = el.querySelector('[class*="content"], [class*="message-text"]')?.textContent?.trim() || '';
          if (text) results.push({ sender, text });
        });
      }

      return results;
    }, platform).catch(() => []);

    // Dedup by content hash (handles DOM reordering and scrolling)
    const now = new Date().toISOString();
    for (const msg of messages) {
      const hash = `${msg.sender}::${msg.text}`;
      if (!this.seenChatHashes.has(hash)) {
        this.seenChatHashes.add(hash);
        this.chat.push({ sender: msg.sender, text: msg.text, timestamp: now });
        console.error(`[mibot] Chat: ${msg.sender}: ${msg.text.substring(0, 80)}`);
      }
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
          // Participant name is sometimes in a sibling or parent
          const name = el.closest('[data-tid="participantItem"]')?.textContent?.trim() || '';
          results.push({ participant: name, type });
        });

        // Also check for raised hand indicators as reactions
        const handIcons = document.querySelectorAll('[data-tid*="raised-hand"], [class*="hand-raised"]');
        handIcons.forEach(el => {
          const name = el.closest('[data-tid="participantItem"]')?.textContent?.trim() || '';
          results.push({ participant: name, type: 'raised_hand' });
        });
      }

      return results;
    }, platform).catch(() => []);

    const now = new Date().toISOString();
    for (const r of reactions) {
      this.reactions.push({ participant: r.participant, type: r.type, timestamp: now });
      if (r.type !== 'raised_hand') {
        console.error(`[mibot] Reaction: ${r.participant} → ${r.type}`);
      }
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

      return results;
    }, platform).catch(() => []);

    const now = new Date().toISOString();
    const currentRaised = new Set(raisedNames);

    // New hands raised
    for (const name of raisedNames) {
      if (!this.handRaises.has(name) || this.handRaises.get(name)!.lowered_at !== null) {
        this.handRaises.set(name, { participant: name, raised_at: now, lowered_at: null });
        console.error(`[mibot] ✋ Hand raised: ${name}`);
      }
    }

    // Hands lowered
    for (const [name, raise] of this.handRaises) {
      if (!currentRaised.has(name) && raise.lowered_at === null) {
        raise.lowered_at = now;
        console.error(`[mibot] Hand lowered: ${name}`);
      }
    }
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
        const banner = document.querySelector('[class*="sharing-indicator"], [class*="screen-share"]');
        if (banner) return banner.textContent?.trim() || 'someone';
      }

      return null;
    }, platform).catch(() => null);

    const now = new Date().toISOString();

    if (sharing && !this.currentShare) {
      // Screen sharing started
      this.currentShare = { presenter: sharing, started_at: now, ended_at: null, screenshots: [] };
      console.error(`[mibot] Screen share started: ${sharing}`);
    } else if (!sharing && this.currentShare) {
      // Screen sharing stopped
      this.currentShare.ended_at = now;
      this.completedShares.push(this.currentShare);
      console.error(`[mibot] Screen share ended: ${this.currentShare.presenter} (${this.currentShare.screenshots.length} screenshots)`);
      this.currentShare = null;
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
      if (this.lastScreenshotBytes && isSimilar(this.lastScreenshotBytes, currentBytes, 0.02)) {
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

    // Close any open hand raises
    const now = new Date().toISOString();
    for (const raise of this.handRaises.values()) {
      if (!raise.lowered_at) raise.lowered_at = now;
    }

    const signals: MeetingSignals = {
      chat: this.chat,
      reactions: this.reactions,
      hand_raises: [...this.handRaises.values()],
      screen_shares: this.completedShares,
    };

    if (this.chat.length > 0) console.error(`[mibot] Chat: ${this.chat.length} messages captured`);
    if (this.reactions.length > 0) console.error(`[mibot] Reactions: ${this.reactions.length} captured`);
    if (this.handRaises.size > 0) console.error(`[mibot] Hand raises: ${this.handRaises.size} captured`);
    if (this.completedShares.length > 0) {
      const totalScreenshots = this.completedShares.reduce((n, s) => n + s.screenshots.length, 0);
      console.error(`[mibot] Screen shares: ${this.completedShares.length} sessions, ${totalScreenshots} screenshots`);
    }

    return signals;
  }
}
