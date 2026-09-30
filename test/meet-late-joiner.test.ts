import { describe, it, expect } from 'vitest';
import vm from 'vm';
import { CAMOFOX_WEBRTC_HOOK } from '../src/camofox.js';
import { AUDIO_ELEMENT_CAPTURE } from '../src/bot.js';

/**
 * Fix 5 (P1): on Meet, if the <audio>-element fallback started the recorder (it runs ~5s after
 * join, often before any RTC audio track has arrived), it set __mibotAudioCtx but never
 * __mibotDest. Every later `track` event then found the context already present, skipped its
 * setup, and called source.connect(undefined) — which throws. So anyone who joined after the
 * fallback fired was never recorded.
 *
 * These tests EXECUTE the real in-page scripts in a vm sandbox with fake Web Audio / WebRTC
 * objects, so they check behaviour, not string contents.
 */
function makePage(audioElementCount: number) {
  const sources: any[] = [];
  const recorders: any[] = [];
  const listenerErrors: Error[] = [];

  class FakeCtx {
    createMediaStreamDestination() { return { stream: { id: Symbol('dest-stream') } }; }
    createMediaStreamSource(stream: unknown) {
      const src = {
        stream, connectedTo: null as any,
        connect(d: any) { if (!d) throw new TypeError('Failed to execute connect: parameter 1 is not of type AudioNode'); this.connectedTo = d; },
      };
      sources.push(src);
      return src;
    }
  }
  class FakeRecorder {
    state = 'inactive'; ondataavailable: unknown = null;
    constructor(public stream: unknown) { recorders.push(this); }
    start() { this.state = 'recording'; }
  }
  class FakeRTC {
    listeners: Record<string, Function[]> = {};
    addEventListener(t: string, f: Function) { (this.listeners[t] ||= []).push(f); }
    fire(t: string, e: unknown) {
      // A real browser swallows (and logs) a throwing listener; capture it instead.
      for (const f of this.listeners[t] || []) { try { f(e); } catch (err) { listenerErrors.push(err as Error); } }
    }
  }
  const audioEls = Array.from({ length: audioElementCount }, () => ({ captureStream: () => ({ id: Symbol('el') }) }));

  const sandbox: any = {
    RTCPeerConnection: FakeRTC, AudioContext: FakeCtx, MediaRecorder: FakeRecorder,
    MediaStream: class { constructor(public tracks: unknown[]) {} },
    document: { querySelectorAll: () => audioEls },
    setInterval: () => 1, clearInterval: () => {},
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  const run = (code: string) => vm.runInContext(code, sandbox);
  const newPeer = () => run('new window.RTCPeerConnection()') as FakeRTC;
  const audioTrack = () => ({ track: { kind: 'audio' } });
  return { run, newPeer, audioTrack, sources, recorders, listenerErrors, win: sandbox };
}

describe('Meet late joiners are recorded (fix 5)', () => {
  it('fallback-first: a track arriving AFTER the fallback feeds the fallback\'s recorder', () => {
    const p = makePage(1);
    p.run(CAMOFOX_WEBRTC_HOOK);
    const pc = p.newPeer();                      // the call's peer connection exists...
    expect(p.run(AUDIO_ELEMENT_CAPTURE)).toMatch(/^capturing/); // ...but no track yet: fallback wins
    expect(p.recorders).toHaveLength(1);

    pc.fire('track', p.audioTrack());            // someone joins late

    expect(p.listenerErrors).toEqual([]);        // was: TypeError from connect(undefined)
    const late = p.sources[p.sources.length - 1];
    expect(late.connectedTo).toBeTruthy();
    expect(late.connectedTo.stream).toBe(p.recorders[0].stream); // into the RUNNING recorder
    expect(p.recorders).toHaveLength(1);         // and no second, competing recorder
  });

  it('several late joiners all land in the one recorder', () => {
    const p = makePage(2);
    p.run(CAMOFOX_WEBRTC_HOOK);
    const pc = p.newPeer();
    p.run(AUDIO_ELEMENT_CAPTURE);
    for (let i = 0; i < 3; i++) pc.fire('track', p.audioTrack());
    expect(p.listenerErrors).toEqual([]);
    const recorded = p.recorders[0].stream;
    expect(p.sources.every((s) => s.connectedTo?.stream === recorded)).toBe(true);
    expect(p.win.__mibotSources).toHaveLength(3);
  });

  it('rtc-first (the normal path) is unchanged: later tracks join the same destination', () => {
    const p = makePage(1);
    p.run(CAMOFOX_WEBRTC_HOOK);
    const pc = p.newPeer();
    pc.fire('track', p.audioTrack());
    expect(p.run(AUDIO_ELEMENT_CAPTURE)).toBe('rtc hook active');
    pc.fire('track', p.audioTrack());
    expect(p.listenerErrors).toEqual([]);
    expect(p.recorders).toHaveLength(1);
    expect(p.sources.every((s) => s.connectedTo?.stream === p.recorders[0].stream)).toBe(true);
  });

  it('the hook stores its flush interval so the AU3 stop-and-fold can clear it', () => {
    const p = makePage(0);
    p.run(CAMOFOX_WEBRTC_HOOK);
    p.newPeer().fire('track', p.audioTrack());
    expect(p.win.__mibotFlushInterval).toBeDefined();
  });
});
