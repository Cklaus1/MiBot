/**
 * CA9 — timezone normalization for calendar ingest.
 *
 * Microsoft Graph returns a start/end as TWO fields:
 *   { dateTime: "2026-01-15T09:00:00.0000000", timeZone: "Pacific Standard Time" }
 * The `dateTime` is a BARE wall-clock string — no `Z`, no offset — expressed in the zone
 * named by the sibling field. Graph only returns UTC when the caller sends a
 * `Prefer: outlook.timezone="UTC"` header, which MiBot's ms365 invocation does not.
 *
 * The old code stored the bare string and dropped the zone, while `fmtTime` appended `Z` and
 * every SQL comparison used `datetime('now')` (UTC). For a PST mailbox that made every meeting
 * look 8 hours early: outside the join window, then swept to `missed` — silently never joined.
 *
 * The fix is to resolve the pair to a real UTC instant AT INGEST, so exactly one convention
 * ("start_time is UTC") holds across storage, scheduling, and display.
 *
 * No dependency: the zone offset is measured with Intl at the instant in question, which is
 * what makes DST correct (the same zone is UTC-8 in January and UTC-7 in July).
 */

/**
 * Windows zone names Graph emits → IANA: every CLDR windowsZones.xml mapping for territory
 * "001" (the canonical zone for each Windows name), keys lowercased. Generated, not hand-picked:
 * the first version covered 44 "likely" zones, and every mailbox in an unlisted one (Brisbane,
 * Bangkok, Adelaide, Riyadh, Karachi, Tehran, Santiago, ...) silently fell back to UTC and got
 * the exact CA9 bug back. CLDR keeps some legacy aliases (Asia/Calcutta, America/Buenos_Aires);
 * ICU resolves them identically. Overrides: 'utc' → 'UTC' (resolveZone short-circuits on that
 * exact string) and Graph's 'tzone://Microsoft/Utc'.
 *
 * Regenerate from https://github.com/unicode-org/cldr/blob/main/common/supplemental/windowsZones.xml
 */
