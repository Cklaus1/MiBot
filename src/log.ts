import fs from 'fs';
import path from 'path';
import os from 'os';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const LOG_DIR = path.join(os.homedir(), '.config', 'mibot', 'logs');
const level: LogLevel = (process.env.MIBOT_LOG_LEVEL as LogLevel) || 'info';

let stream: fs.WriteStream | null = null;

function getStream(): fs.WriteStream {
  if (!stream) {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
    const date = new Date().toISOString().slice(0, 10);
    stream = fs.createWriteStream(path.join(LOG_DIR, `mibot-${date}.jsonl`), { flags: 'a' });
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
