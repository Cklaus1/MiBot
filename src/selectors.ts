import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Platform-specific CSS selectors for scraping meeting UIs.
 *
 * These are separated from the extraction *logic* (which stays in meeting.ts /
 * bot.ts) because a subset — the obfuscated, minified class names Google/Zoom
 * generate (e.g. Meet's `.KV1GEc`) — churn without notice and are the single
 * biggest source of scraper breakage. Keeping the strings here means:
 *   1. one source of truth (the Playwright and Camofox paths can't drift), and
 *   2. they can be overridden at runtime via
 *      ~/.config/mibot/selectors/<platform>.json — no rebuild needed.
 *
 * Each field is an ordered fallback list: try the first, then the next. Put the
 * stable semantic selectors (data-*, aria-*) first and the fragile minified
 * classes last, so an obsolete class name degrades instead of breaking.
 */
export interface PlatformSelectors {
  /** Elements whose text/attributes yield participant names. */
  participantNames: string[];
  /** Active-speaker name-overlay selectors, tried via textContent (the most
   *  brittle: minified classes). Stable attribute-based speaker checks
   *  (data-*, aria-*) stay in code; only these fallback overlays live here. */
  activeSpeaker: string[];
  /**
   * Wave 10 #1: on-screen PHRASES (case-insensitive substrings, not CSS) that explain a failed
   * join. Localized and liable to change, hence config-driven like the selectors above.
   */
  waitingRoomText: string[];
  notStartedText: string[];
  notAdmittedText: string[];
  authRequiredText: string[];
}

export type Platform = 'meet' | 'teams' | 'zoom';

/** Bundled defaults. Semantic selectors first, obfuscated classes last. */
export const DEFAULT_SELECTORS: Record<Platform, PlatformSelectors> = {
  meet: {
    participantNames: ['[data-participant-id]', '[data-self-name]', '.zWfAib'],
    // '.KV1GEc' / '.cS7aqe.NkoVdd' are Meet's minified speaker-overlay classes.
    activeSpeaker: ['.KV1GEc', '.cS7aqe.NkoVdd'],
    waitingRoomText: ['Asking to join', 'Please wait until a meeting host brings you into the call', 'You\'ll join the call when someone lets you in'],
    notStartedText: ['waiting for the host', 'This meeting hasn\'t started'],
    notAdmittedText: ["You can't join this video call", 'No one responded to your request', 'denied your request to join', 'You have been removed from the meeting'],
    authRequiredText: ['Sign in to join', 'Sign in with your Google Account', 'Use your Google Account'],
  },
  teams: {
    participantNames: ['[data-tid="participantItem"]', '.ui-chat__messagecontent', '[role="listitem"]'],
    activeSpeaker: ['[data-tid="video-stream-label"]', '[data-tid="active-speaker-name"]'],
    waitingRoomText: ['Someone in the meeting should let you in soon', 'Waiting for someone to let you in', 'in the lobby'],
    notStartedText: ['The meeting hasn\'t started', 'Waiting for the organizer'],
    notAdmittedText: ['denied access to the meeting', 'Nobody responded to your request to join', 'You\'ve been removed from this meeting'],
    authRequiredText: ['Sign in to join this meeting', 'Pick an account', 'Sign in to your account', 'only people with access'],
  },
  zoom: {
    participantNames: ['[class*="participant"]', '.participants-item__display-name', '[class*="attendee"]'],
    activeSpeaker: ['.speaker-active-container__name', '[class*="active-speaker"] [class*="display-name"]'],
    waitingRoomText: ['the meeting host will let you in soon', 'Host has joined. We\'ve let them know you\'re here', 'waiting room'],
    notStartedText: ['Waiting for the host to start this meeting', 'Waiting for host to start the meeting', 'The meeting has not started'],
    notAdmittedText: ['removed you from the meeting', 'The host has removed you', 'meeting has been locked', 'Meeting passcode is incorrect'],
    authRequiredText: ['Sign in to join', 'This meeting is for authorized attendees only', 'Authorized attendees only'],
  },
};

const SELECTORS_DIR = path.join(os.homedir(), '.config', 'mibot', 'selectors');

/**
 * Validate one override list. Returns the array only when it is an array of
 * strings; otherwise null so the caller keeps the bundled default. Array.isArray
 * alone was not enough — a JSON file with `[123, null]` passed that check and
 * pushed non-string "selectors" into the DOM query APIs, which throw at scrape
 * time far from the config that caused it.
 */
export function sanitizeSelectorList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  if (!value.every((el) => typeof el === 'string')) return null;
  return value as string[];
}

const _cache = new Map<string, PlatformSelectors>();

/**
 * Load selectors for a platform: bundled defaults merged with an optional
 * ~/.config/mibot/selectors/<platform>.json override. Override keys replace the
 * corresponding default list wholesale; unspecified keys keep their defaults.
 */
export function loadSelectors(platform: string): PlatformSelectors {
  const cached = _cache.get(platform);
  if (cached) return cached;

  const empty: PlatformSelectors = {
    participantNames: [], activeSpeaker: [], waitingRoomText: [], notStartedText: [], notAdmittedText: [], authRequiredText: [],
  };
  const base = DEFAULT_SELECTORS[platform as Platform] ?? empty;
  const merged = Object.fromEntries(
    (Object.keys(empty) as (keyof PlatformSelectors)[]).map((k) => [k, [...base[k]]]),
  ) as unknown as PlatformSelectors;

  const overridePath = path.join(SELECTORS_DIR, `${platform}.json`);
  if (fs.existsSync(overridePath)) {
    try {
      const override = JSON.parse(fs.readFileSync(overridePath, 'utf8')) as Record<string, unknown>;
      // Every key: an override list replaces that default list wholesale; invalid lists are ignored.
      for (const k of Object.keys(merged) as (keyof PlatformSelectors)[]) {
        const list = sanitizeSelectorList(override[k]);
        if (list) merged[k] = list;
      }
      console.error(`[mibot] Loaded selector override: ${overridePath}`);
    } catch (err) {
      console.error(`[mibot] Warning: invalid selectors at ${overridePath}, using defaults — ${(err as Error).message}`);
    }
  }

  _cache.set(platform, merged);
  return merged;
}

/** Clear the cache (test hook / config reload). */
export function reloadSelectors(): void {
  _cache.clear();
}
