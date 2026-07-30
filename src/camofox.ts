import type { Page, Frame, Locator } from 'playwright';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pollForFirst, type PollOptions } from './poll.js';

const CAMOFOX_URL = process.env.CAMOFOX_URL || 'http://localhost:9377';
const USER_ID = 'mibot';
const SESSION_KEY = 'meet';
const CAMOFOX_FETCH_TIMEOUT_MS = 15000;

/** J3 tab-ownership registry. Camofox shares one USER_ID across every bot in this
 *  install, so the on-disk tabId→owner-pid map is what lets the stale-tab sweep tell a
 *  *crashed* prior run's tab (safe to reclaim) from a *live* concurrent bot's meeting tab
 *  (must never be touched). Kept out of ~/.config/mibot so a test can point it elsewhere. */
export const TAB_REGISTRY_DIR =
  process.env.MIBOT_TAB_REGISTRY_DIR || path.join(os.tmpdir(), 'mibot-tabs');

/** Element the sweep reasons over: just the fields the camofox `/tabs` list returns. */
export interface TabInfo {
  tabId: string;
  url: string;
}

/** Record that `pid` owns `tabId`. Best-effort: a failed write just means the tab looks
 *  unowned to a later sweep (reclaimable), which is the safe default for our own tab. */
export function registerTab(tabId: string, pid: number, dir = TAB_REGISTRY_DIR): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, tabId), String(pid));
  } catch { /* best-effort */ }
}

/** Drop a tab's ownership record on clean close so it doesn't linger as a dead entry. */
export function unregisterTab(tabId: string, dir = TAB_REGISTRY_DIR): void {
  try {
    fs.unlinkSync(path.join(dir, tabId));
  } catch { /* already gone — fine */ }
}

