import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  selectStaleTabs,
  isPidAlive,
  registerTab,
  unregisterTab,
  readTabOwner,
  type TabInfo,
} from '../src/camofox.js';

// J3: the stale-tab sweep in launchCamofox deleted EVERY meet.google.com tab under the
// shared hardcoded USER_ID='mibot'. A second bot started via `mibot join` alongside a
// running `mibot start` would have its LIVE meeting tab navigated-away and deleted mid-call.
// The fix: tag each tab with its owner pid in an on-disk registry and, before reclaiming a
// tab, skip any whose owner process is still alive. selectStaleTabs is the pure decision.

describe('selectStaleTabs (J3 concurrency-safe reclaim)', () => {
  const tabs: TabInfo[] = [
    { tabId: 'a', url: 'https://meet.google.com/abc-defg-hij' },
    { tabId: 'b', url: 'https://meet.google.com/xyz-wxyz-uvw' },
    { tabId: 'c', url: 'https://mail.google.com/' },
  ];

  it('reclaims meet tabs with no registered owner (crashed prior run)', () => {
    const stale = selectStaleTabs(tabs, () => undefined, () => true);
    expect(stale.map(t => t.tabId)).toEqual(['a', 'b']);
  });

  it('never reclaims a non-meet tab even when unowned', () => {
    const stale = selectStaleTabs(tabs, () => undefined, () => false);
    expect(stale.some(t => t.tabId === 'c')).toBe(false);
  });

  it('KEEPS a meet tab whose owner process is still alive (the live second bot)', () => {
    const owners: Record<string, number> = { a: 4242 };
    const stale = selectStaleTabs(
      tabs,
      (id) => owners[id],
      (pid) => pid === 4242, // 4242 is alive
    );
    // 'a' is owned by a live process → kept; 'b' is unowned → reclaimed.
    expect(stale.map(t => t.tabId)).toEqual(['b']);
  });

  it('reclaims a meet tab whose owner pid is dead (stale registry entry)', () => {
    const owners: Record<string, number> = { a: 4242, b: 9999 };
    const stale = selectStaleTabs(
      tabs,
      (id) => owners[id],
      (pid) => pid === 4242, // only 4242 alive; 9999 dead
    );
    expect(stale.map(t => t.tabId)).toEqual(['b']);
  });
});

describe('isPidAlive (J3 liveness probe)', () => {
  it('reports the current process as alive', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it('reports an almost-certainly-unused pid as dead', () => {
    // 2^30-ish pid: far above any real Linux pid_max, so kill(pid,0) → ESRCH.
    expect(isPidAlive(0x3fffffff)).toBe(false);
  });
});

describe('tab registry (J3 ownership tags)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mibot-tabreg-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips an owner pid through register → read', () => {
    registerTab('tab-1', 1234, dir);
    expect(readTabOwner('tab-1', dir)).toBe(1234);
  });

  it('returns undefined for an unregistered tab', () => {
    expect(readTabOwner('nope', dir)).toBeUndefined();
  });

  it('returns undefined after unregister', () => {
    registerTab('tab-2', 5678, dir);
    unregisterTab('tab-2', dir);
    expect(readTabOwner('tab-2', dir)).toBeUndefined();
  });

  it('unregister is best-effort (no throw for a missing entry)', () => {
    expect(() => unregisterTab('ghost', dir)).not.toThrow();
  });

  it('tolerates a corrupt registry file (returns undefined, no throw)', () => {
    fs.writeFileSync(path.join(dir, 'tab-3'), 'not-a-number');
    expect(readTabOwner('tab-3', dir)).toBeUndefined();
  });
});
