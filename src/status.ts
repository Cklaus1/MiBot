// status.ts — canonical status enums and state machine (AR2, hardening OQ3).
//
// Two independent lifecycles:
//   recording (per-recording row): recording → recorded → {done | transcribe_failed}
//                                  plus terminal short-circuits no_audio and failed
//   meeting   (per-meeting row):   scheduled → joining → in_call → processing → done
//                                  plus failed/missed exits
//
// The C7 rule lives here: a terminal recording status must NEVER be downgraded to
// 'failed' by a post-processing catch-all. `reconcileRecordingStatus` is the single
// choke point every catch handler routes through.

export const RECORDING_STATUS = {
  RECORDING: 'recording',
  RECORDED: 'recorded',
  DONE: 'done',
  TRANSCRIBE_FAILED: 'transcribe_failed',
  NO_AUDIO: 'no_audio',
  FAILED: 'failed',
} as const;

export type RecordingStatus =
  (typeof RECORDING_STATUS)[keyof typeof RECORDING_STATUS];

export const MEETING_STATUS = {
  SCHEDULED: 'scheduled',
  JOINING: 'joining',
  IN_CALL: 'in_call',
  PROCESSING: 'processing',
  DONE: 'done',
  FAILED: 'failed',
  MISSED: 'missed',
  // CA2: the organizer cancelled the event before it started (its id left the sync window
  // while still 'scheduled'). Terminal — MiBot must not join it.
  CANCELLED: 'cancelled',
} as const;

export type MeetingStatus =
  (typeof MEETING_STATUS)[keyof typeof MEETING_STATUS];

const TERMINAL_RECORDING: ReadonlySet<RecordingStatus> = new Set([
  RECORDING_STATUS.DONE,
  RECORDING_STATUS.TRANSCRIBE_FAILED,
  RECORDING_STATUS.NO_AUDIO,
  RECORDING_STATUS.FAILED,
]);

const RECORDING_TRANSITIONS: Readonly<Record<RecordingStatus, readonly RecordingStatus[]>> = {
  recording: ['recorded', 'no_audio', 'failed'],
  recorded: ['done', 'transcribe_failed', 'failed'],
  done: [],
  transcribe_failed: [],
  no_audio: [],
  failed: [],
};

const TERMINAL_MEETING: ReadonlySet<MeetingStatus> = new Set([
  MEETING_STATUS.DONE,
  MEETING_STATUS.FAILED,
  MEETING_STATUS.MISSED,
  MEETING_STATUS.CANCELLED,
]);

const MEETING_TRANSITIONS: Readonly<Record<MeetingStatus, readonly MeetingStatus[]>> = {
  scheduled: ['joining', 'missed', 'failed', 'cancelled'],
  joining: ['in_call', 'failed', 'missed'],
  in_call: ['processing', 'failed'],
  processing: ['done', 'failed'],
  done: [],
  failed: [],
  missed: [],
  cancelled: [],
};

export function isTerminalRecordingStatus(s: RecordingStatus): boolean {
  return TERMINAL_RECORDING.has(s);
}

export function isTerminalMeetingStatus(s: MeetingStatus): boolean {
  return TERMINAL_MEETING.has(s);
}

export function canTransitionRecording(from: RecordingStatus, to: RecordingStatus): boolean {
  return RECORDING_TRANSITIONS[from]?.includes(to) ?? false;
}

export function canTransitionMeeting(from: MeetingStatus, to: MeetingStatus): boolean {
  return MEETING_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * C7 choke point: given the recording's current status and the status a catch-all
 * *wants* to write, return the status that should actually be persisted. A terminal
 * status is never overwritten by 'failed' (that would destroy the real outcome);
 * a non-terminal status is allowed to fail.
 */
export function reconcileRecordingStatus(
  current: RecordingStatus,
  desired: RecordingStatus,
): RecordingStatus {
  if (desired === RECORDING_STATUS.FAILED && isTerminalRecordingStatus(current)) {
    return current;
  }
  return desired;
}
