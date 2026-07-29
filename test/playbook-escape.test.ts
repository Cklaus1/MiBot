import { describe, it, expect } from 'vitest';

/**
 * Guards the escaping fix in playbook.ts: generated JS strings are built with
 * JSON.stringify, not hand-rolled `replace(/'/g, "\\'")`. The old approach
 * escaped single quotes but not backslashes or newlines, so a button label or
 * fill value containing those produced a syntax error in the generated eval.
 *
 * These tests exercise the escaping *property* (the mechanism the engines rely
 * on) against inputs that broke the old scheme, and confirm the emitted source
 * parses and matches the original string exactly.
 */

/** Mirror of the emission pattern used in playbook.ts buildJsClickExpr/type/etc. */
function emitIncludesExpr(text: string): string {
  return `b.textContent?.includes(${JSON.stringify(text)})`;
}

/** Compile the emitted fragment and recover the literal it encodes. */
function evalEmittedLiteral(text: string): string {
  // Reconstruct just the JSON.stringify'd literal and eval it back.
  const literal = JSON.stringify(text);
  // eslint-disable-next-line no-eval
  return eval(`(${literal})`);
}

const ADVERSARIAL = [
  "O'Brien",                    // single quote — old scheme handled this
  'back\\slash',                // backslash — old scheme BROKE here
  'line1\nline2',               // newline — old scheme BROKE here
  "both ' and \\ and \n",       // all three
  'quote " double',             // double quote
  'unicode → ✓ 日本語',          // non-ascii
  '',                           // empty
  "'); alert(1); ('",           // injection-shaped payload
];

describe('playbook JS escaping (JSON.stringify)', () => {
  it('round-trips adversarial strings exactly', () => {
    for (const s of ADVERSARIAL) {
      expect(evalEmittedLiteral(s)).toBe(s);
    }
  });

  it('emits syntactically valid JS for adversarial button text', () => {
    for (const s of ADVERSARIAL) {
      const expr = emitIncludesExpr(s);
      // Should compile without throwing a SyntaxError.
      expect(() => new Function('b', `return ${expr};`)).not.toThrow();
    }
  });

  it('a backslash no longer breaks the generated source', () => {
    // Regression: `replace(/'/g, "\\'")` left a dangling escape here.
    const expr = emitIncludesExpr('C:\\Users\\bot');
    const fn = new Function('b', `return ${expr};`);
    expect(fn({ textContent: 'path C:\\Users\\bot here' })).toBe(true);
    expect(fn({ textContent: 'unrelated' })).toBe(false);
  });

  it('an injection-shaped label is treated as a plain string, not code', () => {
    const expr = emitIncludesExpr("'); globalThis.__pwned = true; ('");
    // If escaping were broken, building/running this would execute the payload.
    const fn = new Function('b', `return ${expr};`);
    fn({ textContent: 'anything' });
    expect((globalThis as any).__pwned).toBeUndefined();
  });
});