const WINDOWS_TO_IANA: Record<string, string> = {
  'dateline standard time': 'Etc/GMT+12',
  'utc-11': 'Etc/GMT+11',
  'aleutian standard time': 'America/Adak',
  'hawaiian standard time': 'Pacific/Honolulu',
  'marquesas standard time': 'Pacific/Marquesas',
  'alaskan standard time': 'America/Anchorage',
  'utc-09': 'Etc/GMT+9',
  'pacific standard time (mexico)': 'America/Tijuana',
  'utc-08': 'Etc/GMT+8',
  'pacific standard time': 'America/Los_Angeles',
  'us mountain standard time': 'America/Phoenix',
  'mountain standard time (mexico)': 'America/Mazatlan',
  'mountain standard time': 'America/Denver',
  'yukon standard time': 'America/Whitehorse',
  'central america standard time': 'America/Guatemala',
  'central standard time': 'America/Chicago',
  'easter island standard time': 'Pacific/Easter',
  'central standard time (mexico)': 'America/Mexico_City',
  'canada central standard time': 'America/Regina',
  'sa pacific standard time': 'America/Bogota',
  'eastern standard time (mexico)': 'America/Cancun',
  'eastern standard time': 'America/New_York',
  'haiti standard time': 'America/Port-au-Prince',
  'cuba standard time': 'America/Havana',
  'us eastern standard time': 'America/Indianapolis',
  'turks and caicos standard time': 'America/Grand_Turk',
  'paraguay standard time': 'America/Asuncion',
  'atlantic standard time': 'America/Halifax',
  'venezuela standard time': 'America/Caracas',
  'central brazilian standard time': 'America/Cuiaba',
  'sa western standard time': 'America/La_Paz',
  'pacific sa standard time': 'America/Santiago',
  'newfoundland standard time': 'America/St_Johns',
  'tocantins standard time': 'America/Araguaina',
  'e. south america standard time': 'America/Sao_Paulo',
  'sa eastern standard time': 'America/Cayenne',
  'argentina standard time': 'America/Buenos_Aires',
  'greenland standard time': 'America/Godthab',
  'montevideo standard time': 'America/Montevideo',
  'magallanes standard time': 'America/Punta_Arenas',
  'saint pierre standard time': 'America/Miquelon',
  'bahia standard time': 'America/Bahia',
  'utc-02': 'Etc/GMT+2',
  'azores standard time': 'Atlantic/Azores',
  'cape verde standard time': 'Atlantic/Cape_Verde',
  'utc': 'UTC',
  'gmt standard time': 'Europe/London',
  'greenwich standard time': 'Atlantic/Reykjavik',
  'sao tome standard time': 'Africa/Sao_Tome',
  'morocco standard time': 'Africa/Casablanca',
  'w. europe standard time': 'Europe/Berlin',
  'central europe standard time': 'Europe/Budapest',
  'romance standard time': 'Europe/Paris',
  'central european standard time': 'Europe/Warsaw',
  'w. central africa standard time': 'Africa/Lagos',
  'jordan standard time': 'Asia/Amman',
  'gtb standard time': 'Europe/Bucharest',
  'middle east standard time': 'Asia/Beirut',
  'egypt standard time': 'Africa/Cairo',
  'e. europe standard time': 'Europe/Chisinau',
  'syria standard time': 'Asia/Damascus',
  'west bank standard time': 'Asia/Hebron',
  'south africa standard time': 'Africa/Johannesburg',
  'fle standard time': 'Europe/Kiev',
  'israel standard time': 'Asia/Jerusalem',
  'south sudan standard time': 'Africa/Juba',
  'kaliningrad standard time': 'Europe/Kaliningrad',
  'sudan standard time': 'Africa/Khartoum',
  'libya standard time': 'Africa/Tripoli',
  'namibia standard time': 'Africa/Windhoek',
  'arabic standard time': 'Asia/Baghdad',
  'turkey standard time': 'Europe/Istanbul',
  'arab standard time': 'Asia/Riyadh',
  'belarus standard time': 'Europe/Minsk',
  'russian standard time': 'Europe/Moscow',
  'e. africa standard time': 'Africa/Nairobi',
  'iran standard time': 'Asia/Tehran',
  'arabian standard time': 'Asia/Dubai',
  'astrakhan standard time': 'Europe/Astrakhan',
  'azerbaijan standard time': 'Asia/Baku',
  'russia time zone 3': 'Europe/Samara',
  'mauritius standard time': 'Indian/Mauritius',
  'saratov standard time': 'Europe/Saratov',
  'georgian standard time': 'Asia/Tbilisi',
  'volgograd standard time': 'Europe/Volgograd',
  'caucasus standard time': 'Asia/Yerevan',
  'afghanistan standard time': 'Asia/Kabul',
  'west asia standard time': 'Asia/Tashkent',
  'ekaterinburg standard time': 'Asia/Yekaterinburg',
  'pakistan standard time': 'Asia/Karachi',
  'qyzylorda standard time': 'Asia/Qyzylorda',
  'india standard time': 'Asia/Calcutta',
  'sri lanka standard time': 'Asia/Colombo',
  'nepal standard time': 'Asia/Katmandu',
  'central asia standard time': 'Asia/Bishkek',
  'bangladesh standard time': 'Asia/Dhaka',
  'omsk standard time': 'Asia/Omsk',
  'myanmar standard time': 'Asia/Rangoon',
  'se asia standard time': 'Asia/Bangkok',
  'altai standard time': 'Asia/Barnaul',
  'w. mongolia standard time': 'Asia/Hovd',
  'north asia standard time': 'Asia/Krasnoyarsk',
  'n. central asia standard time': 'Asia/Novosibirsk',
  'tomsk standard time': 'Asia/Tomsk',
  'china standard time': 'Asia/Shanghai',
  'north asia east standard time': 'Asia/Irkutsk',
  'singapore standard time': 'Asia/Singapore',
  'w. australia standard time': 'Australia/Perth',
  'taipei standard time': 'Asia/Taipei',
  'ulaanbaatar standard time': 'Asia/Ulaanbaatar',
  'aus central w. standard time': 'Australia/Eucla',
  'transbaikal standard time': 'Asia/Chita',
  'tokyo standard time': 'Asia/Tokyo',
  'north korea standard time': 'Asia/Pyongyang',
  'korea standard time': 'Asia/Seoul',
  'yakutsk standard time': 'Asia/Yakutsk',
  'cen. australia standard time': 'Australia/Adelaide',
  'aus central standard time': 'Australia/Darwin',
  'e. australia standard time': 'Australia/Brisbane',
  'aus eastern standard time': 'Australia/Sydney',
  'west pacific standard time': 'Pacific/Port_Moresby',
  'tasmania standard time': 'Australia/Hobart',
  'vladivostok standard time': 'Asia/Vladivostok',
  'lord howe standard time': 'Australia/Lord_Howe',
  'bougainville standard time': 'Pacific/Bougainville',
  'russia time zone 10': 'Asia/Srednekolymsk',
  'magadan standard time': 'Asia/Magadan',
  'norfolk standard time': 'Pacific/Norfolk',
  'sakhalin standard time': 'Asia/Sakhalin',
  'central pacific standard time': 'Pacific/Guadalcanal',
  'russia time zone 11': 'Asia/Kamchatka',
  'new zealand standard time': 'Pacific/Auckland',
  'utc+12': 'Etc/GMT-12',
  'fiji standard time': 'Pacific/Fiji',
  'chatham islands standard time': 'Pacific/Chatham',
  'utc+13': 'Etc/GMT-13',
  'tonga standard time': 'Pacific/Tongatapu',
  'samoa standard time': 'Pacific/Apia',
  'line islands standard time': 'Pacific/Kiritimati',
  'tzone://microsoft/utc': 'UTC',
};

