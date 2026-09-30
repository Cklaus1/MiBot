import { describe, it, expect } from 'vitest';
import { parsePeopleCount, camofoxHumanCount } from '../src/bot.js';
import { LeavePolicy } from '../src/leave-policy.js';

// M15: the Camofox/Meet monitor loop had NO alone-detection — it broke only on maxDuration or
// the "Leave call" button vanishing, so a Meet call everyone left recorded silence for up to 4h.
// The fix feeds the People-panel count (minus the bot itself) into the same LeavePolicy the
// Playwright path uses. These pure helpers extract + normalize that count so the gate is testable.
describe('parsePeopleCount (M15 snapshot → count)', () => {
  it('extracts the People button count from a Meet a11y snapshot', () => {
    expect(parsePeopleCount('button "People" [ref=e12]: "3"')).toBe(3);
  });

  it('returns null when the People button is absent', () => {
    expect(parsePeopleCount('button "Chat" [ref=e1]: "0"')).toBeNull();
  });
});

describe('camofoxHumanCount (M15 subtract self)', () => {
  it('subtracts the bot from the People count', () => {
    expect(camofoxHumanCount(3)).toBe(2);
  });

  it('clamps at 0 when only the bot remains', () => {
    expect(camofoxHumanCount(1)).toBe(0);
    expect(camofoxHumanCount(0)).toBe(0);
  });

  it('returns null when count is null (unknown — do not trigger a false alone-exit)', () => {
    expect(camofoxHumanCount(null)).toBeNull();
  });
});

// M15 integration: the exact composition the camofox loop uses — snapshot → People count →
// human count → LeavePolicy. The hardening spec's required scenario: a People-count sequence
// of [2,0,0,0] must exit the loop via the grace period. (Bot counts itself, so People=2 means
// 1 human; People=0 means fully empty.) Snapshots without a People button leave the last known
// count in force rather than fabricating 0.
describe('M15 camofox loop leaves when everyone drops out', () => {
  const cfg = {
    minHumansToStay: 0,
    aloneTimeoutMs: 5 * 60 * 1000,
    leaveGracePeriodMs: 10 * 1000, // 10s grace
    maxDurationMs: 4 * 60 * 60 * 1000,
    leaveButtonMissesToEnd: 2,
    emptyPollsToTrigger: 2,
  };

  function snapForPeople(n: number): string {
    return `button "People" [ref=e9]: "${n}"`;
  }

  it('exits via grace once People drops to 0 and stays there ([2,0,0,…])', () => {
    const start = 0;
    const policy = new LeavePolicy(cfg, start);
    // People goes 2 → 0 and stays 0. At a 5s cadence with a 10s grace, the grace clock starts
    // at the second empty poll and expires two polls later — so the exit is a few polls after
    // the drop, never on the first empty frame (that guards against a one-frame UI glitch).
    const peopleSeq = [2, 0, 0, 0, 0, 0];
    let leftReason: string | null = null;
    let leftAtPoll = -1;

    for (let i = 0; i < peopleSeq.length; i++) {
      const nowMs = start + i * 5000; // 5s poll cadence
      const humans = camofoxHumanCount(parsePeopleCount(snapForPeople(peopleSeq[i])));
      // Unknown count → keep 1 (stay); loop still shows the Leave button.
      const decision = policy.observe({ humanCount: humans ?? 1, hasLeaveButton: true }, nowMs);
      if (decision.action === 'leave') {
        leftReason = decision.reason;
        leftAtPoll = i;
        break;
      }
    }

    expect(leftReason).toBe('grace-expired');
    expect(leftAtPoll).toBeGreaterThanOrEqual(2); // never on the first empty frame
  });

  it('does NOT leave while a human remains (People stays 2)', () => {
    const policy = new LeavePolicy(cfg, 0);
    let left = false;
    for (let i = 0; i < 10; i++) {
      const humans = camofoxHumanCount(parsePeopleCount(snapForPeople(2)));
      const d = policy.observe({ humanCount: humans ?? 1, hasLeaveButton: true }, i * 5000);
      if (d.action === 'leave') left = true;
    }
    expect(left).toBe(false);
  });
});

// Item 1: the original single pattern was written against no recorded snapshot — none has
// ever been captured from a live Meet call. A miss is SILENT (lastKnownHumanCount keeps its
// 1-human default, so M15's alone-detection never fires and the bot records an empty room to
// maxDuration), so the parser now accepts the plausible renderings instead of betting on one.
describe('parsePeopleCount tolerance (item 1)', () => {
  const cases: [string, string, number][] = [
    ['value after the ref', 'button "People" [ref=e12]: "3"', 3],
    ['count inlined in the label', 'button "People (4)" [ref=e12]', 4],
    ['aria-label with participants', 'button "5 participants" [ref=e9]', 5],
    ['aria-label singular', 'button "1 participant" [ref=e9]', 1],
    ['aria-label people wording', 'button "7 people" [ref=e9]', 7],
  ];

  // Regression: a catch-all pattern read snapshot ATTRIBUTE digits as the count. A count of 1
  // is 0 humans, so these produced a false alone-exit on a real meeting. Unknown must stay null.
  for (const snap of [
    'button "People" [e7] [nth=1]',
    'button "People" [level=2]',
    'button "People" [ref=e12] badge=2',
  ]) {
    it(`does not read attribute digits as a count: ${snap}`, () => expect(parsePeopleCount(snap)).toBeNull());
  }
  for (const [name, snap, want] of cases) {
    it(`parses: ${name}`, () => expect(parsePeopleCount(snap)).toBe(want));
  }

  it('still returns null when there is no People control at all', () => {
    expect(parsePeopleCount('button "Chat" [ref=e1]: "9"\nbutton "Raise hand" [ref=e2]')).toBeNull();
  });

  it('does not mistake another control\'s count for the People count', () => {
    expect(parsePeopleCount('button "Chat" [ref=e1]: "8"')).toBeNull();
  });

  it('picks the People line out of a realistic multi-line snapshot', () => {
    const snap = [
      'generic [ref=e1]',
      '  button "Chat with everyone" [ref=e10]: "2"',
      '  button "People" [ref=e12]: "3"',
      '  button "Leave call" [ref=e14]',
    ].join('\n');
    expect(parsePeopleCount(snap)).toBe(3);
    expect(camofoxHumanCount(parsePeopleCount(snap))).toBe(2);
  });
});