/** Read the owner pid for a tab, or undefined if unregistered/corrupt/unreadable. */
export function readTabOwner(tabId: string, dir = TAB_REGISTRY_DIR): number | undefined {
  try {
    const raw = fs.readFileSync(path.join(dir, tabId), 'utf8').trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** True if a process with `pid` currently exists. `kill(pid, 0)` sends no signal; it only
 *  probes: it throws ESRCH when the pid is gone, EPERM when it exists but we can't signal it
 *  (still alive → keep the tab). */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** J3: decide which tabs the sweep may reclaim. A tab is stale ONLY if it is a meet tab
 *  AND (it has no registered owner — a crashed prior run — OR its owner pid is dead). A
 *  meet tab owned by a live process is a concurrent bot's meeting and is left untouched.
 *  Pure over its two injected probes so it is unit-testable without a registry or real pids. */
export function selectStaleTabs(
  tabs: TabInfo[],
  ownerOf: (tabId: string) => number | undefined = (id) => readTabOwner(id),
  alive: (pid: number) => boolean = isPidAlive,
): TabInfo[] {
  return tabs.filter((tab) => {
    if (!tab.url.includes('meet.google.com')) return false;
    const owner = ownerOf(tab.tabId);
    if (owner === undefined) return true; // unowned → crashed prior run
    return !alive(owner); // owned but dead → stale entry
  });
}

interface CamofoxTab {
  tabId: string;
}

/** Typed error for any non-2xx or non-JSON camofox REST response (R8). Carries the
 *  status and a bounded body excerpt so a crashed camofox surfaces as a diagnosable
 *  failure instead of an opaque SyntaxError deep inside snapshot parsing. */
export class CamofoxApiError extends Error {
  constructor(
    message: string,
    readonly path: string,
    readonly status: number,
    readonly bodyExcerpt: string,
  ) {
    super(message);
    this.name = 'CamofoxApiError';
  }
}

/** Pure validator for a camofox REST response (F8/R8). Rejects non-2xx and non-JSON
 *  bodies with a typed error; returns the parsed JSON otherwise. Kept side-effect-free
 *  (status/ok/text passed in) so the contract is unit-testable without a live server. */
export function parseCamofoxResponse(path: string, status: number, ok: boolean, body: string): any {
  const excerpt = body.length > 300 ? body.slice(0, 297) + '...' : body;
  if (!ok) {
    throw new CamofoxApiError(`Camofox ${path} failed: HTTP ${status}`, path, status, excerpt);
  }
  let parsed: any;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new CamofoxApiError(`Camofox ${path} returned non-JSON body`, path, status, excerpt);
  }
  // J2: a 200 can still carry a semantic failure ({ok:false,error}). Callers (eval reads
  // data.result, findRef parses data.snapshot) would treat the missing field as an empty
  // success. Reject an explicit ok:false; leave bodies without an `ok` field (snapshot,
  // bare arrays) untouched so only intentional failure envelopes are caught.
  if (parsed && typeof parsed === 'object' && parsed.ok === false) {
    const detail = typeof parsed.error === 'string' ? parsed.error : JSON.stringify(parsed).slice(0, 200);
    throw new CamofoxApiError(`Camofox ${path} reported failure: ${detail}`, path, status, excerpt);
  }
  return parsed;
}

/** Test seam for camofoxFetch: inject a fake fetch and shorten the timeout so the J15
 *  deadline path is exercisable without a live socket. */
export interface CamofoxFetchOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Single fetch choke point (R8): every JSON-returning camofox call reads the body once
 *  and validates it through parseCamofoxResponse, so a crashed/500ing server can never be
 *  mistaken for a valid response. `label` is the logical path used in error messages.
 *  J15: every request is bounded by an AbortSignal timeout — a hung camofox connection
 *  surfaces as a typed CamofoxApiError instead of blocking the bot forever. */
export async function camofoxFetch(
  label: string,
  url: string,
  init?: RequestInit,
  opts?: CamofoxFetchOptions,
): Promise<any> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const timeoutMs = opts?.timeoutMs ?? CAMOFOX_FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (e) {
    if (controller.signal.aborted) {
      throw new CamofoxApiError(`Camofox ${label} timed out after ${timeoutMs}ms`, label, 0, '');
    }
    throw new CamofoxApiError(`Camofox ${label} unreachable: ${(e as Error).message}`, label, 0, '');
  } finally {
    clearTimeout(timer);
  }
  const body = await res.text();
  return parseCamofoxResponse(label, res.status, res.ok, body);
}

/** J12: resolve an element ref from an accessibility snapshot by matching the element's
 *  *name* (the quoted string), not the whole line. A preference ladder — exact → whole-word
 *  → prefix → substring — guarantees a better candidate always beats an accidental substring
 *  ("Join" no longer latches onto "Rejoin", and role words / ref digits never match at all).
 *  Snapshot line format: `role "Name" [e12]`. Returns the ref (e.g. "e12") or null. */
export function findRefInSnapshot(snapshot: string, target: string): string | null {
  const needle = target.toLowerCase().trim();
  if (!needle) return null;
  const wordRe = new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);

  let best: { ref: string; rank: number } | null = null;
  for (const line of snapshot.split('\n')) {
    const m = line.match(/"([^"]*)"\s*\[e(\d+)\]/);
    if (!m) continue;
    const name = m[1].toLowerCase();
    const ref = `e${m[2]}`;
    let rank = 0;
    if (name === needle) rank = 4;
    else if (wordRe.test(name)) rank = 3;
    else if (name.startsWith(needle)) rank = 2;
    else if (name.includes(needle)) rank = 1;
    if (rank > 0 && (!best || rank > best.rank)) best = { ref, rank };
    if (best?.rank === 4) break; // can't beat an exact match
  }
  return best ? best.ref : null;
}

/** J11: click a CSS-selector target through the DOM (findRef searches snapshot *text*, where
 *  a selector never appears). Returns 'not found' if the selector matches nothing. */
