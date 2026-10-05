import { describe, it, expect } from 'vitest';
import { meetingSpeakerTalk, chooseSpeakerLabel } from '../src/transcribe.js';

// Wave 9-D: auto-labeling chose among EVERY unlabeled identity in the shared, cumulative
// speaker_identities.json and ranked by lifetime call counts — so it could put this meeting's
// one name on a stranger from another meeting, and the wrong name then propagated to every
// later transcript. Now only clusters that spoke IN THIS MEETING are eligible, ranked by talk
// time in this meeting, with guards that prefer "no label" over a guess.

const p = (name: string, extra: object = {}) => ({ name, joined_at: 'a', left_at: 'b', is_bot: false, spoke: true, ...extra });
const ids = (o: Record<string, string | null>) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { canonical_name: v, total_calls: 99 }]));

describe('meetingSpeakerTalk', () => {
  it('sums each cluster\'s talk seconds from the transcript segments', () => {
    const t = { segments: [
      { start: 0, end: 10, speaker_cluster_id: 'spk_a' },
      { start: 10, end: 12, speaker_cluster_id: 'spk_b' },
      { start: 12, end: 20, speaker_cluster_id: 'spk_a' },
      { start: 20, end: 21 }, // undiarized segment
    ] };
    expect(meetingSpeakerTalk(t)).toEqual(new Map([['spk_a', 18], ['spk_b', 2]]));
  });

  it('includes resolved speakers even if they have no segment', () => {
    const t = { segments: [], diarization: { speakers_resolved: [{ speaker_cluster_id: 'spk_z' }] } };
    expect(meetingSpeakerTalk(t)).toEqual(new Map([['spk_z', 0]]));
  });

  it('no diarization → empty', () => expect(meetingSpeakerTalk({ segments: [{ start: 0, end: 1 }] }).size).toBe(0));
});

describe('chooseSpeakerLabel', () => {
  it('ignores unlabeled clusters from OTHER meetings (the bug)', () => {
    // spk_old is unlabeled with a huge lifetime count but never spoke here.
    const r = chooseSpeakerLabel({
      identities: { ...ids({ spk_here: null }), spk_old: { canonical_name: null, total_calls: 500 } },
      talk: new Map([['spk_here', 30]]),
      participants: [p('Ann')],
    });
    expect(r).toEqual({ clusterId: 'spk_here', name: 'Ann' });
  });

  it('no per-meeting speaker data → no label (never fall back to the cumulative DB)', () => {
    expect(chooseSpeakerLabel({ identities: ids({ spk_x: null }), talk: new Map(), participants: [p('Ann')] }))
      .toMatchObject({ skip: 'no-diarization' });
  });

  it('a name already on another speaker in this meeting is not a candidate', () => {
    // Bob is already labeled and spoke; the remaining unlabeled voice must be Ann.
    const r = chooseSpeakerLabel({
      identities: ids({ spk_b: 'Bob', spk_u: null }),
      talk: new Map([['spk_b', 40], ['spk_u', 20]]),
      participants: [p('Ann'), p('Bob')],
    });
    expect(r).toEqual({ clusterId: 'spk_u', name: 'Ann' });
  });

  it('more voices than the roster accounts for → roster incomplete → no label', () => {
    const r = chooseSpeakerLabel({
      identities: ids({ spk_1: null, spk_2: 'Bob', spk_3: 'Cy' }),
      talk: new Map([['spk_1', 10], ['spk_2', 10], ['spk_3', 10]]),
      participants: [p('Ann')], // the scraper only found one person
    });
    expect(r).toMatchObject({ skip: 'roster-incomplete' });
  });

  it('one name, several unlabeled voices: labels the dominant voice of THIS meeting', () => {
    const r = chooseSpeakerLabel({
      identities: ids({ spk_a: null, spk_b: null }),
      talk: new Map([['spk_a', 300], ['spk_b', 20]]),
      participants: [p('Ann'), p('Guest', { spoke: false })],
    });
    expect(r).toEqual({ clusterId: 'spk_a', name: 'Ann' });
  });

  it('…but not when no voice clearly dominates', () => {
    const r = chooseSpeakerLabel({
      identities: ids({ spk_a: null, spk_b: null }),
      talk: new Map([['spk_a', 100], ['spk_b', 80]]),
      participants: [p('Ann'), p('Guest', { spoke: false })],
    });
    expect(r).toMatchObject({ skip: 'ambiguous' });
  });

  it('bots are never candidates', () => {
    const r = chooseSpeakerLabel({
      identities: ids({ spk_a: null }),
      talk: new Map([['spk_a', 10]]),
      participants: [p('Notetaker', { is_bot: true }), p('Ann')],
    });
    expect(r).toEqual({ clusterId: 'spk_a', name: 'Ann' });
  });

  it('everyone here already labeled → nothing to do', () => {
    expect(chooseSpeakerLabel({ identities: ids({ spk_a: 'Ann' }), talk: new Map([['spk_a', 5]]), participants: [p('Ann')] }))
      .toMatchObject({ skip: 'all-labeled' });
  });

  it('a cluster absent from the identity DB is not labelable', () => {
    expect(chooseSpeakerLabel({ identities: {}, talk: new Map([['spk_ghost', 5]]), participants: [p('Ann')] }))
      .toMatchObject({ skip: 'all-labeled' });
  });
});
