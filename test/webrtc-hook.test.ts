import { describe, it, expect, afterEach } from 'vitest';
import { audioCaptureHook } from '../src/webrtc-capture.js';

// FA/R4 + AU1 (P0) + AU2 (P1): there used to be TWO injectors — a main-frame one that created
// `__mibotFlushedChunks` (the array flushAudioToDisk reads) and a SEPARATE iframe copy that
// omitted it. Zoom's WebRTC lives in an iframe, so its capture went through the copy → the
// flushed-chunks array was never created → flushAudioToDisk read `undefined` and returned '' for
// the whole meeting (silent no-audio). There is now ONE hook function, installed via
// context.addInitScript so it runs identically in the main frame AND every iframe, AND survives
// the navigation that used to destroy a page.evaluate() hook (AU2).
//
// We exercise that single hook against fake WebRTC/media globals and assert the flush machinery
// is always wired — the exact thing the iframe copy dropped.

/** Build a browser-like `window` with just enough WebRTC/media surface for the hook. */
function makeFakeWindow() {
  const intervals: Array<() => void> = [];
  class FakeRTCPeerConnection {
    private listeners: Record<string, Function[]> = {};
    addEventListener(type: string, fn: Function) { (this.listeners[type] ||= []).push(fn); }
    _emit(type: string, ev: any) { (this.listeners[type] || []).forEach((f) => f(ev)); }
  }
  class FakeAudioContext {
    createMediaStreamDestination() { return { stream: { __dest: true } }; }
    createMediaStreamSource() { return { connect() {} }; }
  }
  class FakeMediaRecorder {
    state = 'recording';
    ondataavailable: ((e: any) => void) | null = null;
    constructor(public stream: any, public opts: any) {}
    start() {}
    stop() {}
  }
  const win: any = {
    RTCPeerConnection: FakeRTCPeerConnection,
    AudioContext: FakeAudioContext,
    webkitAudioContext: FakeAudioContext,
    MediaStream: class { constructor(public tracks: any[]) {} },
    MediaRecorder: FakeMediaRecorder,
    setInterval: (fn: () => void) => { intervals.push(fn); return intervals.length; },
    clearInterval: () => {},
    console: { log() {} },
    _fireIntervals: () => intervals.forEach((fn) => fn()),
  };
  return win;
}

/** Run the self-contained hook with `window` bound to our fake, the way addInitScript would. */
function installHook(win: any) {
  (globalThis as any).window = win;
  try { audioCaptureHook(); } finally { delete (globalThis as any).window; }
}

afterEach(() => { delete (globalThis as any).window; });

describe('FA/R4 unified WebRTC capture hook', () => {
  it('is idempotent — a second install is a no-op (__mibotHooked guard)', () => {
    const win = makeFakeWindow();
    const firstCtor = win.RTCPeerConnection;
    installHook(win);
    const wrapped = win.RTCPeerConnection;
    expect(wrapped).not.toBe(firstCtor); // hook replaced the ctor
    installHook(win);
    expect(win.RTCPeerConnection).toBe(wrapped); // second install did nothing
  });

  it('creates __mibotFlushedChunks when a remote audio track arrives (the AU1 fix)', () => {
    const win = makeFakeWindow();
    installHook(win);
    const pc: any = new win.RTCPeerConnection();
    pc._emit('track', { track: { kind: 'audio' } });
    // The exact thing the old iframe copy never did:
    expect(Array.isArray(win.__mibotFlushedChunks)).toBe(true);
  });

  it('the flush interval moves recorded chunks into __mibotFlushedChunks', () => {
    const win = makeFakeWindow();
    installHook(win);
    const pc: any = new win.RTCPeerConnection();
    pc._emit('track', { track: { kind: 'audio' } });
    // Simulate the MediaRecorder producing a chunk
    win.__mibotChunks.push({ size: 10 });
    win._fireIntervals();
    expect(win.__mibotFlushedChunks.length).toBe(1);
  });

  it('ignores non-audio tracks (no recorder, no flush array)', () => {
    const win = makeFakeWindow();
    installHook(win);
    const pc: any = new win.RTCPeerConnection();
    pc._emit('track', { track: { kind: 'video' } });
    expect(win.__mibotRecorder).toBeUndefined();
    expect(win.__mibotFlushedChunks).toBeUndefined();
  });

  it('a returned peer connection is still a usable RTCPeerConnection instance', () => {
    const win = makeFakeWindow();
    installHook(win);
    const pc: any = new win.RTCPeerConnection();
    expect(typeof pc.addEventListener).toBe('function');
  });
});
