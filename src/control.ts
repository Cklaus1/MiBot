import type { Page, Frame } from 'playwright';
import net from 'net';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { registerShutdownHook } from './shutdown.js';

const SOCKET_DIR = path.join(os.homedir(), '.config', 'mibot', 'sockets');
const CONTROL_TIMEOUT_MS = 30000;

/**
 * Parse a control-channel response (C9). The server serializes both success and
 * failure on the same normal stream as `{ok:true,result}` / `{ok:false,error}`,
 * so the CLI must inspect `ok` — treating any bytes as success made a failed
 * command print raw JSON and exit 0. ok:false throws the server error; malformed
 * JSON throws too.
 */
export function parseControlResponse(raw: string): unknown {
  const parsed = JSON.parse(raw.trim()) as { ok?: boolean; result?: unknown; error?: unknown };
  if (parsed && parsed.ok === false) {
    throw new Error(typeof parsed.error === 'string' ? parsed.error : 'control command failed');
  }
  return parsed.result;
}

/**
 * Probe whether a Unix socket has a live listener (C8). A stale `.sock` left by a
 * crashed bot refuses the connection (ECONNREFUSED); a running bot accepts it.
 * mtime is not liveness — an old-but-alive bot's socket looks "stale" by age.
 */
export function isSocketAlive(
  sockPath: string,
  connect: (p: string) => NodeJS.EventEmitter & { destroy: () => void } = (p) => net.createConnection(p) as any,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (alive: boolean) => { if (!settled) { settled = true; resolve(alive); } };
    const sock = connect(sockPath);
    sock.on('connect', () => { sock.destroy(); done(true); });
    sock.on('error', () => { sock.destroy(); done(false); });
  });
}

interface SweepDeps {
  readdir: (dir: string) => string[];
  isAlive: (sockPath: string) => Promise<boolean>;
  unlink: (sockPath: string) => void;
}

/**
 * Remove only DEAD bot sockets (C8), leaving live bots' sockets and the caller's
 * own socket untouched. Best effort: a readdir/unlink failure is swallowed so a
 * housekeeping hiccup never blocks startup.
 */
export async function sweepStaleSockets(dir: string, ownSock: string, deps: SweepDeps): Promise<void> {
  let files: string[];
  try {
    files = deps.readdir(dir);
  } catch {
    return; // dir missing / unreadable — nothing to sweep
  }
  for (const file of files) {
    if (!file.endsWith('.sock') || file === ownSock) continue;
    const sockPath = path.join(dir, file);
    try {
      if (!(await deps.isAlive(sockPath))) deps.unlink(sockPath);
    } catch {
      // leave it — better a stale socket than a thrown sweep
    }
  }
}

/**
 * Live control channel for a running bot.
 * Listens on a Unix socket and accepts commands to interact with the browser.
 *
 * Usage from CLI:
 *   mibot send <meetingId> screenshot
 *   mibot send <meetingId> click "Join"
 *   mibot send <meetingId> type "MiBot"
 *   mibot send <meetingId> press Escape
 *   mibot send <meetingId> frames
 *   mibot send <meetingId> text
 */
export class ControlChannel {
  private server: net.Server | null = null;
  private page: Page;
  private socketPath: string;
  private ownSockName: string;
  private disposeHook: (() => void) | null = null;

  constructor(page: Page, meetingId: number) {
    this.page = page;
    if (!fs.existsSync(SOCKET_DIR)) {
      fs.mkdirSync(SOCKET_DIR, { recursive: true, mode: 0o700 });
    }
    this.socketPath = path.join(SOCKET_DIR, `bot-${meetingId}.sock`);
    this.ownSockName = `bot-${meetingId}.sock`;

    // Sweep dead sockets by liveness probe, not mtime (C8): an old-but-running
    // bot's socket is alive, and must not be unlinked out from under it.
    void sweepStaleSockets(SOCKET_DIR, this.ownSockName, {
      readdir: (dir) => fs.readdirSync(dir),
      isAlive: (p) => isSocketAlive(p),
      unlink: (p) => fs.unlinkSync(p),
    });
  }

