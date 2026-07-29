import { describe, it, expect } from 'vitest';
import {
  RECORDING_STATUS,
  MEETING_STATUS,
  isTerminalRecordingStatus,
  canTransitionRecording,
  canTransitionMeeting,
  reconcileRecordingStatus,
} from '../src/status.js';

describe('status enums (OQ3 canon)', () => {
  it('exposes the canonical recording statuses', () => {
    expect(new Set(Object.values(RECORDING_STATUS))).toEqual(
      new Set(['recording', 'recorded', 'done', 'transcribe_failed', 'no_audio', 'failed']),
    );
  });

  it('exposes the canonical meeting statuses', () => {
    expect(new Set(Object.values(MEETING_STATUS))).toEqual(
      new Set(['scheduled', 'joining', 'in_call', 'processing', 'done', 'failed', 'missed', 'cancelled']),
    );
  });
});

describe('recording state machine', () => {
  it('recording → recorded is legal', () => {
    expect(canTransitionRecording('recording', 'recorded')).toBe(true);
  });

  it('recorded → done and recorded → transcribe_failed are legal', () => {
    expect(canTransitionRecording('recorded', 'done')).toBe(true);
    expect(canTransitionRecording('recorded', 'transcribe_failed')).toBe(true);
  });

  it('recording → no_audio and recording → failed are legal', () => {
    expect(canTransitionRecording('recording', 'no_audio')).toBe(true);
    expect(canTransitionRecording('recording', 'failed')).toBe(true);
  });

  it('cannot resurrect a terminal status', () => {
    expect(canTransitionRecording('done', 'recording')).toBe(false);
    expect(canTransitionRecording('done', 'failed')).toBe(false);
    expect(canTransitionRecording('no_audio', 'recorded')).toBe(false);
  });
});

describe('terminal recording statuses (C7 rule)', () => {
  it('done, transcribe_failed, no_audio, failed are terminal', () => {
    for (const s of ['done', 'transcribe_failed', 'no_audio', 'failed'] as const) {
      expect(isTerminalRecordingStatus(s)).toBe(true);
    }
  });

  it('recording and recorded are NOT terminal', () => {
    expect(isTerminalRecordingStatus('recording')).toBe(false);
    expect(isTerminalRecordingStatus('recorded')).toBe(false);
  });

  // C7: a post-processing catch-all must never downgrade a terminal recording status
  // (e.g. an already-'done' or 'no_audio' recording) to 'failed'.
  it('reconcile refuses to overwrite a terminal status with failed', () => {
    expect(reconcileRecordingStatus('done', 'failed')).toBe('done');
    expect(reconcileRecordingStatus('no_audio', 'failed')).toBe('no_audio');
    expect(reconcileRecordingStatus('transcribe_failed', 'failed')).toBe('transcribe_failed');
  });

  it('reconcile applies failed only when the current status is non-terminal', () => {
    expect(reconcileRecordingStatus('recording', 'failed')).toBe('failed');
    expect(reconcileRecordingStatus('recorded', 'failed')).toBe('failed');
  });
});

describe('meeting state machine', () => {
  it('walks the happy path scheduled → … → done', () => {
    expect(canTransitionMeeting('scheduled', 'joining')).toBe(true);
    expect(canTransitionMeeting('joining', 'in_call')).toBe(true);
    expect(canTransitionMeeting('in_call', 'processing')).toBe(true);
    expect(canTransitionMeeting('processing', 'done')).toBe(true);
  });

  it('allows failed/missed from pre-call states', () => {
    expect(canTransitionMeeting('scheduled', 'missed')).toBe(true);
    expect(canTransitionMeeting('joining', 'failed')).toBe(true);
    expect(canTransitionMeeting('in_call', 'failed')).toBe(true);
  });

  it('cannot leave a terminal meeting status', () => {
    expect(canTransitionMeeting('done', 'in_call')).toBe(false);
    expect(canTransitionMeeting('missed', 'joining')).toBe(false);
  });
});
