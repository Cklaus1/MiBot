import type { Page, Frame, Locator } from 'playwright';

const CAMOFOX_URL = process.env.CAMOFOX_URL || 'http://localhost:9377';
const USER_ID = 'mibot';
const SESSION_KEY = 'meet';

interface CamofoxTab {
  tabId: string;
}

/** Thin wrapper around camofox REST API that exposes a Playwright-like Page interface.
 *  Only implements methods used by the playbook engine + meeting detection. */
export class CamofoxPage {
  private tabId: string | null = null;

  async createTab(url: string, initScript?: string): Promise<void> {
    const res = await fetch(`${CAMOFOX_URL}/tabs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER_ID, sessionKey: SESSION_KEY, url, ...(initScript ? { initScript } : {}) }),
    });
    const data = await res.json() as CamofoxTab;
    this.tabId = data.tabId;
    console.error(`[mibot] Camofox tab: ${this.tabId}`);
  }

  private async api(path: string, body?: Record<string, unknown>): Promise<any> {
    if (!this.tabId) throw new Error('No camofox tab created');
    const url = `${CAMOFOX_URL}/tabs/${this.tabId}${path}?userId=${USER_ID}`;
    if (body) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: USER_ID, ...body }),
      });
      return res.json();
    }
    const res = await fetch(url);
    return res.json();
  }

  /** Get accessibility snapshot with element refs. */
  async snapshot(): Promise<{ snapshot: string; refsCount: number }> {
    return this.api('/snapshot');
  }

  /** Click an element by ref (e.g. "e1"). */
  async clickRef(ref: string): Promise<void> {
    await this.api('/click', { ref });
  }

  /** Type text into an element by ref. */
  async typeRef(ref: string, text: string): Promise<void> {
    await this.api('/type', { ref, text });
  }

  /** Take a screenshot. */
  async screenshot(opts?: { path?: string }): Promise<Buffer> {
    if (!this.tabId) throw new Error('No tab');
    const res = await fetch(`${CAMOFOX_URL}/tabs/${this.tabId}/screenshot?userId=${USER_ID}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (opts?.path) {
      const fs = await import('fs');
      fs.writeFileSync(opts.path, buf);
    }
    return buf;
  }

  /** Navigate to a URL. */
  async goto(url: string): Promise<void> {
    await this.api('/navigate', { url });
  }

  /** Wait for a specified time. */
  async waitForTimeout(ms: number): Promise<void> {
    await new Promise(r => setTimeout(r, ms));
  }

  /** Close the tab. */
  async close(): Promise<void> {
    if (!this.tabId) return;
    try {
      await fetch(`${CAMOFOX_URL}/tabs/${this.tabId}?userId=${USER_ID}`, { method: 'DELETE' });
    } catch {}
    this.tabId = null;
  }

  /** Find a ref by text in the snapshot. Returns the ref string or null. */
  async findRef(text: string): Promise<string | null> {
    const { snapshot } = await this.snapshot();
    // Parse snapshot for refs matching text
    // Format: button "Join now" [e10]  or  textbox "Your name" [e7]
    const lines = snapshot.split('\n');
    for (const line of lines) {
      if (line.toLowerCase().includes(text.toLowerCase())) {
        const refMatch = line.match(/\[e(\d+)\]/);
        if (refMatch) return `e${refMatch[1]}`;
      }
    }
    return null;
  }

  /** Click an element by visible text. Searches the snapshot for a matching ref. */
  async clickText(text: string, opts?: { timeout?: number }): Promise<boolean> {
    const timeout = opts?.timeout || 10000;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const ref = await this.findRef(text);
      if (ref) {
        await this.clickRef(ref);
        return true;
      }
      await this.waitForTimeout(1000);
    }
    return false;
  }

  /** Fill a text field by visible label. */
  async fillByLabel(label: string, value: string): Promise<boolean> {
    const ref = await this.findRef(label);
    if (ref) {
      await this.typeRef(ref, value);
      return true;
    }
    return false;
  }

  /** Check if text is visible in the snapshot. */
  async isTextVisible(text: string): Promise<boolean> {
    const { snapshot } = await this.snapshot();
    return snapshot.toLowerCase().includes(text.toLowerCase());
  }