export function buildSelectorClickExpr(selector: string): string {
  return `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (el) { el.click(); return 'clicked'; } return 'not found'; })()`;
}

/** J6: set the focused editable element's value and REPORT whether a write happened, so a
 *  mis-targeted type fails loudly instead of logging a phantom "typed". */
export function buildTypeSetExpr(value: string): string {
  return `(() => { const el = document.activeElement; if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) { el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); return true; } return false; })()`;
}

/** J17: dispatch key events to the focused element and REPORT whether there was one to
 *  receive them (synthetic events are untrusted, so at minimum don't claim success on none). */
export function buildPressExpr(key: string): string {
  const k = JSON.stringify(key);
  return `(() => { const el = document.activeElement; if (!el) return false; el.dispatchEvent(new KeyboardEvent('keydown', { key: ${k}, bubbles: true })); el.dispatchEvent(new KeyboardEvent('keyup', { key: ${k}, bubbles: true })); return true; })()`;
}

/** Thin wrapper around camofox REST API that exposes a Playwright-like Page interface.
 *  Only implements methods used by the playbook engine + meeting detection. */
export class CamofoxPage {
  private tabId: string | null = null;

  async createTab(url: string, initScript?: string): Promise<void> {
    const data = await camofoxFetch('/tabs', `${CAMOFOX_URL}/tabs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER_ID, sessionKey: SESSION_KEY, url, ...(initScript ? { initScript } : {}) }),
    }) as CamofoxTab;
    if (!data.tabId) throw new CamofoxApiError('Camofox /tabs returned no tabId', '/tabs', 200, JSON.stringify(data).slice(0, 300));
    this.tabId = data.tabId;
    registerTab(this.tabId, process.pid); // J3: claim ownership so a peer's sweep spares this tab
    console.error(`[mibot] Camofox tab: ${this.tabId}`);
  }

  private async api(path: string, body?: Record<string, unknown>): Promise<any> {
    if (!this.tabId) throw new Error('No camofox tab created');
    const url = `${CAMOFOX_URL}/tabs/${this.tabId}${path}?userId=${USER_ID}`;
    if (body) {
      return camofoxFetch(path, url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: USER_ID, ...body }),
      });
    }
    return camofoxFetch(path, url);
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

  /** Take a screenshot. Binary endpoint, so it can't use the JSON choke point — but it
   *  still gets the J15 abort timeout so a hung camofox can't block the signal loop. */
  async screenshot(opts?: { path?: string }): Promise<Buffer> {
    if (!this.tabId) throw new Error('No tab');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CAMOFOX_FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${CAMOFOX_URL}/tabs/${this.tabId}/screenshot?userId=${USER_ID}`, { signal: controller.signal });
    } catch (e) {
      const aborted = controller.signal.aborted;
      throw new CamofoxApiError(
        aborted ? `Camofox /screenshot timed out after ${CAMOFOX_FETCH_TIMEOUT_MS}ms` : `Camofox /screenshot unreachable: ${(e as Error).message}`,
        '/screenshot', 0, '',
      );
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      throw new CamofoxApiError(`Camofox /screenshot failed: HTTP ${res.status}`, '/screenshot', res.status, '');
    }
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
    unregisterTab(this.tabId); // J3: drop our ownership record so we don't leave a dead entry
    this.tabId = null;
  }

  /** Find a ref by element name in the snapshot (J12: name-scoped, preference-ranked match
   *  via findRefInSnapshot — no more "Join"→"Rejoin" or role-word false hits). */
  async findRef(text: string): Promise<string | null> {
    const { snapshot } = await this.snapshot();
    return findRefInSnapshot(snapshot, text);
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
    const data = await camofoxFetch('/eval', `${CAMOFOX_URL}/tabs/${this.tabId}/eval`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER_ID, expression }),
    }) as { ok: boolean; result: unknown };
    return data.result;
  }

  /** Install a MutationObserver that captures all meeting signals (chat, reactions, hand raises). */
  async installSignalObserver(): Promise<void> {
    await this.eval(SIGNAL_OBSERVER_SCRIPT);
    console.error('[mibot] Camofox signal observer installed');
  }

  /** Read and flush captured signals. J13: re-install the (idempotent) observer first so a
   *  page that navigated/reloaded since the last poll — which wipes window.__mibotSignals and
   *  kills the observer — re-arms itself instead of going silent for the rest of the meeting. */
  async drainSignals(): Promise<Array<{ raw: string; type: string; who: string; detail: string; time: string }>> {
    await this.eval(SIGNAL_OBSERVER_SCRIPT).catch(() => {});
    const result = await this.eval('(() => { const s = window.__mibotSignals || []; window.__mibotSignals = []; return s; })()');
    return (result as any[]) || [];
  }
}

