import { describe, it, expect } from 'vitest';
import {
  interpolateVars, validatePlaybook, defaultScreenshotPath,
} from '../src/playbook.js';

// J21: interpolate used `vars[key] || '{{key}}'`, so a variable whose value is the empty
// string fell through to the literal placeholder `{{key}}` instead of substituting "". A
// blank display name or empty password would render as the raw template text.
describe('interpolateVars (J21 empty-string vars)', () => {
  it('substitutes an empty-string variable as "" (not the literal placeholder)', () => {
    expect(interpolateVars('name=[{{n}}]', { n: '' })).toBe('name=[]');
  });

  it('substitutes normal values', () => {
    expect(interpolateVars('hi {{who}}', { who: 'MiBot' })).toBe('hi MiBot');
  });

  it('leaves the placeholder intact for a genuinely missing key', () => {
    expect(interpolateVars('{{missing}}', {})).toBe('{{missing}}');
  });

  it('handles multiple vars including an empty one', () => {
    expect(interpolateVars('{{a}}/{{b}}', { a: '', b: 'x' })).toBe('/x');
  });
});

// J18: load() JSON.parsed a file and cast it to Playbook with no validation. A file missing
// `steps` (or with a non-array steps) passed through, then run() crashed on
// `playbook.steps.length` with an opaque TypeError. validatePlaybook fails fast with a clear
// message naming the problem.
describe('validatePlaybook (J18 shape validation)', () => {
  it('accepts a minimal valid playbook', () => {
    const pb = validatePlaybook({ name: 'x', platform: 'teams', steps: [{ action: 'log', message: 'hi' }] });
    expect(pb.steps).toHaveLength(1);
  });

  it('throws when steps is missing', () => {
    expect(() => validatePlaybook({ name: 'x', platform: 'teams' })).toThrow(/steps/);
  });

  it('throws when steps is not an array', () => {
    expect(() => validatePlaybook({ name: 'x', platform: 'teams', steps: 'nope' })).toThrow(/steps/);
  });

  it('throws when a step has no action', () => {
    expect(() => validatePlaybook({ name: 'x', platform: 'teams', steps: [{ text: 'no action' }] })).toThrow(/action/);
  });

  it('throws on a non-object top level', () => {
    expect(() => validatePlaybook(null)).toThrow();
    expect(() => validatePlaybook([])).toThrow();
  });
});

// J24: default screenshot path was `/tmp/mibot-step-${num}.png` — keyed only by step number,
// so two concurrent bots hitting the same step index overwrote each other's screenshot.
describe('defaultScreenshotPath (J24 concurrent clobber)', () => {
  it('includes the process id so concurrent bots do not collide', () => {
    const p = defaultScreenshotPath(3);
    expect(p).toContain(String(process.pid));
    expect(p).toContain('step-3');
    expect(p.endsWith('.png')).toBe(true);
  });

  it('two calls at the same step yield distinct paths', () => {
    expect(defaultScreenshotPath(1)).not.toBe(defaultScreenshotPath(1));
  });
});
