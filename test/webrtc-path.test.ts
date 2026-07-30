import { describe, it, expect } from 'vitest';
import { webrtcAudioPathFor } from '../src/audio.js';

// AU13 (polish, NOT a bug in practice): the derivation `audioPath.replace('.webm','-webrtc.webm')`
// was triplicated (audio.ts, capture-session.ts, bot.ts) and unanchored — a `.webm` anywhere in
// the path (e.g. a directory named `x.webم/`) would be rewritten mid-string. One anchored helper.
describe('AU13 webrtcAudioPathFor', () => {
  it('derives a distinct sibling path from a .webm audio path', () => {
    const a = '/rec/meeting-123.webm';
    const w = webrtcAudioPathFor(a);
    expect(w).toBe('/rec/meeting-123-webrtc.webm');
    expect(w).not.toBe(a); // always distinct — never clobbers the source
  });

  it('only rewrites the trailing .webm, not an earlier occurrence in the path', () => {
    const a = '/data/x.webm.d/meeting.webm';
    expect(webrtcAudioPathFor(a)).toBe('/data/x.webm.d/meeting-webrtc.webm');
  });

  it('appends the suffix if the path does not end in .webm (still distinct)', () => {
    const a = '/rec/meeting.mkv';
    const w = webrtcAudioPathFor(a);
    expect(w).not.toBe(a);
    expect(w).toContain('-webrtc');
  });
});
