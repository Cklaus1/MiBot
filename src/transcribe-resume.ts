import fs from 'fs';
import {
  applyRecordingStatus, updateMeetingStatus, updateHeartbeat, type TranscriptionJob,
} from './db.js';
import { transcribe as realTranscribe } from './transcribe.js';
import { RECORDING_STATUS, type RecordingStatus } from './status.js';

/**
 * Wave 9-B: resume a transcription that a crash interrupted.
 *
 * Retries exist for CRASHES (the process died mid-run), not for transcription errors —
 * transcribe() already turns a failed audioscript run into a terminal 'transcribe_failed'. The
 * attempt cap is what stops a crash-loop: if transcribing this file kills the process every time
 * (OOM on a huge recording), we give up after MAX_TRANSCRIBE_ATTEMPTS instead of dying forever.
 */
export const MAX_TRANSCRIBE_ATTEMPTS = 3;

export interface ResumeDeps {
  transcribe?: (recordingId: number, audioPath: string, participants: any[], timeline: any[]) => Promise<RecordingStatus>;
  heartbeat?: (meetingId: number) => void;
  heartbeatMs?: number;
}

export async function resumeTranscription(job: TranscriptionJob, deps: ResumeDeps = {}): Promise<void> {
  const transcribe = deps.transcribe ?? realTranscribe;
  const heartbeat = deps.heartbeat ?? updateHeartbeat;

  if (job.attempts > MAX_TRANSCRIBE_ATTEMPTS) {
    console.error(`[mibot] Transcription of recording ${job.recordingId} crashed ${MAX_TRANSCRIBE_ATTEMPTS} times — giving up`);
    applyRecordingStatus(job.recordingId, RECORDING_STATUS.TRANSCRIBE_FAILED);
    updateMeetingStatus(job.meetingId, 'done'); // the meeting itself completed; only transcription didn't
    return;
  }
  if (!fs.existsSync(job.audioPath)) {
    console.error(`[mibot] Cannot resume transcription: audio missing at ${job.audioPath}`);
    applyRecordingStatus(job.recordingId, RECORDING_STATUS.FAILED);
    updateMeetingStatus(job.meetingId, 'failed');
    return;
  }

  console.error(`[mibot] Resuming interrupted transcription (attempt ${job.attempts}/${MAX_TRANSCRIBE_ATTEMPTS}): ${job.audioPath}`);
  // Keep the row live for the whole run, exactly like a bot's own post-processing does.
  const timer = setInterval(() => { try { heartbeat(job.meetingId); } catch { /* next tick */ } }, deps.heartbeatMs ?? 10000);
  try {
    const outcome = await transcribe(job.recordingId, job.audioPath, job.participants, job.speakerTimeline);
    applyRecordingStatus(job.recordingId, outcome);
    updateMeetingStatus(job.meetingId, 'done');
  } catch (err) {
    // Leave it 'recorded'/'processing': once our heartbeat stops it goes stale and is reclaimed.
    console.error(`[mibot] Resumed transcription threw: ${(err as Error).message}`);
  } finally {
    clearInterval(timer);
  }
}
