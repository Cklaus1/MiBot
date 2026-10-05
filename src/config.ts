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

export const DEFAULTS: MiBotConfig = {
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

/** Numeric fields and their valid [min, max] ranges (inclusive). Anything outside the
 *  range, non-numeric, or non-integer falls back to the default for that field. */
const NUMERIC_RANGES: Record<string, [number, number]> = {
  joinBeforeMinutes: [0, 60],
  pollMinutes: [1, 60],
  maxDurationHours: [1, 24],
  leaveGracePeriodSeconds: [5, 600],
  aloneTimeoutMinutes: [1, 240],
  minHumansToStay: [0, 100],
  minAttendees: [0, 100],
};

const ARRAY_FIELDS = ['botPatterns', 'neverJoin'] as const;
const BOOL_FIELDS = ['onlyOrganized'] as const;

/** True if `tz` is a valid IANA timezone accepted by Intl (D5). Probes via a throwaway
 *  formatter — the same call fmtTime makes — so validation matches actual use exactly. */
export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Pure config validation (R10): merge a partial (typically parsed from config.json)
 * over DEFAULTS, coercing/clamping every field. Never throws — each invalid field
 * independently falls back to its default, so a single bad key can't crash startup.
 */
export function validateConfig(input: Partial<MiBotConfig>): MiBotConfig {
  const out: MiBotConfig = { ...DEFAULTS };
  const raw = (input ?? {}) as Record<string, unknown>;

  // timezone: must be a valid IANA zone (D5) — an invalid one would crash fmtTime's
  // Intl.DateTimeFormat at use time, so reject it here and keep the default.
  if (typeof raw.timezone === 'string' && raw.timezone.trim() !== '' && isValidTimezone(raw.timezone)) {
    out.timezone = raw.timezone;
  }
  // botName: non-empty string only.
  if (typeof raw.botName === 'string' && raw.botName.trim() !== '') out.botName = raw.botName;

  // numeric fields: must be finite integers within range.
  for (const [field, [min, max]] of Object.entries(NUMERIC_RANGES)) {
    const v = raw[field];
    if (typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v >= min && v <= max) {
      (out as any)[field] = v;
    }
  }

  // array-of-strings fields: must be arrays; non-string entries are dropped.
  for (const field of ARRAY_FIELDS) {
    const v = raw[field];
    if (Array.isArray(v)) {
      (out as any)[field] = v.filter((x): x is string => typeof x === 'string');
    }
  }

  // boolean fields: must be real booleans (a truthy string must not become true).
  for (const field of BOOL_FIELDS) {
    const v = raw[field];
    if (typeof v === 'boolean') (out as any)[field] = v;
  }

  return out;
}

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

  // R10: validate/clamp file config (defends against a hand-edited config.json) before
  // env vars layer on top. validateConfig already merges over DEFAULTS field-by-field.
  const validated = validateConfig(fileConfig);

  // Env vars override file config (with validation)
  const env = process.env;
  const safeInt = (val: string | undefined, min = 0, max = 10000): number | undefined => {
    if (!val) return undefined;
    const n = parseInt(val, 10);
    return isNaN(n) || n < min || n > max ? undefined : n;
  };

  // Wave 9-F: the env zone gets the same check as the file's. Unvalidated, a bad value made
  // fmtTime throw — mid-sync, which cut every calendar sync short after one new meeting.
  let envTimezone: string | undefined;
  if (env.MIBOT_TIMEZONE) {
    if (isValidTimezone(env.MIBOT_TIMEZONE)) envTimezone = env.MIBOT_TIMEZONE;
    else console.error(`[mibot] WARN: MIBOT_TIMEZONE "${env.MIBOT_TIMEZONE}" is not a valid IANA zone — ignored (using ${validated.timezone})`);
  }

  _config = {
    ...validated,
    ...(envTimezone ? { timezone: envTimezone } : {}),
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

/** Does this timestamp already carry timezone information (Z, or a ±HH:MM / ±HHMM offset)? */
function hasTimezone(dateStr: string): boolean {
  return /(?:Z|[+-]\d{2}:?\d{2})$/.test(dateStr.trim());
}

/** Format a date string in the user's configured timezone (R12/D1/CA10).
 *  Handles every stored shape: Z-suffixed, ±HH:MM offset (Google), space-separated,
 *  date-only, and Graph's bare UTC datetimes. Display-boundary only — SQLite already
 *  parses the stored shapes for scheduling, so nothing here is persisted. */
export function fmtTime(dateStr: string): string {
  const config = loadConfig();
  const trimmed = (dateStr ?? '').trim();

  let normalized: string;
  if (hasTimezone(trimmed)) {
    // Already unambiguous (Z or explicit offset) — use as-is.
    normalized = trimmed;
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    // Date-only: treat as midnight UTC so it renders on the intended calendar day.
    normalized = `${trimmed}T00:00:00Z`;
  } else {
    // Bare datetime → UTC. CA9 now normalizes every ingested start/end to an explicit UTC
    // instant in calendar.ts (tz.ts `toUtcIso`), so this branch only sees rows written before
    // that fix — for which UTC was already the assumed convention everywhere else. Accept both
    // 'T' and space separators and strip fractional seconds.
    normalized = trimmed.replace(' ', 'T').replace(/\.\d+$/, '') + 'Z';
  }

  const d = new Date(normalized);
  if (isNaN(d.getTime())) return trimmed || '(no date)';

  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };
  try {
    return d.toLocaleString('en-US', { ...opts, timeZone: config.timezone });
  } catch {
    // A display helper must never throw: callers include the calendar sync loop.
    return d.toLocaleString('en-US', { ...opts, timeZone: 'UTC' }) + ' UTC';
  }
}

/** Check if a meeting title matches "never join" patterns. */
/**
 * Wave 9-E: people on the invite — attendees plus the organizer, deduplicated by email
 * (case-insensitive; by name when there's no email). Graph's attendee list EXCLUDES the
 * organizer while Google's includes them, so a raw attendee count would make
 * `minAttendees: 3` skip a 3-person Graph meeting.
 */
export function attendeeHeadcount(m: { attendees: string | null; organizer_email: string | null }): number {
  const people = new Set<string>();
  let list: unknown = [];
  try { list = m.attendees ? JSON.parse(m.attendees) : []; } catch { list = []; }
  if (Array.isArray(list)) {
    for (const a of list) {
      const key = (a?.email || a?.name || '').toString().trim().toLowerCase();
      if (key) people.add(key);
    }
  }
  if (m.organizer_email) people.add(m.organizer_email.trim().toLowerCase());
  return people.size;
}

/**
 * Why the watcher should NOT join this meeting, or null to join it. Wave 9-E: `onlyOrganized`
 * and `minAttendees` were validated and documented but never read, so every meeting was joined.
 * onlyOrganized is strict — an unknown organizer flag is skipped, because the setting says ONLY.
 */
export function meetingSkipReason(
  m: { title: string; attendees: string | null; organizer_email: string | null; is_organizer: number | null },
  config: Pick<MiBotConfig, 'neverJoin' | 'onlyOrganized' | 'minAttendees'> = loadConfig(),
): string | null {
  if (titleMatchesNeverJoin(m.title, config.neverJoin)) return 'title filter';
  if (config.onlyOrganized && m.is_organizer !== 1) {
    return m.is_organizer === 0 ? 'organized by someone else (onlyOrganized)' : 'organizer unknown (onlyOrganized)';
  }
  if (config.minAttendees > 0) {
    const n = attendeeHeadcount(m);
    if (n < config.minAttendees) return `${n} attendees < minAttendees ${config.minAttendees}`;
  }
  return null;
}

export function shouldSkipMeeting(title: string): boolean {
  return titleMatchesNeverJoin(title, loadConfig().neverJoin);
}

function titleMatchesNeverJoin(title: string, neverJoin: string[]): boolean {
  const lower = title.toLowerCase();
  return neverJoin.some(pattern => {
    try {
      return new RegExp(pattern, 'i').test(lower);
    } catch {
      return lower.includes(pattern.toLowerCase());
    }
  });
}
