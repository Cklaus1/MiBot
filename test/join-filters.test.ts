import { describe, it, expect, afterAll, vi, beforeEach, afterEach } from 'vitest';
import { meetingSkipReason, attendeeHeadcount, DEFAULTS } from '../src/config.js';
import { m365ToRaw, googleToRaw, reconcileProvider, normalizeEvents } from '../src/calendar.js';
import { closeDb, getMeetingByEventId } from '../src/db.js';

// Wave 9-E: `onlyOrganized` and `minAttendees` were validated and documented ("Skips 1:1s if set
// to 3") but nothing read them — every meeting was joined regardless.
let spy: ReturnType<typeof vi.spyOn>;
beforeEach(() => { spy = vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => spy.mockRestore());
afterAll(() => closeDb());

const cfg = (o: Partial<typeof DEFAULTS> = {}) => ({ ...DEFAULTS, neverJoin: [], ...o });
const att = (...emails: string[]) => JSON.stringify(emails.map((e) => ({ name: e, email: e, status: 'accepted' })));
const mtg = (o: object = {}) => ({ title: 'Sync', attendees: att('a@x', 'b@x'), organizer_email: 'me@x', is_organizer: 1, ...o }) as any;

describe('attendeeHeadcount', () => {
  it('counts the organizer even when the provider leaves them out of attendees (Graph)', () =>
    expect(attendeeHeadcount(mtg({ attendees: att('a@x', 'b@x'), organizer_email: 'me@x' }))).toBe(3));
  it('does not double-count an organizer the provider lists as an attendee (Google)', () =>
    expect(attendeeHeadcount(mtg({ attendees: att('me@x', 'a@x', 'b@x'), organizer_email: 'me@x' }))).toBe(3));
  it('is case-insensitive on emails', () =>
    expect(attendeeHeadcount(mtg({ attendees: att('A@X'), organizer_email: 'a@x' }))).toBe(1));
  it('tolerates missing/garbage attendee JSON', () => {
    expect(attendeeHeadcount(mtg({ attendees: null, organizer_email: 'me@x' }))).toBe(1);
    expect(attendeeHeadcount(mtg({ attendees: 'nope', organizer_email: null }))).toBe(0);
  });
});

describe('meetingSkipReason', () => {
  it('defaults join everything', () => expect(meetingSkipReason(mtg(), cfg())).toBeNull());

  it('neverJoin still applies', () =>
    expect(meetingSkipReason(mtg({ title: 'Lunch' }), cfg({ neverJoin: ['lunch'] }))).toMatch(/title/));

  it('minAttendees: 3 skips a 1:1 from either provider', () => {
    expect(meetingSkipReason(mtg({ attendees: att('a@x') }), cfg({ minAttendees: 3 }))).toMatch(/attendees/);
    expect(meetingSkipReason(mtg({ attendees: att('me@x', 'a@x') }), cfg({ minAttendees: 3 }))).toMatch(/attendees/);
  });

  it('minAttendees: 3 joins a 3-person Graph meeting (organizer not in attendees)', () =>
    expect(meetingSkipReason(mtg({ attendees: att('a@x', 'b@x') }), cfg({ minAttendees: 3 }))).toBeNull());

  it('onlyOrganized skips meetings organized by someone else', () =>
    expect(meetingSkipReason(mtg({ is_organizer: 0 }), cfg({ onlyOrganized: true }))).toMatch(/organiz/));

  it('onlyOrganized also skips when organizer status is unknown (strict: the setting says ONLY)', () =>
    expect(meetingSkipReason(mtg({ is_organizer: null }), cfg({ onlyOrganized: true }))).toMatch(/organiz/));

  it('onlyOrganized joins my own meetings', () =>
    expect(meetingSkipReason(mtg({ is_organizer: 1 }), cfg({ onlyOrganized: true }))).toBeNull());
});

describe('organizer flag from the providers', () => {
  const graph = (isOrganizer: boolean) => ({
    id: `g-${isOrganizer}-${Date.now()}`, subject: 'S', isOrganizer,
    start: { dateTime: '2026-10-06T15:00:00.0000000', timeZone: 'UTC' },
    end: { dateTime: '2026-10-06T15:30:00.0000000', timeZone: 'UTC' },
    onlineMeeting: { joinUrl: `https://teams.microsoft.com/l/meetup-join/${isOrganizer}${Date.now()}` },
  });
  it('Graph isOrganizer → is_organizer', () => {
    expect(m365ToRaw(graph(true)).is_organizer).toBe(true);
    expect(m365ToRaw(graph(false)).is_organizer).toBe(false);
  });
  it('Google organizer.self → is_organizer', () => {
    expect(googleToRaw({ id: 'x', organizer: { email: 'me@x', self: true }, start: {}, end: {} }).is_organizer).toBe(true);
    expect(googleToRaw({ id: 'y', organizer: { email: 'o@x' }, start: {}, end: {} }).is_organizer).toBe(false);
  });

  it('is stored, and back-filled onto an existing row on its next sync', () => {
    const ev = graph(true);
    const raw = { ...m365ToRaw(ev), is_organizer: undefined }; // a row synced before this field existed
    reconcileProvider('m365:', normalizeEvents([raw]), '');
    const id = `m365:${ev.id}`;
    expect(getMeetingByEventId(id)!.is_organizer).toBeNull();
    reconcileProvider('m365:', normalizeEvents([m365ToRaw(ev)]), '');
    expect(getMeetingByEventId(id)!.is_organizer).toBe(1);
  });
});
