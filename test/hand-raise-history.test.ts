import { describe, it, expect } from 'vitest';
import { HandRaiseTracker } from '../src/signal-dedup.js';

// M10: hand raises were stored in a Map<string, HandRaise> keyed by name. When someone lowered
// then re-raised, the new raise OVERWROTE the map entry, discarding the completed earlier raise —
// so a participant who raised twice showed only their last raise in the meeting record.
// HandRaiseTracker keeps a full history: each rising edge opens a new raise; a falling edge closes
// the open one; finish() returns every raise in order.
describe('M10 HandRaiseTracker (re-raise history)', () => {
  it('records a single raise/lower cycle', () => {
    const t = new HandRaiseTracker();
    t.observe(['Ada'], 't1');
    t.observe([], 't2');
    const all = t.finish('tEnd');
    expect(all).toEqual([{ participant: 'Ada', raised_at: 't1', lowered_at: 't2' }]);
  });

  it('preserves BOTH raises when a hand is re-raised after lowering', () => {
    const t = new HandRaiseTracker();
    t.observe(['Ada'], 't1');   // raise #1
    t.observe([], 't2');        // lower #1
    t.observe(['Ada'], 't3');   // raise #2
    t.observe([], 't4');        // lower #2
    const all = t.finish('tEnd');
    expect(all).toEqual([
      { participant: 'Ada', raised_at: 't1', lowered_at: 't2' },
      { participant: 'Ada', raised_at: 't3', lowered_at: 't4' },
    ]);
  });

  it('does not re-open a hand that stays raised across polls', () => {
    const t = new HandRaiseTracker();
    t.observe(['Ada'], 't1');
    t.observe(['Ada'], 't2'); // still raised — same raise, not a new one
    t.observe(['Ada'], 't3');
    const all = t.finish('tEnd');
    expect(all).toHaveLength(1);
    expect(all[0]).toEqual({ participant: 'Ada', raised_at: 't1', lowered_at: 'tEnd' });
  });

  it('closes still-open hands at finish()', () => {
    const t = new HandRaiseTracker();
    t.observe(['Ada', 'Bo'], 't1');
    t.observe(['Ada'], 't2'); // Bo lowered
    const all = t.finish('tEnd');
    expect(all).toContainEqual({ participant: 'Bo', raised_at: 't1', lowered_at: 't2' });
    expect(all).toContainEqual({ participant: 'Ada', raised_at: 't1', lowered_at: 'tEnd' });
  });

  it('tracks concurrent independent raisers', () => {
    const t = new HandRaiseTracker();
    t.observe(['Ada'], 't1');
    t.observe(['Ada', 'Bo'], 't2');
    t.observe([], 't3');
    const all = t.finish('tEnd');
    expect(all).toHaveLength(2);
    expect(all).toContainEqual({ participant: 'Ada', raised_at: 't1', lowered_at: 't3' });
    expect(all).toContainEqual({ participant: 'Bo', raised_at: 't2', lowered_at: 't3' });
  });

  it('exposes the count of open hands (for the finish() summary log)', () => {
    const t = new HandRaiseTracker();
    t.observe(['Ada', 'Bo'], 't1');
    expect(t.totalRaises()).toBe(2);
    t.observe([], 't2');
    expect(t.totalRaises()).toBe(2); // completed, still counted
  });
});