/** Translate a Windows/Graph zone name to IANA. Returns undefined if it isn't one we know. */
export function windowsToIana(name: string): string | undefined {
  return WINDOWS_TO_IANA[name.trim().toLowerCase()];
}

/** True if `s` already pins an instant (trailing Z, or a ±HH:MM / ±HHMM offset). */
export function hasExplicitOffset(s: string): boolean {
  return /(?:Z|[+-]\d{2}:?\d{2})$/.test(s.trim());
}

/** Is this a zone Intl will accept? */
function isIana(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a Graph `timeZone` value to an IANA zone: pass IANA through, translate the Windows
 * names, and return undefined for anything unrecognized. Never guesses — an unknown zone is
 * reported as unknown so the caller can fall back explicitly and log it.
 */
export function resolveZone(tz: string | undefined): string | undefined {
  if (!tz || !tz.trim()) return undefined;
  const trimmed = tz.trim();
  if (isIana(trimmed) && trimmed.includes('/')) return trimmed;
  const mapped = windowsToIana(trimmed);
  if (mapped) return mapped;
  // A bare IANA-ish name with no slash (e.g. "UTC") is still valid to Intl.
  return isIana(trimmed) ? trimmed : undefined;
}

const warnedZones = new Set<string>();

/**
 * A named zone we can't resolve means every time from that mailbox is being read as UTC — hours
 * off, and swept to 'missed' without a trace. That must be visible. Once per zone name, since
 * the calendar sync runs every poll. (Graph's 'tzone://Microsoft/Custom' lands here: a custom
 * zone has no IANA equivalent.)
 */
function warnUnknownZone(tz: string): void {
  if (warnedZones.has(tz)) return;
  warnedZones.add(tz);
  console.error(`[mibot] WARN: unknown calendar timezone "${tz}" — treating its times as UTC; meetings from this calendar may be scheduled at the wrong time`);
}

/** Test hook: forget which unknown zones were already reported. */
export function __resetZoneWarningsForTest(): void {
  warnedZones.clear();
}

/** The offset, in minutes, that `zone` was at the given UTC instant (east of UTC is positive). */
function zoneOffsetMinutes(utcMs: number, zone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(new Date(utcMs))) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }
  // Intl renders midnight as hour 24 in some ICU versions; normalize it.
  const hour = parts.hour === '24' ? 0 : Number(parts.hour);
  const asUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    hour, Number(parts.minute), Number(parts.second),
  );
  return (asUtc - utcMs) / 60000;
}

/**
 * Convert a wall-clock datetime expressed in `zone` to the UTC instant it denotes.
 *
 * Two passes: guess the instant by reading the wall clock as if it were UTC, measure the zone's
 * offset there, correct, then re-measure at the corrected instant. The second pass is what makes
 * a time near a DST boundary land correctly — the offset before and after the transition differ,
 * and the first guess can sit on the wrong side of it.
 */
function wallClockToUtcMs(wallMs: number, zone: string): number {
  let utcMs = wallMs - zoneOffsetMinutes(wallMs, zone) * 60000;
  utcMs = wallMs - zoneOffsetMinutes(utcMs, zone) * 60000;
  return utcMs;
}

/**
 * CA9's single entry point: resolve a calendar `{dateTime, timeZone}` pair to a UTC ISO string.
 *
 *  - already offset-bearing (Google's shape) → normalized to UTC, zone field ignored
 *  - bare + known zone                       → interpreted in that zone (DST-correct)
 *  - bare + no/unknown zone                  → treated as UTC (the prior behaviour, preserved
 *                                              so a mailbox that really does return UTC is
 *                                              unaffected)
 *  - unparseable                             → undefined (the normalizer drops the event rather
 *                                              than scheduling a fabricated time — CA8's rule)
 */
export function toUtcIso(dateTime: string | undefined, timeZone?: string): string | undefined {
  if (!dateTime || !dateTime.trim()) return undefined;
  const raw = dateTime.trim();

  if (hasExplicitOffset(raw)) {
    const d = new Date(raw);
    return isNaN(d.getTime()) ? undefined : d.toISOString();
  }

  // Bare wall clock. Accept 'T' or space separators and Graph's 7-digit fractional seconds.
  const normalized = raw.replace(' ', 'T').replace(/\.\d+$/, '');
  const asUtc = new Date(`${normalized}Z`);
  if (isNaN(asUtc.getTime())) return undefined;

  const zone = resolveZone(timeZone);
  if (!zone && timeZone && timeZone.trim()) warnUnknownZone(timeZone.trim());
  if (!zone || zone === 'UTC') return asUtc.toISOString();

  return new Date(wallClockToUtcMs(asUtc.getTime(), zone)).toISOString();
}
