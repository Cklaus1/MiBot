import { describe, it, expect } from 'vitest';
import { safeParseArray, parseJoinArgs } from '../src/cli.js';

// C11: prioritizeMeetings did an unguarded JSON.parse(meeting.attendees) for every candidate.
// One malformed blob (a truncated write, a hand-edited row) threw, and since the sort ran inside
// the poll's try, the whole poll iteration aborted — the watcher joined NOTHING that cycle, and
// every cycle after, as long as the bad row stayed in the window. safeParseArray isolates it.
describe('safeParseArray (C11 poll-abort guard)', () => {
  it('parses a valid JSON array', () => {
    expect(safeParseArray('[{"name":"A"},{"name":"B"}]')).toHaveLength(2);
  });

  it('returns [] for malformed JSON instead of throwing', () => {
    expect(safeParseArray('{ truncated')).toEqual([]);
  });

  it('returns [] for null / undefined / empty', () => {
    expect(safeParseArray(null)).toEqual([]);
    expect(safeParseArray(undefined)).toEqual([]);
    expect(safeParseArray('')).toEqual([]);
  });

  it('returns [] when the JSON is valid but not an array (object, number)', () => {
    expect(safeParseArray('{"name":"A"}')).toEqual([]);
    expect(safeParseArray('42')).toEqual([]);
  });
});

// C18: `mibot join` took the URL as args[1] and the title as args[indexOf('--title')+1]. Two
// bugs: `--title` as the LAST token yields undefined; and `mibot join --title Foo <url>` treated
// the literal "--title" as the URL (args[1]) and never found the real URL. parseJoinArgs pulls
// the flag out first, whatever its position, then takes the first non-flag token as the URL.
describe('parseJoinArgs (C18 flag/url parsing)', () => {
  it('parses url then --title', () => {
    expect(parseJoinArgs(['https://z.us/1', '--title', 'Standup']))
      .toEqual({ url: 'https://z.us/1', title: 'Standup' });
  });

  it('parses --title before the url (flag-first order)', () => {
    expect(parseJoinArgs(['--title', 'Standup', 'https://z.us/1']))
      .toEqual({ url: 'https://z.us/1', title: 'Standup' });
  });

  it('url with no title', () => {
    expect(parseJoinArgs(['https://z.us/1'])).toEqual({ url: 'https://z.us/1', title: undefined });
  });

  it('--title as the last token yields undefined title, not a swallowed url', () => {
    expect(parseJoinArgs(['https://z.us/1', '--title']))
      .toEqual({ url: 'https://z.us/1', title: undefined });
  });

  it('no url at all', () => {
    expect(parseJoinArgs(['--title', 'X'])).toEqual({ url: undefined, title: 'X' });
  });

  it('supports a multi-word title (quoted in the shell → one token)', () => {
    expect(parseJoinArgs(['https://z.us/1', '--title', 'Weekly Sync']))
      .toEqual({ url: 'https://z.us/1', title: 'Weekly Sync' });
  });
});
