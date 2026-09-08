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

/** Windows zone names Graph emits → IANA. Covers the zones a real mailbox is likely to use;
 *  anything unlisted falls through to `undefined` and is handled as "unknown" by the caller
 *  rather than guessed at. */
const WINDOWS_TO_IANA: Record<string, string> = {
  'utc': 'UTC',
  'gmt standard time': 'Europe/London',
  'greenwich standard time': 'Atlantic/Reykjavik',
  'w. europe standard time': 'Europe/Berlin',
  'central europe standard time': 'Europe/Budapest',
  'central european standard time': 'Europe/Warsaw',
  'romance standard time': 'Europe/Paris',
  'w. central africa standard time': 'Africa/Lagos',
  'e. europe standard time': 'Europe/Chisinau',
  'fle standard time': 'Europe/Kiev',
  'gtb standard time': 'Europe/Bucharest',
  'israel standard time': 'Asia/Jerusalem',
  'russian standard time': 'Europe/Moscow',
  'arabian standard time': 'Asia/Dubai',
  'india standard time': 'Asia/Kolkata',
  'china standard time': 'Asia/Shanghai',
  'singapore standard time': 'Asia/Singapore',
  'tokyo standard time': 'Asia/Tokyo',
  'korea standard time': 'Asia/Seoul',
  'aus eastern standard time': 'Australia/Sydney',
  'aus central standard time': 'Australia/Darwin',
  'w. australia standard time': 'Australia/Perth',
  'new zealand standard time': 'Pacific/Auckland',
  'hawaiian standard time': 'Pacific/Honolulu',
  'alaskan standard time': 'America/Anchorage',
  'pacific standard time': 'America/Los_Angeles',
  'pacific standard time (mexico)': 'America/Tijuana',
  'mountain standard time': 'America/Denver',
  'us mountain standard time': 'America/Phoenix',
  'central standard time': 'America/Chicago',
  'canada central standard time': 'America/Regina',
  'central standard time (mexico)': 'America/Mexico_City',
  'eastern standard time': 'America/New_York',
  'us eastern standard time': 'America/Indiana/Indianapolis',
  'atlantic standard time': 'America/Halifax',
  'newfoundland standard time': 'America/St_Johns',
  'e. south america standard time': 'America/Sao_Paulo',
  'argentina standard time': 'America/Argentina/Buenos_Aires',
  'sa pacific standard time': 'America/Bogota',
  'sa western standard time': 'America/La_Paz',
  'south africa standard time': 'Africa/Johannesburg',
  'e. africa standard time': 'Africa/Nairobi',
  'egypt standard time': 'Africa/Cairo',
  'turkey standard time': 'Europe/Istanbul',
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
  if (!zone || zone === 'UTC') return asUtc.toISOString();

  return new Date(wallClockToUtcMs(asUtc.getTime(), zone)).toISOString();
}
