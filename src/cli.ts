/**
 * Pure CLI-argument and parsing helpers, extracted from index.ts so they can be
 * unit-tested without executing the CLI's top-level `main()`.
 */

/**
 * Parse a JSON string that is expected to be an array, never throwing (C11).
 * `prioritizeMeetings` sorted on `JSON.parse(meeting.attendees)` for every
 * candidate inside the poll's try block, so a single malformed blob aborted the
 * whole poll iteration and the watcher joined nothing that cycle. Any parse
 * failure — or a valid-but-non-array value — yields an empty array.
 */
export function safeParseArray<T = unknown>(raw: string | null | undefined): T[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

export interface JoinArgs {
  url: string | undefined;
  title: string | undefined;
}

/**
 * Parse the argv tail of `mibot join` into { url, title } (C18). The old code
 * took the URL as args[1] and the title as args[indexOf('--title')+1], which
 * broke two ways: `--title` as the last token read undefined, and
 * `mibot join --title Foo <url>` treated the literal "--title" as the URL. Here
 * the flag (and its value) is removed first, wherever it sits, then the first
 * remaining token is the URL.
 */
export function parseJoinArgs(argv: string[]): JoinArgs {
  let title: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--title') {
      title = argv[i + 1]; // undefined if --title is the last token
      i++; // skip the consumed value
      continue;
    }
    rest.push(argv[i]);
  }
  return { url: rest[0], title };
}
