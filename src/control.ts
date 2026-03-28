import type { Page, Frame } from 'playwright';
import net from 'net';
import fs from 'fs';
import path from 'path';
import os from 'os';

const SOCKET_DIR = path.join(os.homedir(), '.config', 'mibot', 'sockets');

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

  constructor(page: Page, meetingId: number) {
    this.page = page;
    if (!fs.existsSync(SOCKET_DIR)) {
      fs.mkdirSync(SOCKET_DIR, { recursive: true, mode: 0o700 });
    }
    this.socketPath = path.join(SOCKET_DIR, `bot-${meetingId}.sock`);

    // Clean up stale sockets — if socket file is older than the current process, it's stale
    try {
      const processStart = Date.now() - (process.uptime() * 1000);
      for (const file of fs.readdirSync(SOCKET_DIR)) {
        if (!file.endsWith('.sock')) continue;
        const sockPath = path.join(SOCKET_DIR, file);
        try {
          const stat = fs.statSync(sockPath);
          if (stat.mtimeMs < processStart) {
            fs.unlinkSync(sockPath);
          }
        } catch {}
      }
    } catch {}
  }

  /** Start listening for commands. */
  start(): void {
    // Clean up stale socket
    if (fs.existsSync(this.socketPath)) {
      fs.unlinkSync(this.socketPath);
    }

    this.server = net.createServer((conn) => {
      let data = '';
      conn.on('data', (chunk) => { data += chunk.toString(); });
      conn.on('end', async () => {
        try {
          const result = await this.handleCommand(data.trim());
          conn.write(JSON.stringify({ ok: true, result }) + '\n');
        } catch (err) {
          conn.write(JSON.stringify({ ok: false, error: (err as Error).message }) + '\n');
        }
        conn.end();
      });
    });

    this.server.listen(this.socketPath);
    console.error(`[mibot] Control channel: ${this.socketPath}`);

    // Register signal handlers to clean up socket on exit
    const cleanup = () => { this.stop(); };
    process.on('SIGTERM', cleanup);
    process.on('SIGINT', cleanup);
  }

  /** Stop listening. */
  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    if (fs.existsSync(this.socketPath)) {
      fs.unlinkSync(this.socketPath);
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
    client.on('data', (chunk) => { data += chunk.toString(); });
    client.on('end', () => resolve(data));
    client.on('error', (err) => reject(err));
  });
}
