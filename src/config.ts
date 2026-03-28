import fs from 'fs';
import path from 'path';
import os from 'os';

const CONFIG_PATH = path.join(os.homedir(), '.config', 'mibot', 'config.json');

export interface MiBotConfig {
  /** IANA timezone for display (e.g. "America/New_York", "America/Chicago") */
  timezone: string;

  /** Bot display name shown to other participants */
  botName: string;

  /** Minutes before meeting start to join */
  joinBeforeMinutes: number;

  /** Calendar poll interval in minutes */
  pollMinutes: number;

  /** Max meeting duration in hours (safety valve) */
  maxDurationHours: number;

  /** Seconds to wait after last human leaves before exiting */
  leaveGracePeriodSeconds: number;

  /** Minutes alone before leaving (e.g., stuck in waiting room) */
  aloneTimeoutMinutes: number;

  /** Minimum participants (excluding bots) to stay in the call.
   *  0 = leave when all humans leave. 1 = leave when you'd be the only human. */
  minHumansToStay: number;

  /** Known bot name patterns (case-insensitive). If a participant matches, they don't count as human. */
  botPatterns: string[];

  /** Meeting title patterns to never join (case-insensitive regex) */
  neverJoin: string[];

  /** Only join meetings where you are the organizer */
  onlyOrganized: boolean;

  /** Minimum attendees (from calendar) to join. Skips 1:1s if set to 3. */
  minAttendees: number;
}

const DEFAULTS: MiBotConfig = {
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  botName: 'MiBot',
  joinBeforeMinutes: 2,
  pollMinutes: 2,
  maxDurationHours: 4,
  leaveGracePeriodSeconds: 30,
  aloneTimeoutMinutes: 5,
  minHumansToStay: 0,
  botPatterns: [
    'otter\\.ai',
    'fireflies',
    'circleback',
    'gong\\.io',
    'chorus',
    'avoma',
    'fathom',
    'grain',
    'read\\.ai',
    'sembly',
    'krisp',
    'tactiq',
    'notiv',
    'jamie',
    'supernormal',
    'Fellow\\.app',
    'Recall\\.ai',
    'meetgeek',
    '\\bbot\\b',
    '\\brecord',
    '\\bnotetaker\\b',
    'mibot',
  ],
  neverJoin: [
    'lunch',
    'personal',
    'block',
    'focus time',
    'no bot',
  ],
  onlyOrganized: false,
  minAttendees: 0,
};

let _config: MiBotConfig | null = null;

export function loadConfig(): MiBotConfig {
  if (_config) return _config;

  let fileConfig: Partial<MiBotConfig> = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (err) {
      console.error(`[mibot] Warning: invalid config at ${CONFIG_PATH}, using defaults`);
    }
  }

  // Env vars override file config (with validation)
  const env = process.env;
  const safeInt = (val: string | undefined, min = 0, max = 10000): number | undefined => {
    if (!val) return undefined;
    const n = parseInt(val, 10);
    return isNaN(n) || n < min || n > max ? undefined : n;
  };

  _config = {
    ...DEFAULTS,
    ...fileConfig,
    ...(env.MIBOT_TIMEZONE ? { timezone: env.MIBOT_TIMEZONE } : {}),
    ...(env.MIBOT_NAME ? { botName: env.MIBOT_NAME } : {}),
    ...(safeInt(env.MIBOT_JOIN_BEFORE, 0, 60) !== undefined ? { joinBeforeMinutes: safeInt(env.MIBOT_JOIN_BEFORE, 0, 60)! } : {}),
    ...(safeInt(env.MIBOT_POLL_MINUTES, 1, 60) !== undefined ? { pollMinutes: safeInt(env.MIBOT_POLL_MINUTES, 1, 60)! } : {}),
    ...(safeInt(env.MIBOT_MAX_DURATION, 1, 24) !== undefined ? { maxDurationHours: safeInt(env.MIBOT_MAX_DURATION, 1, 24)! } : {}),
    ...(safeInt(env.MIBOT_LEAVE_GRACE, 5, 600) !== undefined ? { leaveGracePeriodSeconds: safeInt(env.MIBOT_LEAVE_GRACE, 5, 600)! } : {}),
    ...(safeInt(env.MIBOT_ALONE_TIMEOUT, 1, 240) !== undefined ? { aloneTimeoutMinutes: safeInt(env.MIBOT_ALONE_TIMEOUT, 1, 240)! } : {}),
    ...(safeInt(env.MIBOT_MIN_HUMANS, 0, 100) !== undefined ? { minHumansToStay: safeInt(env.MIBOT_MIN_HUMANS, 0, 100)! } : {}),
    ...(safeInt(env.MIBOT_MIN_ATTENDEES, 0, 100) !== undefined ? { minAttendees: safeInt(env.MIBOT_MIN_ATTENDEES, 0, 100)! } : {}),
  };

  return _config;
}

export function reloadConfig(): MiBotConfig {
  _config = null;
  return loadConfig();
}

export function saveDefaultConfig(): void {
  const dir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULTS, null, 2) + '\n', { mode: 0o600 });
    console.error(`[mibot] Created config: ${CONFIG_PATH}`);
  }
}

/** Check if a participant name matches known bot patterns. */
export function isBot(name: string): boolean {
  const config = loadConfig();
  const lower = name.toLowerCase();
  return config.botPatterns.some(pattern => {
    try {
      return new RegExp(pattern, 'i').test(lower);
    } catch {
      return lower.includes(pattern.toLowerCase());
    }
  });
}

/** Format a date string in the user's configured timezone.
 *  Graph API returns datetimes without Z suffix but in UTC — normalize before display. */
export function fmtTime(dateStr: string): string {
  const config = loadConfig();
  // Append Z if no timezone indicator present (Graph API convention: bare datetimes are UTC)
  const normalized = /[Z+\-]\d{0,4}$/.test(dateStr) ? dateStr : dateStr.replace(/\.?\d*$/, 'Z');
  return new Date(normalized).toLocaleString('en-US', {
    timeZone: config.timezone,
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/** Check if a meeting title matches "never join" patterns. */
export function shouldSkipMeeting(title: string): boolean {
  const config = loadConfig();
  const lower = title.toLowerCase();
  return config.neverJoin.some(pattern => {
    try {
      return new RegExp(pattern, 'i').test(lower);
    } catch {
      return lower.includes(pattern.toLowerCase());
    }
  });
}
