/**
 * AR1 slice: the engine-agnostic core of a monitor loop.
 *
 * Both monitor loops (waitForMeetingEnd for Playwright, monitorCamofoxMeeting for camofox)
 * independently hand-rolled the same two pieces of bookkeeping: diffing a set of observed
 * names into join/leave events, and folding an active-speaker sample into timeline segments.
 * The camofox copies had quietly drifted from the Playwright ones -- they never logged
 * join/leave, dropped the bot/human reclassification on conflict, and inlined a second
 * speaker tracker rather than using SpeakerTracker.
 *
 * Neither of these needs a browser, so they don't belong in either engine. This is the
 * pragmatic slice of AR1: unify what is genuinely shared and testable, without forcing a
 * BrowserBackend interface over two page objects whose APIs (Playwright Locator vs. camofox
 * REST snapshots) have almost nothing in common.
 */

export interface TrackedParticipant {
  name: string;
  joined_at: string;
  left_at: string | null;
  is_bot: boolean;
  spoke: boolean;
}

/**
 * Incremental roster diff. Feed it each poll's observed names; it maintains join/leave times
 * and handles rejoins (clearing left_at) and bot reclassification.
 */
export class RosterTracker {
  private map = new Map<string, TrackedParticipant>();

  constructor(private log: (msg: string) => void = () => {}) {}

  /** Apply one poll's observation. `names` maps name → is_bot. */
  observe(names: Map<string, boolean>, now: string = new Date().toISOString()): void {
    for (const [name, isBot] of names) {
      const existing = this.map.get(name);
      if (!existing) {
        this.map.set(name, { name, joined_at: now, left_at: null, is_bot: isBot, spoke: false });
        this.log(`${isBot ? 'Bot' : 'Participant'} joined: ${name}`);
      } else {
        // Bot classification can change once a display name resolves; keep the latest.
        if (existing.is_bot !== isBot) existing.is_bot = isBot;
        if (existing.left_at) {
          existing.left_at = null;
          this.log(`Participant rejoined: ${name}`);
        }
      }
    }
    for (const [name, p] of this.map) {
      if (!names.has(name) && !p.left_at) {
        p.left_at = now;
        this.log(`Participant left: ${name}`);
      }
    }
  }

  /** Mark a name as having spoken, if present. */
  markSpoke(name: string): void {
    const p = this.map.get(name);
    if (p) p.spoke = true;
  }

  get size(): number { return this.map.size; }
  names(): string[] { return [...this.map.keys()]; }

  /** Close out open leave times and return the final list. */
  finish(now: string = new Date().toISOString()): TrackedParticipant[] {
    for (const p of this.map.values()) if (!p.left_at) p.left_at = now;
    return [...this.map.values()];
  }
}
