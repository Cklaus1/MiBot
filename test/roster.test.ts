import { describe, it, expect } from 'vitest';
import { RosterTracker } from '../src/roster.js';

const m = (...pairs: [string, boolean][]) => new Map(pairs);

describe('RosterTracker (AR1 shared core)', () => {
  it('records a join once, not on every poll', () => {
    const logs: string[] = [];
    const r = new RosterTracker((s) => logs.push(s));
    r.observe(m(['Ann', false]), 't1');
    r.observe(m(['Ann', false]), 't2');
    const [ann] = r.finish('t9');
    expect(ann.joined_at).toBe('t1');
    expect(logs).toEqual(['Participant joined: Ann']);
  });

  it('marks a departure with the poll time it was first missing', () => {
    const r = new RosterTracker();
    r.observe(m(['Ann', false], ['Bob', false]), 't1');
    r.observe(m(['Ann', false]), 't2');
    r.observe(m(['Ann', false]), 't3');
    const bob = r.finish('t9').find((p) => p.name === 'Bob')!;
    expect(bob.left_at).toBe('t2');
  });

  it('clears left_at on rejoin rather than creating a duplicate', () => {
    const logs: string[] = [];
    const r = new RosterTracker((s) => logs.push(s));
    r.observe(m(['Ann', false]), 't1');
    r.observe(m(), 't2');
    r.observe(m(['Ann', false]), 't3');
    // Still present at t3, so the stale t2 departure must have been cleared -- finish() then
    // stamps the end-of-meeting time, not the moment she blipped out.
    const all = r.finish('t9');
    expect(all).toHaveLength(1);
    expect(all[0].left_at).toBe('t9');
    expect(all[0].joined_at).toBe('t1'); // original join time preserved
    expect(logs).toContain('Participant rejoined: Ann');
  });

  it('updates bot classification when it changes', () => {
    const r = new RosterTracker();
    r.observe(m(['Notetaker', false]), 't1');
    r.observe(m(['Notetaker', true]), 't2');
    expect(r.finish('t9')[0].is_bot).toBe(true);
  });

  it('finish() closes only still-present participants', () => {
    const r = new RosterTracker();
    r.observe(m(['Ann', false], ['Bob', false]), 't1');
    r.observe(m(['Ann', false]), 't2');
    const out = r.finish('t9');
    expect(out.find((p) => p.name === 'Bob')!.left_at).toBe('t2'); // not overwritten
    expect(out.find((p) => p.name === 'Ann')!.left_at).toBe('t9');
  });

  it('markSpoke flags a known participant and ignores an unknown one', () => {
    const r = new RosterTracker();
    r.observe(m(['Ann', false]), 't1');
    r.markSpoke('Ann');
    expect(() => r.markSpoke('Ghost')).not.toThrow();
    expect(r.finish('t9')[0].spoke).toBe(true);
  });

  it('an empty observation marks everyone gone but keeps the history', () => {
    const r = new RosterTracker();
    r.observe(m(['Ann', false]), 't1');
    r.observe(m(), 't2');
    const out = r.finish('t9');
    expect(out).toHaveLength(1);
    expect(out[0].left_at).toBe('t2');
  });
});
