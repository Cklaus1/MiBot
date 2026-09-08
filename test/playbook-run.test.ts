import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PlaybookEngine } from '../src/playbook.js';

/**
 * Item 6: PlaybookEngine.run is the code path that actually joins every Teams/Zoom meeting,
 * and nothing exercised it — the join flow was only ever verified by joining a real meeting.
 * The four tests this replaces asserted Buffer's own semantics (`a.equals(Buffer.from(a))`)
 * and grepped a source file for a constant; test/image-similarity.test.ts already covers the
 * real exported similarity functions.
 *
 * FakePage implements the narrow slice of the Playwright surface the engine touches
 * (frames/locators/keyboard/screenshot) and records every interaction, so these tests assert
 * on the engine's DECISIONS — ordering, optional-step recovery, try-fallback, interpolation —
 * rather than on Playwright.
 */
class FakeLocator {
  constructor(private page: FakePage, private desc: string, private visible: boolean) {}
  first() { return this; }
  locator(sel: string) { return new FakeLocator(this.page, `${this.desc}>${sel}`, this.visible); }
  async isVisible() { return this.visible; }
  async click() {
    if (!this.visible) throw new Error(`not visible: ${this.desc}`);
    this.page.log.push(`click:${this.desc}`);
  }
  async fill(v: string) { this.page.log.push(`fill:${this.desc}=${v}`); }
}

class FakePage {
  log: string[] = [];
  /** Text/role names that "exist" on this fake page; everything else is invisible. */
  constructor(public present: string[] = [], public evalResult: unknown = 'ok') {}
  keyboard = {
    type: async (t: string) => { this.log.push(`type:${t}`); },
    press: async (k: string) => { this.log.push(`press:${k}`); },
  };
  private has(name: string) { return this.present.some((p) => name.includes(p)); }
  mainFrame() { return this; }
  frames(): FakePage[] { return [this]; }
  url() { return 'https://fake/'; }
  getByRole(role: string, opts?: { name?: string }) {
    const d = `role=${role}:${opts?.name ?? ''}`;
    return new FakeLocator(this, d, this.has(opts?.name ?? role));
  }
  getByText(text: string) { return new FakeLocator(this, `text=${text}`, this.has(text)); }
  locator(sel: string) { return new FakeLocator(this, `sel=${sel}`, this.has(sel)); }
  async goto(url: string) { this.log.push(`goto:${url}`); }
  async waitForTimeout(ms: number) { this.log.push(`wait:${ms}`); }
  async screenshot(o: { path: string }) { this.log.push(`shot:${o.path}`); }
  async evaluate(expr: string) { this.log.push(`eval:${expr.slice(0, 40)}`); return this.evalResult; }
}

const mk = (page: FakePage, vars: Record<string, string> = {}) =>
  new PlaybookEngine(page as any, vars);
const pb = (steps: any[], variables: Record<string, string> = {}) =>
  ({ name: 'test', steps, variables }) as any;

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => { errSpy = vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => errSpy.mockRestore());

describe('PlaybookEngine.run', () => {
  it('executes steps in order', async () => {
    const page = new FakePage(['Join now']);
    await mk(page).run(pb([
      { action: 'goto', url: 'https://meet/x' },
      { action: 'click', role: 'button', name: 'Join now' },
      { action: 'press', key: 'Enter' },
    ]));
    expect(page.log).toEqual(['goto:https://meet/x', 'click:role=button:Join now', 'press:Enter']);
  });

  it('a failing non-optional step aborts the run', async () => {
    const page = new FakePage([]); // nothing present
    await expect(mk(page).run(pb([
      { action: 'click', role: 'button', name: 'Join now', timeout: 20 },
      { action: 'press', key: 'Enter' },
    ]))).rejects.toThrow(/not found/);
    expect(page.log).not.toContain('press:Enter');
  });

  it('a failing OPTIONAL step is skipped and the run continues', async () => {
    // This is the pre-join dialog case: "Continue without audio" may or may not appear.
    const page = new FakePage(['Join now']);
    await mk(page).run(pb([
      { action: 'click', role: 'button', name: 'Continue without audio', optional: true, timeout: 20 },
      { action: 'click', role: 'button', name: 'Join now' },
    ]));
    expect(page.log).toEqual(['click:role=button:Join now']);
  });

  it('try falls through alternatives until one succeeds', async () => {
    const page = new FakePage(['Join now']);
    await mk(page).run(pb([{
      action: 'try', timeout: 20, steps: [
        { action: 'click', role: 'button', name: 'Continue on this browser' },
        { action: 'click', role: 'button', name: 'Join now' },
        { action: 'click', role: 'button', name: 'Never reached' },
      ],
    }]));
    // Stops at the first success — the third alternative must not run.
    expect(page.log).toEqual(['click:role=button:Join now']);
  });

  it('try that exhausts every alternative throws unless optional', async () => {
    const steps = [{ action: 'click', role: 'button', name: 'A' }, { action: 'click', role: 'button', name: 'B' }];
    await expect(mk(new FakePage([])).run(pb([{ action: 'try', timeout: 20, steps }])))
      .rejects.toThrow();
    await expect(mk(new FakePage([])).run(pb([{ action: 'try', timeout: 20, optional: true, steps }])))
      .resolves.toBeUndefined();
  });

  it('interpolates {{vars}}, with constructor vars overriding playbook defaults', async () => {
    const page = new FakePage(['Name']);
    await mk(page, { botName: 'MiBot' }).run(pb(
      [{ action: 'fill', role: 'textbox', name: 'Name', value: '{{botName}} ({{suffix}})' }],
      { botName: 'default', suffix: 'rec' },
    ));
    expect(page.log).toContain('fill:role=textbox:Name=MiBot (rec)');
  });

  it('rejects an unknown action rather than silently skipping it', async () => {
    await expect(mk(new FakePage()).run(pb([{ action: 'teleport' }])))
      .rejects.toThrow(/Unknown action: teleport/);
  });

  it('a step with no targeting is an error, not a no-op click', async () => {
    await expect(mk(new FakePage()).run(pb([{ action: 'click', timeout: 20 }])))
      .rejects.toThrow(/targeting/);
  });

  it('runs an empty playbook without touching the page', async () => {
    const page = new FakePage();
    await mk(page).run(pb([]));
    expect(page.log).toEqual([]);
  });

  it('js_click throws when the in-page search reports not found', async () => {
    const page = new FakePage([], 'not found');
    await expect(mk(page).run(pb([{ action: 'js_click', text: 'Join' }])))
      .rejects.toThrow(/js_click/);
  });
});