  /** Run JavaScript in the page via camofox /eval endpoint. */
  async eval(expression: string): Promise<unknown> {
    if (!this.tabId) throw new Error('No tab');
    const res = await fetch(`${CAMOFOX_URL}/tabs/${this.tabId}/eval`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER_ID, expression }),
    });
    const data = await res.json() as { ok: boolean; result: unknown };
    return data.result;
  }

  /** Install a MutationObserver that captures all meeting signals (chat, reactions, hand raises). */
  async installSignalObserver(): Promise<void> {
    await this.eval(`
      if (!window.__mibotSignals) {
        window.__mibotSignals = [];
        window.__mibotSeenSignals = new Set();

        new MutationObserver((mutations) => {
          for (const m of mutations) {
            for (const node of m.addedNodes) {
              if (!node.textContent) continue;
              const text = node.textContent.trim();
              if (text.length === 0 || text.length > 300) continue;

              // Match meeting signals
              const patterns = [
                /(.+?) says in chat: (.+)/,
                /(.+?) sent a (.+) reaction/,
                /(.+?) raised a hand/,
                /(.+?) raised their hand/,
                /(.+?) lowered a hand/,
                /(.+?) lowered their hand/,
                /(.+?) is presenting/,
                /(.+?) stopped presenting/,
                /(.+?) joined/,
                /(.+?) left/,
              ];

              for (const pattern of patterns) {
                const match = text.match(pattern);
                if (match) {
                  const key = text + ':' + Math.floor(Date.now() / 3000); // dedup within 3s
                  if (!window.__mibotSeenSignals.has(key)) {
                    window.__mibotSeenSignals.add(key);
                    window.__mibotSignals.push({
                      raw: text,
                      type: pattern.source.includes('chat') ? 'chat'
                        : pattern.source.includes('reaction') ? 'reaction'
                        : pattern.source.includes('hand') ? 'hand'
                        : pattern.source.includes('presenting') ? 'screenshare'
                        : 'participant',
                      who: match[1],
                      detail: match[2] || '',
                      time: new Date().toISOString(),
                    });
                  }
                  break;
                }
              }
            }
          }
        }).observe(document.body, { childList: true, subtree: true });

        console.log('[mibot] Signal observer installed');
      }
    `);
    console.error('[mibot] Camofox signal observer installed');
  }

  /** Read and flush captured signals. */
  async drainSignals(): Promise<Array<{ raw: string; type: string; who: string; detail: string; time: string }>> {
    const result = await this.eval('(() => { const s = window.__mibotSignals || []; window.__mibotSignals = []; return s; })()');
    return (result as any[]) || [];
  }
}

/** Launch a camofox browser and navigate to the meeting URL. */
export async function launchCamofox(url: string): Promise<CamofoxPage> {
  // Verify camofox is running
  try {
    const res = await fetch(`${CAMOFOX_URL}/`);
    const data = await res.json() as { ok: boolean };
    if (!data.ok) throw new Error('Camofox not ready');
  } catch {
    throw new Error(`Camofox not running at ${CAMOFOX_URL}. Start it with: cd /root/projects/camofox-browser && npm start`);
  }

  // Clean up any stale MiBot tabs from previous runs
  try {
    const tabsRes = await fetch(`${CAMOFOX_URL}/tabs?userId=${USER_ID}`);
    const tabsData = await tabsRes.json() as { tabs: Array<{ tabId: string; url: string }> };
    for (const tab of tabsData.tabs || []) {
      if (tab.url.includes('meet.google.com')) {
        // Navigate away to leave the meeting, then delete
        await fetch(`${CAMOFOX_URL}/tabs/${tab.tabId}/navigate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: USER_ID, url: 'https://google.com' }),
        }).catch(() => {});
        await new Promise(r => setTimeout(r, 2000));
        await fetch(`${CAMOFOX_URL}/tabs/${tab.tabId}?userId=${USER_ID}`, { method: 'DELETE' }).catch(() => {});
        console.error(`[mibot] Cleaned up stale camofox tab: ${tab.tabId.substring(0, 12)}`);
      }
    }
  } catch {}

  // WebRTC hook as initScript — runs BEFORE page content on every navigation
  const webrtcHook = `
    if (!window.__mibotHooked) {
      window.__mibotHooked = true;
      const origRTC = window.RTCPeerConnection;
      window.RTCPeerConnection = function(...args) {
        const pc = new origRTC(...args);
        pc.addEventListener('track', (event) => {
          if (event.track.kind === 'audio') {
            if (!window.__mibotAudioCtx) {
              window.__mibotAudioCtx = new AudioContext();
              window.__mibotDest = window.__mibotAudioCtx.createMediaStreamDestination();
              window.__mibotSources = [];
            }
            const stream = new MediaStream([event.track]);
            const source = window.__mibotAudioCtx.createMediaStreamSource(stream);
            source.connect(window.__mibotDest);
            window.__mibotSources.push(source);
            if (!window.__mibotRecorder) {
              const recorder = new MediaRecorder(window.__mibotDest.stream, {
                mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 64000
              });
              const chunks = [];
              recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
              recorder.start(1000);
              window.__mibotRecorder = recorder;
              window.__mibotChunks = chunks;
              window.__mibotFlushedChunks = [];
              setInterval(() => {
                if (chunks.length > 0) window.__mibotFlushedChunks.push(...chunks.splice(0));
              }, 5000);
            }
          }
        });
        return pc;
      };
      window.RTCPeerConnection.prototype = origRTC.prototype;
    }
  `;

  const page = new CamofoxPage();
  // Create tab with initScript (WebRTC hook runs before any page JS)
  await page.createTab(url, webrtcHook);
  await page.waitForTimeout(8000);
  console.error('[mibot] Camofox browser ready (WebRTC hook pre-injected)');
  return page;
}
