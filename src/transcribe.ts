import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import { updateRecording, type Participant, type SpeakerSegment } from './db.js';

const execFileAsync = promisify(execFile);

export async function transcribe(
  recordingId: number,
  audioPath: string,
  participants: Participant[],
  speakerTimeline: SpeakerSegment[],
): Promise<void> {
  if (!fs.existsSync(audioPath) || fs.statSync(audioPath).size === 0) {
    console.error('[mibot] No audio to transcribe');
    return;
  }

  // Run audioscript from the audio file's directory (it requires relative paths)
  const audioDir = path.dirname(audioPath);
  const audioFile = path.basename(audioPath);

  console.error('[mibot] Transcribing via audioscript...');
  try {
    const { stdout } = await execFileAsync('audioscript', [
      'transcribe', '--diarize', '-i', audioFile,
    ], { timeout: 30 * 60 * 1000, cwd: audioDir, env: { ...process.env } });

    // Find the output directory
    const outputMatch = stdout.match(/"output_dir":\s*"([^"]+)"/);
    const outputDir = outputMatch ? path.resolve(audioDir, outputMatch[1]) : path.join(audioDir, 'output');

    // Find transcript file
    const mdFile = path.join(outputDir, audioFile.replace(/\.\w+$/, '.md'));
    if (fs.existsSync(mdFile)) {
      updateRecording(recordingId, { transcript_path: mdFile });
      console.error(`[mibot] Transcript: ${mdFile}`);
    }

    // Auto-label speakers using meeting participant list
    const speakerDbPath = path.join(outputDir, 'speaker_identities.json');
    if (fs.existsSync(speakerDbPath)) {
      await autoLabelSpeakers(speakerDbPath, participants, speakerTimeline, audioDir);
    }
  } catch (err) {
    const stderr = (err as any).stderr || '';
    console.error(`[mibot] Transcription failed: ${(err as Error).message}${stderr ? '\n' + stderr : ''}`);
    updateRecording(recordingId, { status: 'transcribe_failed' });
  }
}

/**
 * Auto-label speaker clusters using meeting participant data.
 *
 * Strategy:
 * 1. If only 1 unknown speaker and 1 human participant -> direct match
 * 2. If speaker timeline from MiBot overlaps with diarization segments -> match by timing
 * 3. Otherwise, leave for manual review
 */
export async function autoLabelSpeakers(
  speakerDbPath: string,
  participants: Participant[],
  speakerTimeline: SpeakerSegment[],
  cwd: string,
): Promise<void> {
  try {
    const db = JSON.parse(fs.readFileSync(speakerDbPath, 'utf8'));
    const identities = db.identities || {};

    // Find unlabeled clusters
    const unlabeled = Object.entries(identities)
      .filter(([_, v]: [string, any]) => !v.canonical_name)
      .map(([k]: [string, any]) => k);

    if (unlabeled.length === 0) {
      console.error('[mibot] All speakers already labeled');
      return;
    }

    // Get human participants (not bots, and who actually spoke if we have that data)
    const humans = participants.filter(p => !p.is_bot);
    const speakers = humans.filter(p => p.spoke);
    const candidateNames = (speakers.length > 0 ? speakers : humans).map(p => p.name);

    console.error(`[mibot] Auto-label: ${unlabeled.length} unknown cluster(s), ${candidateNames.length} candidate name(s)`);

    // Strategy 1: Direct match if counts align
    if (unlabeled.length === 1 && candidateNames.length === 1) {
      const clusterId = unlabeled[0];
      const name = candidateNames[0];
      console.error(`[mibot] Auto-labeling: ${clusterId} → ${name}`);
      await execFileAsync('audioscript', [
        'speakers', 'label', clusterId, name, '--db', path.basename(speakerDbPath),
      ], { cwd, env: { ...process.env } }).catch(() => {});
      return;
    }

    // Strategy 2: Match by speaker timeline overlap
    if (speakerTimeline.length > 0 && unlabeled.length > 0 && candidateNames.length > 0) {
      // For each unlabeled cluster, check which visual speaker has the most temporal overlap
      // This requires parsing the diarization output to get cluster timestamps
      // For now, log what we have for future improvement
      console.error(`[mibot] Speaker timeline has ${speakerTimeline.length} segments — timing-based matching available for future use`);
    }

    // Strategy 3: If only 1 candidate name and multiple clusters, label the dominant one
    if (candidateNames.length === 1 && unlabeled.length > 1) {
      // Find the cluster with the most speech (most calls/segments)
      let bestCluster = unlabeled[0];
      let bestCount = 0;
      for (const cid of unlabeled) {
        const info = identities[cid];
        const count = info.total_calls || info.call_count || 1;
        if (count > bestCount) { bestCount = count; bestCluster = cid; }
      }
      console.error(`[mibot] Auto-labeling dominant cluster: ${bestCluster} → ${candidateNames[0]}`);
      await execFileAsync('audioscript', [
        'speakers', 'label', bestCluster, candidateNames[0], '--db', path.basename(speakerDbPath),
      ], { cwd, env: { ...process.env } }).catch(() => {});
      return;
    }

    console.error(`[mibot] Could not auto-label: ${unlabeled.length} clusters, ${candidateNames.length} names — manual review needed`);
  } catch (err) {
    console.error(`[mibot] Auto-label error: ${(err as Error).message}`);
  }
}
