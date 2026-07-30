import { describe, it, expect } from 'vitest';
import {
  findRefInSnapshot, buildSelectorClickExpr, buildTypeSetExpr, buildPressExpr,
  SIGNAL_OBSERVER_SCRIPT, CamofoxPage,
} from '../src/camofox.js';

// J12: findRef matched a case-insensitive substring against the WHOLE snapshot line
// (role + name + ref), first hit wins. So target "Join" matched "Rejoin"/"Joined" and could
// even latch onto role words or ref digits. findRefInSnapshot matches the element *name*
// with a preference ladder: exact → whole-word → prefix → substring, so a better candidate
// always beats an accidental substring.
const SNAPSHOT = [
  'button "Rejoin" [e3]',
  'button "Join now" [e10]',
  'textbox "Your name" [e7]',
  'button "Joined participants" [e12]',
  'button "Leave call" [e20]',
].join('\n');

describe('findRefInSnapshot (J12 role/boundary matching)', () => {
  it('prefers a whole-word "Join now" over the substring "Rejoin"', () => {
    expect(findRefInSnapshot(SNAPSHOT, 'Join now')).toBe('e10');
  });

  it('matches the whole word "Join" to "Join now", not "Rejoin"', () => {
    // "Join" is a whole word in "Join now" (e10) but only a substring of "Rejoin" (e3).
    expect(findRefInSnapshot(SNAPSHOT, 'Join')).toBe('e10');
  });

  it('is case-insensitive', () => {
    expect(findRefInSnapshot(SNAPSHOT, 'your name')).toBe('e7');
  });

  it('prefers an exact name match over a prefix', () => {
    expect(findRefInSnapshot(SNAPSHOT, 'Rejoin')).toBe('e3');
  });

  it('never latches onto a ref-digit or role keyword', () => {
    // "button" is a role on every line and "10" is inside a ref — neither is an element name.
    expect(findRefInSnapshot(SNAPSHOT, 'button')).toBeNull();
    expect(findRefInSnapshot(SNAPSHOT, '10')).toBeNull();
  });

  it('returns null when nothing matches', () => {
    expect(findRefInSnapshot(SNAPSHOT, 'Mute microphone')).toBeNull();
  });
});

// J11: the camofox click path fed step.selector (a CSS string) into findRef, which searches
// snapshot *text* — a CSS selector essentially never appears there, so selector-targeted
// clicks silently never matched. A selector must be clicked via the DOM instead.
describe('buildSelectorClickExpr (J11)', () => {
  it('produces a querySelector-based click that compiles', () => {
    const expr = buildSelectorClickExpr('button.join-btn');
    expect(() => new Function(`return ${expr}`)).not.toThrow();
    expect(expr).toContain('querySelector');
  });

  it('escapes the selector safely (no injection via quotes)', () => {
    const expr = buildSelectorClickExpr(`a[href="'); x('"]`);
    expect(() => new Function(`return ${expr}`)).not.toThrow();
  });
});

// J6: the camofox `type` eval set el.value only when activeElement was editable, but the
// step ALWAYS logged "typed" — a mis-targeted type silently dropped the text. The expr must
// report whether it actually wrote, so the caller can fail loudly.
describe('buildTypeSetExpr (J6 verified write)', () => {
  it('returns an expression that yields false when no editable element is focused', () => {
    const expr = buildTypeSetExpr('MiBot');
    const doc = { activeElement: null };
    const fn = new Function('document', `return ${expr}`);
    expect(fn(doc)).toBe(false);
  });

  it('returns true and writes value when an input is focused', () => {
    const expr = buildTypeSetExpr('MiBot');
    const input: any = { tagName: 'INPUT', value: '', isContentEditable: false, dispatchEvent: () => true };
    const fn = new Function('document', 'Event', `return ${expr}`);
    const result = fn({ activeElement: input }, class { constructor() {} });
    expect(result).toBe(true);
    expect(input.value).toBe('MiBot');
  });
});

// J13: the signal observer was injected once via a live-page eval, guarded by
// `if (!window.__mibotSignals)`. A meeting navigation/reload wipes window state, killing the
// observer, and it was never re-installed within the monitor loop → signals silently stop.
// Fix: drainSignals re-installs the (idempotent) observer every poll, so a post-nav page
// re-arms itself. The guard makes re-install a no-op when the observer is still alive.
describe('signal observer self-heal (J13)', () => {
  it('drainSignals re-installs the observer each poll (survives navigation)', async () => {
    const page = new CamofoxPage();
    const evals: string[] = [];
    (page as any).eval = async (expr: string) => {
      evals.push(expr);
      return []; // drain returns an empty signal list
    };
    await page.drainSignals();
    // One of the evals this poll must be the observer install (idempotent re-arm).
    expect(evals.some((e) => e.includes('__mibotSignals') && e.includes('MutationObserver'))).toBe(true);
  });

  it('the observer script is guarded so re-install is a no-op when already present', () => {
    expect(SIGNAL_OBSERVER_SCRIPT).toContain('if (!window.__mibotSignals)');
  });
});

// J17: press dispatched synthetic (untrusted) KeyboardEvents but unconditionally logged
// "pressed". The expr must report whether there was a focused element to receive the keys.
describe('buildPressExpr (J17 honest dispatch)', () => {
  it('yields false when nothing is focused', () => {
    const expr = buildPressExpr('Enter');
    const fn = new Function('document', 'KeyboardEvent', `return ${expr}`);
    expect(fn({ activeElement: null }, class { constructor() {} })).toBe(false);
  });

  it('yields true when an element is focused', () => {
    const expr = buildPressExpr('Enter');
    const el = { dispatchEvent: () => true };
    const fn = new Function('document', 'KeyboardEvent', `return ${expr}`);
    expect(fn({ activeElement: el }, class { constructor() {} })).toBe(true);
  });
});