/** J13: the signal-capture observer as a single idempotent script (guarded by
 *  `if (!window.__mibotSignals)`), so installing it repeatedly is a no-op while the page is
 *  alive but re-arms a page that lost its window state to a navigation. */
export const SIGNAL_OBSERVER_SCRIPT = `
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
`;

/** J20: poll a real readiness signal (a successful accessibility snapshot) to a deadline
 *  instead of a blind fixed sleep. Returns true the instant the page answers, false if the
 *  deadline lapses. Clock injected (now/sleep) so it's unit-testable without real timers. */
export async function awaitCamofoxReady(
  page: { snapshot: () => Promise<unknown> },
  opts: PollOptions = { deadlineMs: 30000, intervalMs: 1000 },
): Promise<boolean> {
  const match = await pollForFirst(
    [page],
    async (p) => { await p.snapshot(); return true; },
    opts,
  );
  return match !== null;
}

/** Launch a camofox browser and navigate to the meeting URL. */
export async function launchCamofox(url: string): Promise<CamofoxPage> {
  // Verify camofox is running
  try {
    const data = await camofoxFetch('/', `${CAMOFOX_URL}/`) as { ok: boolean };
    if (!data.ok) throw new Error('Camofox not ready');
  } catch {
    throw new Error(`Camofox not running at ${CAMOFOX_URL}. Start it with: cd /root/projects/camofox-browser && npm start`);
  }

  // J3: reclaim ONLY stale meet tabs — a crashed prior run's, or one whose owner pid is
  // dead. A meet tab owned by a live process is a concurrent bot's meeting; deleting it
  // would drop that bot mid-call, so selectStaleTabs leaves it alone.
  try {
    const tabsData = await camofoxFetch('/tabs', `${CAMOFOX_URL}/tabs?userId=${USER_ID}`) as { tabs: TabInfo[] };
    for (const tab of selectStaleTabs(tabsData.tabs || [])) {
      // Navigate away to leave the meeting, then delete
      await fetch(`${CAMOFOX_URL}/tabs/${tab.tabId}/navigate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: USER_ID, url: 'https://google.com' }),
      }).catch(() => {});
      await new Promise(r => setTimeout(r, 2000));
      await fetch(`${CAMOFOX_URL}/tabs/${tab.tabId}?userId=${USER_ID}`, { method: 'DELETE' }).catch(() => {});
      unregisterTab(tab.tabId); // clear any dead ownership record we just reclaimed
      console.error(`[mibot] Cleaned up stale camofox tab: ${tab.tabId.substring(0, 12)}`);
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
  // J20: wait on a real readiness signal (snapshot answers) instead of a blind 8s sleep.
  const ready = await awaitCamofoxReady(page, { deadlineMs: 30000, intervalMs: 1000 });
  if (!ready) {
    console.error('[mibot] Camofox: page not ready after 30s (continuing anyway)');
  } else {
    console.error('[mibot] Camofox browser ready (WebRTC hook pre-injected)');
  }
  return page;
}
