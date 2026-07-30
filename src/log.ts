import fs from 'fs';
import path from 'path';
import os from 'os';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const LOG_DIR = path.join(os.homedir(), '.config', 'mibot', 'logs');

/**
 * Validate MIBOT_LOG_LEVEL against the known set, falling back to 'info' (C17).
 * The old `env as LogLevel || 'info'` cast any string through, so a typo like
 * `verbose` made `LEVEL_ORDER[lvl]` undefined and the `< undefined` filter test
 * always false → nothing was filtered and debug spam shipped.
 */
export function resolveLogLevel(raw: string | undefined): LogLevel {
  return raw && raw in LEVEL_ORDER ? (raw as LogLevel) : 'info';
}

/** Dated log filename — pure fn of the date so the writer can rotate at midnight (C17). */
export function logFileName(date: Date): string {
  return `mibot-${date.toISOString().slice(0, 10)}.jsonl`;
}

const level: LogLevel = resolveLogLevel(process.env.MIBOT_LOG_LEVEL);

let stream: fs.WriteStream | null = null;
let streamName: string | null = null;

function getStream(): fs.WriteStream {
  const name = logFileName(new Date());
  // Rotate when the day rolls over: a long `mibot start` must not keep writing to
  // yesterday's file (C17). Reopening on a name change closes the stale stream.
  if (stream && streamName !== name) {
    stream.end();
    stream = null;
  }
  if (!stream) {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
    stream = fs.createWriteStream(path.join(LOG_DIR, name), { flags: 'a' });
    streamName = name;
  }
  return stream;
}

function write(lvl: LogLevel, msg: string, data?: Record<string, unknown>): void {
  if (LEVEL_ORDER[lvl] < LEVEL_ORDER[level]) return;

  const entry = {
    ts: new Date().toISOString(),
    level: lvl,
    msg,
    ...(data || {}),
  };

  // Structured JSON to file
  getStream().write(JSON.stringify(entry) + '\n');

  // Human-readable to stderr
  const prefix = lvl === 'error' ? 'ERROR' : lvl === 'warn' ? 'WARN' : '';
  const line = prefix ? `[mibot] ${prefix}: ${msg}` : `[mibot] ${msg}`;
  console.error(line);
}

export const log = {
  debug: (msg: string, data?: Record<string, unknown>) => write('debug', msg, data),
  info: (msg: string, data?: Record<string, unknown>) => write('info', msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => write('warn', msg, data),
  error: (msg: string, data?: Record<string, unknown>) => write('error', msg, data),
  close: () => { if (stream) { stream.end(); stream = null; } },
};
