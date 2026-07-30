import { describe, it, expect } from 'vitest';
import { resolveLogLevel, logFileName } from '../src/log.js';

// C17a: `const level = process.env.MIBOT_LOG_LEVEL as LogLevel || 'info'` cast any string to a
// LogLevel. A typo like MIBOT_LOG_LEVEL=verbose made LEVEL_ORDER[lvl] undefined, so the filter
// `order[msg] < undefined` was always false → nothing filtered → debug spam shipped to prod.
// resolveLogLevel validates against the known set and falls back to 'info'.
describe('resolveLogLevel (C17 invalid level)', () => {
  it('accepts each valid level', () => {
    for (const lvl of ['debug', 'info', 'warn', 'error'] as const) {
      expect(resolveLogLevel(lvl)).toBe(lvl);
    }
  });

  it('falls back to info on an unknown string', () => {
    expect(resolveLogLevel('verbose')).toBe('info');
    expect(resolveLogLevel('DEBUG')).toBe('info'); // case-sensitive by design
  });

  it('falls back to info on undefined / empty', () => {
    expect(resolveLogLevel(undefined)).toBe('info');
    expect(resolveLogLevel('')).toBe('info');
  });
});

// C17b: the dated filename was computed ONCE when the stream was first opened, so a long-running
// `mibot start` kept writing to yesterday's file after midnight. logFileName is a pure function
// of the date, so the writer can recompute it each write and rotate when the day rolls over.
describe('logFileName (C17 midnight rotation)', () => {
  it('derives the file from the date (YYYY-MM-DD)', () => {
    expect(logFileName(new Date('2026-07-29T23:59:00Z'))).toBe('mibot-2026-07-29.jsonl');
  });

  it('rolls to a new name once the day changes', () => {
    const before = logFileName(new Date('2026-07-29T23:59:59Z'));
    const after = logFileName(new Date('2026-07-30T00:00:01Z'));
    expect(before).not.toBe(after);
    expect(after).toBe('mibot-2026-07-30.jsonl');
  });
});
