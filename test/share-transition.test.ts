import { describe, it, expect } from 'vitest';
import { shareTransition } from '../src/signals.js';

// M13: presenter handoff within one poll gap. The old logic had only two branches — start
// (sharing && !current) and end (!sharing && current). When A stops and B starts sharing between
// two polls, `sharing` is truthy (now B) and `currentShare` is truthy (A), so NEITHER branch
// fired: B's whole share (and its screenshots) got attributed to A, and B never got a start row.
// shareTransition adds the handoff case: close A, open B.
describe('M13 shareTransition (presenter state machine)', () => {
  it('no share, nobody presenting → none', () => {
    expect(shareTransition(null, null)).toEqual({ kind: 'none' });
  });

  it('nobody presenting → someone starts → start', () => {
    expect(shareTransition('Ada', null)).toEqual({ kind: 'start', presenter: 'Ada' });
  });

  it('presenter stops → end', () => {
    expect(shareTransition(null, 'Ada')).toEqual({ kind: 'end' });
  });

  it('same presenter continues → none (no spurious transition)', () => {
    expect(shareTransition('Ada', 'Ada')).toEqual({ kind: 'none' });
  });

  it('presenter handoff A→B within one poll gap → handoff (close A, open B)', () => {
    expect(shareTransition('Bo', 'Ada')).toEqual({ kind: 'handoff', presenter: 'Bo' });
  });
});
