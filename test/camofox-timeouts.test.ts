import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

// Wave 9-H: CamofoxPage.close() and the stale-tab sweep used a bare fetch with no timeout.
// close() runs BEFORE transcription, so a wedged camofox stalled the meeting there forever
// (the heartbeat kept running, so stale recovery never stepped in either).
let server: http.Server;
const hits: string[] = [];
let mod: typeof import('../src/camofox.js');

beforeAll(async () => {
  // A camofox that accepts connections and then never answers.
  server = http.createServer((req) => { hits.push(`${req.method} ${req.url}`); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  process.env.CAMOFOX_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  mod = await import('../src/camofox.js'); // reads CAMOFOX_URL at load
  mod.__setCamofoxFetchTimeoutForTest(200);
});
afterAll(() => { server.closeAllConnections(); server.close(); });

describe('camofox calls cannot hang (Wave 9-H)', () => {
  it('close() returns promptly against an unresponsive camofox', async () => {
    const page = new mod.CamofoxPage();
    (page as any).tabId = 'tab-wedged';
    const t0 = Date.now();
    await page.close();
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(hits.some((h) => h.startsWith('DELETE /tabs/tab-wedged'))).toBe(true); // it did try
  });

  it('JSON calls are bounded by the same timeout', async () => {
    const page = new mod.CamofoxPage();
    (page as any).tabId = 'tab-wedged';
    const t0 = Date.now();
    await expect(page.snapshot()).rejects.toThrow();
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