  /** Start listening for commands. */
  start(): void {
    // Clean up stale socket
    if (fs.existsSync(this.socketPath)) {
      fs.unlinkSync(this.socketPath);
    }

    this.server = net.createServer((conn) => {
      let data = '';
      // C2: a client that disconnects mid-response emits EPIPE on the socket; without
      // this handler it surfaces as an uncaught exception and crashes the bot mid-meeting.
      conn.on('error', () => { /* client vanished — nothing to do */ });
      conn.on('data', (chunk) => { data += chunk.toString(); });
      conn.on('end', async () => {
        let payload: string;
        try {
          const result = await this.handleCommand(data.trim());
          payload = JSON.stringify({ ok: true, result }) + '\n';
        } catch (err) {
          payload = JSON.stringify({ ok: false, error: (err as Error).message }) + '\n';
        }
        // Guard the write: the peer may already be gone (C2).
        if (!conn.destroyed) { try { conn.write(payload); } catch { /* peer gone */ } }
        conn.end();
      });
    });

    // C2: EADDRINUSE / permission errors on listen() must not be an uncaught crash.
    this.server.on('error', (err) => {
      console.error(`[mibot] Control channel error: ${err.message}`);
    });

    this.server.listen(this.socketPath);
    console.error(`[mibot] Control channel: ${this.socketPath}`);

    // Socket teardown is owned by the single graceful-shutdown path (C1), not by
    // per-ControlChannel SIGINT/SIGTERM handlers (which never exited and leaked
    // listeners). The hook is disposed in stop() so it doesn't accumulate per meeting.
    this.disposeHook = registerShutdownHook(`control-${this.ownSockName}`, () => this.stop());
  }

  /** Stop listening. */
  stop(): void {
    if (this.disposeHook) { this.disposeHook(); this.disposeHook = null; }
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    if (fs.existsSync(this.socketPath)) {
      try { fs.unlinkSync(this.socketPath); } catch { /* already gone */ }
    }
  }

  /** Handle a single command string. */
  private async handleCommand(cmd: string): Promise<unknown> {
    const parts = cmd.split(' ');
    const action = parts[0];
    const arg = parts.slice(1).join(' ').replace(/^["']|["']$/g, '');

    switch (action) {
      case 'screenshot': {
        const p = arg || `/tmp/mibot-control-${Date.now()}.png`;
        await this.page.screenshot({ path: p });
        return { path: p };
      }

      case 'click': {
        // Try all frames
        for (const frame of this.getAllFrames()) {
          const loc = frame.locator(`text=${arg}`).first();
          if (await loc.isVisible({ timeout: 3000 }).catch(() => false)) {
            await loc.click();
            return { clicked: arg, frame: frame.url().substring(0, 60) };
          }
        }
        throw new Error(`"${arg}" not found in any frame`);
      }

      case 'fill': {
        // fill <selector> <value> or fill <value> (fills focused)
        const [sel, ...rest] = arg.split(' ');
        const value = rest.join(' ') || sel;
        if (rest.length > 0) {
          for (const frame of this.getAllFrames()) {
            const loc = frame.locator(sel).first();
            if (await loc.isVisible({ timeout: 3000 }).catch(() => false)) {
              await loc.fill(value);
              return { filled: sel, value };
            }
          }
        }
        await this.page.keyboard.type(value);
        return { typed: value };
      }

      case 'type': {
        await this.page.keyboard.type(arg);
        return { typed: arg };
      }

      case 'press': {
        await this.page.keyboard.press(arg || 'Enter');
        return { pressed: arg };
      }

      case 'text': {
        // Get visible text from all frames
        const texts: Record<string, string> = {};
        for (const frame of this.getAllFrames()) {
          const text = await frame.evaluate(() => document.body.innerText.substring(0, 2000)).catch(() => '');
          if (text) texts[frame.url().substring(0, 60)] = text;
        }
        return texts;
      }

      case 'frames': {
        return this.page.frames().map(f => ({
          url: f.url().substring(0, 100),
          name: f.name(),
        }));
      }

      case 'url': {
        return this.page.url();
      }

      case 'html': {
        const html = await this.page.content();
        return html.substring(0, 5000);
      }

      default:
        throw new Error(`Unknown command: ${action}. Available: screenshot, click, fill, type, press, text, frames, url, html`);
    }
  }

  private getAllFrames(): (Page | Frame)[] {
    return [this.page, ...this.page.frames().filter(f => f !== this.page.mainFrame())];
  }
}

/** Send a command to a running bot's control channel. */
export function sendCommand(meetingId: number, command: string): Promise<string> {
  const socketPath = path.join(SOCKET_DIR, `bot-${meetingId}.sock`);
  if (!fs.existsSync(socketPath)) {
    throw new Error(`No running bot for meeting ${meetingId}. Socket not found.`);
  }

  return new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath, () => {
      client.write(command);
      client.end();
    });

    let data = '';
    // C10: a wedged page would leave the server response pending forever, hanging
    // `mibot send` with no way out. Bound the wait and fail loudly instead.
    client.setTimeout(CONTROL_TIMEOUT_MS, () => {
      client.destroy();
      reject(new Error(`Control command timed out after ${CONTROL_TIMEOUT_MS}ms (bot may be wedged)`));
    });
    client.on('data', (chunk) => { data += chunk.toString(); });
    client.on('end', () => resolve(data));
    client.on('error', (err) => reject(err));
  });
}
