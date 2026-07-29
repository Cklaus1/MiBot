import path from 'path';
import fs from 'fs';
import { updateRecording, type Participant, type SpeakerSegment } from './db.js';
import { RECORDING_STATUS, type RecordingStatus } from './status.js';
import { runCli, buildArgv, CliError } from './runcli.js';

/**
 * T7: extract audioscript's output directory from its stdout by JSON-parsing (never
 * regex-scraping) and resolving it relative to audioDir. Returns null when the field is
 * absent or stdout isn't JSON, so the caller can hard-fail (T2) rather than silently
 * falling back to a guessed `audioDir/output`. Tolerates JSON embedded among log lines.
 */
export function resolveOutputDir(stdout: string, audioDir: string): string | null {
  const obj = extractJsonObject(stdout);
  const dir = obj && typeof (obj as any).output_dir === 'string' ? (obj as any).output_dir : null;
  if (!dir) return null;
  return path.isAbsolute(dir) ? dir : path.resolve(audioDir, dir);
}

/** Parse the first balanced top-level JSON object found in `text` (whole-string first,
 *  then a brace-delimited slice), or null. Lets us read a tool's JSON line even when it
 *  interleaves plain-text progress logs on the same stream. */
function extractJsonObject(text: string): unknown | null {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through to slice
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Transcribe a recording and return the resulting recording-status *outcome*.
 * R6: transcribe no longer writes the recording's status row itself — it returns
 * the outcome so the single caller can reconcile it (C7) against the current status.
 * Content side-effects (transcript_path) are still written here; only the status
 * decision is handed back.
 *
 * Returns:
 *   'no_audio'          — nothing to transcribe (missing/empty file)
 *   'transcribe_failed' — audioscript stage failed
 *   'done'              — transcription succeeded (deepscript analysis is best-effort)
 */
export async function transcribe(
  recordingId: number,
  audioPath: string,
  participants: Participant[],
  speakerTimeline: SpeakerSegment[],
): Promise<RecordingStatus> {
  if (!fs.existsSync(audioPath) || fs.statSync(audioPath).size === 0) {
    console.error('[mibot] No audio to transcribe');
    return RECORDING_STATUS.NO_AUDIO;
  }

  // Run audioscript from the audio file's directory (it requires relative paths)
  const audioDir = path.dirname(audioPath);
  const audioFile = path.basename(audioPath);

  // ── Stage 1: AudioScript (transcription + diarization) ──────────────
  console.error('[mibot] Stage 1: Transcribing via audioscript...');
  let transcriptJson: string | null = null;
  try {
    // T6: runCli sets a 64 MiB maxBuffer so a chatty CLI on a long meeting is not killed
    // with ERR_CHILD_PROCESS_STDOUT_MAXBUFFER (which had recorded success as failure).
    const { stdout } = await runCli(
      'audioscript', ['transcribe', '--diarize', '-i', audioFile],
      { timeoutMs: 30 * 60 * 1000, cwd: audioDir },
    );

    // T7: JSON-parse the output dir; T2: hard-fail if audioscript exited 0 but produced no
    // parsable output location rather than guessing audioDir/output and yielding an empty run.
    const outputDir = resolveOutputDir(stdout, audioDir);
    if (!outputDir) {
      console.error(`[mibot] Transcription produced no output_dir in stdout:\n${stdout.slice(0, 200)}`);
      return RECORDING_STATUS.TRANSCRIBE_FAILED;
    }

    const jsonFile = path.join(outputDir, audioFile.replace(/\.\w+$/, '.json'));
    if (fs.existsSync(jsonFile)) transcriptJson = jsonFile;

    const mdFile = path.join(outputDir, audioFile.replace(/\.\w+$/, '.md'));
    const haveMd = fs.existsSync(mdFile);
    if (haveMd) {
      updateRecording(recordingId, { transcript_path: mdFile });
      console.error(`[mibot] Transcript: ${mdFile}`);
    }

    // T2: exit-0 with neither transcript artifact is a failure, not a silent 'done'.
    if (!transcriptJson && !haveMd) {
      console.error(`[mibot] Transcription exited 0 but no .json/.md in ${outputDir}`);
      return RECORDING_STATUS.TRANSCRIBE_FAILED;
    }

    // Auto-label speakers using meeting participant list. T3: pass the ABSOLUTE speaker db
    // path (it lives in outputDir, not audioDir — basename() stripped that and labeled a
    // nonexistent db).
    const speakerDbPath = path.join(outputDir, 'speaker_identities.json');
    if (fs.existsSync(speakerDbPath)) {
      await autoLabelSpeakers(speakerDbPath, participants, speakerTimeline, audioDir);
    }
  } catch (err) {
    const stderr = err instanceof CliError ? err.stderr : '';
    console.error(`[mibot] Transcription failed: ${(err as Error).message}${stderr ? '\n' + stderr : ''}`);
    return RECORDING_STATUS.TRANSCRIBE_FAILED;
  }

  // ── Stage 2: DeepScript (analysis + action items) ───────────────────
  // Transcription (stage 1) already succeeded past this point, so the recording
  // outcome is 'done' regardless of whether the best-effort analysis stage runs.
  if (!transcriptJson || !fs.existsSync(transcriptJson)) {
    console.error('[mibot] No transcript JSON for DeepScript — skipping analysis');
    return RECORDING_STATUS.DONE;
  }

  try {
    await runCli('which', ['deepscript'], { timeoutMs: 3000 });
  } catch {
    console.error('[mibot] deepscript not installed — skipping analysis');
    return RECORDING_STATUS.DONE;
  }

  console.error('[mibot] Stage 2: Analyzing via deepscript...');
  try {
    const analysisDir = path.join(path.dirname(transcriptJson), 'analysis');
    const { stdout } = await runCli(
      'deepscript',
      ['analyze', transcriptJson, '--output-dir', analysisDir, '--calendar', '--cms'],
      { timeoutMs: 10 * 60 * 1000, cwd: path.dirname(transcriptJson) },
    );

    // T8: deepscript exiting 0 with an empty/missing analysis dir must warn (silence hid
    // a broken analysis stage that produced nothing).
    const analysisFiles = fs.existsSync(analysisDir)
      ? fs.readdirSync(analysisDir).filter((f) => f.endsWith('.json') || f.endsWith('.md'))
      : [];
    if (analysisFiles.length > 0) {
      console.error(`[mibot] Analysis complete: ${analysisFiles.length} file(s) in ${analysisDir}`);
    } else {
      console.error(`[mibot] WARN: deepscript exited 0 but produced no analysis in ${analysisDir}`);
    }

    if (stdout) {
      const typeMatch = stdout.match(/"classification":\s*"([^"]+)"/);
      if (typeMatch) console.error(`[mibot] Call type: ${typeMatch[1]}`);
    }
  } catch (err) {
    const stderr = err instanceof CliError ? err.stderr : '';
    console.error(`[mibot] DeepScript analysis failed: ${(err as Error).message}${stderr ? '\n' + stderr.substring(0, 200) : ''}`);
    // Don't fail the recording — transcription succeeded, analysis is a bonus
  }

  return RECORDING_STATUS.DONE;
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
      await labelSpeaker(clusterId, name, speakerDbPath, cwd);
      return;
    }

    // Strategy 2: Match by speaker timeline overlap
    if (speakerTimeline.length > 0 && unlabeled.length > 0 && candidateNames.length > 0) {
      console.error(`[mibot] Speaker timeline has ${speakerTimeline.length} segments — timing-based matching available for future use`);
    }

    // Strategy 3: If only 1 candidate name and multiple clusters, label the dominant one
    if (candidateNames.length === 1 && unlabeled.length > 1) {
      let bestCluster = unlabeled[0];
      let bestCount = 0;
      for (const cid of unlabeled) {
        const info = identities[cid];
        const count = info.total_calls || info.call_count || 1;
        if (count > bestCount) { bestCount = count; bestCluster = cid; }
      }
      console.error(`[mibot] Auto-labeling dominant cluster: ${bestCluster} → ${candidateNames[0]}`);
      await labelSpeaker(bestCluster, candidateNames[0], speakerDbPath, cwd);
      return;
    }

    console.error(`[mibot] Could not auto-label: ${unlabeled.length} clusters, ${candidateNames.length} names — manual review needed`);
  } catch (err) {
    console.error(`[mibot] Auto-label error: ${(err as Error).message}`);
  }
}

/**
 * Invoke `audioscript speakers label` for one cluster.
 *   T3: pass the ABSOLUTE speaker db path (basename() dropped the `output/` segment and
 *       labeled a nonexistent db in cwd).
 *   T5: the display name is attacker-controlled, so route positionals after a `--`
 *       terminator (buildArgv) — a name like `--db=…` can't be reparsed as a flag.
 *   T4: bound the call with a timeout and surface stderr instead of `.catch(()=>{})`
 *       swallowing exit code / ENOENT / a hang.
 */
async function labelSpeaker(clusterId: string, name: string, speakerDbPath: string, cwd: string): Promise<void> {
  const argv = buildArgv(['speakers', 'label'], [clusterId, name], ['--db', path.resolve(speakerDbPath)]);
  try {
    await runCli('audioscript', argv, { cwd, timeoutMs: 60_000 });
  } catch (err) {
    const stderr = err instanceof CliError ? err.stderr : '';
    console.error(`[mibot] Speaker label failed (${clusterId} → ${name}): ${(err as Error).message}${stderr ? '\n' + stderr.slice(0, 200) : ''}`);
  }
}
