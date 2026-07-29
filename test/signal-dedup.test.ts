import { describe, it, expect } from 'vitest';
import { OccurrenceDeduper } from '../src/signal-dedup.js';

// F9/R11 (M4): chat dedup must key on stable content + a per-(sender,text) occurrence
// counter — NOT the DOM index, which shifts under Teams/Zoom chat virtualization and
// re-hashes the whole visible window as "new".
describe('OccurrenceDeduper (R11 / M4)', () => {
  const key = (m: { sender: string; text: string }) => `${m.sender}::${m.text}`;

  it('returns all items on first sight', () => {
    const d = new OccurrenceDeduper(key);
    const batch = [{ sender: 'A', text: 'hi' }, { sender: 'B', text: 'yo' }];
    expect(d.add(batch)).toEqual(batch);
  });

  it('re-scraping the same window yields nothing new', () => {
    const d = new OccurrenceDeduper(key);
    const batch = [{ sender: 'A', text: 'hi' }, { sender: 'B', text: 'yo' }];
    d.add(batch);
    expect(d.add(batch)).toEqual([]);
  });

  it('is stable under virtualization: window scrolls but content is unchanged', () => {
    const d = new OccurrenceDeduper(key);
    d.add([{ sender: 'A', text: '1' }, { sender: 'A', text: '2' }, { sender: 'A', text: '3' }]);
    // window scrolled — now only the last two are visible (indices shifted)
    expect(d.add([{ sender: 'A', text: '2' }, { sender: 'A', text: '3' }])).toEqual([]);
  });

  it('counts a genuinely repeated identical message as new (occurrence 2)', () => {
    const d = new OccurrenceDeduper(key);
    d.add([{ sender: 'A', text: 'lol' }]);
    // A says "lol" again in a later poll — the window now shows two "lol"s from A
    const out = d.add([{ sender: 'A', text: 'lol' }, { sender: 'A', text: 'lol' }]);
    expect(out).toEqual([{ sender: 'A', text: 'lol' }]);
  });

  it('does not re-emit old messages that scrolled out of the window', () => {
    const d = new OccurrenceDeduper(key);
    d.add([{ sender: 'A', text: 'a' }, { sender: 'A', text: 'b' }]);
    // 'a' scrolled away, only 'b' visible — nothing new, and 'a' must not reappear later
    expect(d.add([{ sender: 'A', text: 'b' }])).toEqual([]);
    expect(d.add([{ sender: 'A', text: 'a' }, { sender: 'A', text: 'b' }])).toEqual([]);
  });

  it('treats identical text from different senders independently', () => {
    const d = new OccurrenceDeduper(key);
    d.add([{ sender: 'A', text: 'hi' }]);
    expect(d.add([{ sender: 'A', text: 'hi' }, { sender: 'B', text: 'hi' }]))
      .toEqual([{ sender: 'B', text: 'hi' }]);
  });
});
