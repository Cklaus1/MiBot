import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { risingEdgeReactions } from '../src/signal-dedup.js';

// M5: reactions are transient floating animations. The old pollReactions pushed EVERY scraped
// reaction element every poll with no dedup, so a reaction whose animation spanned two 5s polls
// double-counted. Worse, it also re-scraped raised-hand indicators as a `raised_hand` reaction
// every poll — a 10-minute raised hand became ~120 phantom reaction rows. risingEdgeReactions
// emits a reaction only on the rising edge (present now, absent last poll); pollHandRaises owns
// hand tracking, so the hand-as-reaction scrape is removed entirely.
describe('M5 risingEdgeReactions (windowed dedup)', () => {
  it('emits a reaction present in a single poll exactly once', () => {
    const { fresh } = risingEdgeReactions([{ participant: 'Ada', type: 'like' }], new Set());
    expect(fresh).toEqual([{ participant: 'Ada', type: 'like' }]);
  });

  it('does NOT re-emit a reaction that persists across consecutive polls', () => {
    const poll1 = risingEdgeReactions([{ participant: 'Ada', type: 'like' }], new Set());
    expect(poll1.fresh).toHaveLength(1);
    // Same animation still floating next poll → suppressed.
    const poll2 = risingEdgeReactions([{ participant: 'Ada', type: 'like' }], poll1.keys);
    expect(poll2.fresh).toHaveLength(0);
  });

  it('re-emits a reaction that disappeared then reappeared (genuinely new)', () => {
    const poll1 = risingEdgeReactions([{ participant: 'Ada', type: 'like' }], new Set());
    const poll2 = risingEdgeReactions([], poll1.keys); // gone
    const poll3 = risingEdgeReactions([{ participant: 'Ada', type: 'like' }], poll2.keys); // back
    expect(poll3.fresh).toHaveLength(1);
  });

  it('emits multiple distinct reactions in the same poll', () => {
    const { fresh } = risingEdgeReactions(
      [{ participant: 'Ada', type: 'like' }, { participant: 'Bo', type: 'heart' }],
      new Set(),
    );
    expect(fresh).toHaveLength(2);
  });

  it('collapses duplicate identical reactions within one poll to a single edge', () => {
    const { fresh } = risingEdgeReactions(
      [{ participant: 'Ada', type: 'like' }, { participant: 'Ada', type: 'like' }],
      new Set(),
    );
    expect(fresh).toHaveLength(1);
  });
});

describe('M5 hand-as-reaction scrape removed', () => {
  it('pollReactions no longer produces a raised_hand reaction', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/signals.ts'), 'utf8');
    // The old code pushed { ..., type: 'raised_hand' } inside pollReactions. Hand tracking is
    // pollHandRaises' job (which legitimately scrapes raised-hand DOM); the reaction path must
    // not fabricate hand reactions.
    expect(src).not.toContain("type: 'raised_hand'");
    // The reactions filter `if (r.type !== 'raised_hand')` guard is likewise gone.
    expect(src).not.toContain("!== 'raised_hand'");
  });
});
