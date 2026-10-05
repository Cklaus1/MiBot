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
      await autoLabelSpeakers(speakerDbPath, transcriptJson, participants, audioDir);
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
 * Talk seconds per speaker cluster IN THIS MEETING, from audioscript's transcript JSON
 * (segments carry `speaker_cluster_id`; `diarization.speakers_resolved` lists every resolved
 * cluster). Empty when the transcript has no diarization.
 */
export function meetingSpeakerTalk(transcript: any): Map<string, number> {
  const talk = new Map<string, number>();
  for (const r of transcript?.diarization?.speakers_resolved ?? []) {
    if (typeof r?.speaker_cluster_id === 'string') talk.set(r.speaker_cluster_id, talk.get(r.speaker_cluster_id) ?? 0);
  }
  for (const seg of transcript?.segments ?? []) {
    const id = seg?.speaker_cluster_id;
    if (typeof id !== 'string') continue;
    const dur = Math.max(0, Number(seg.end) - Number(seg.start)) || 0;
    talk.set(id, (talk.get(id) ?? 0) + dur);
  }
  return talk;
}

export type LabelChoice =
  | { clusterId: string; name: string }
  | { skip: 'no-diarization' | 'all-labeled' | 'roster-incomplete' | 'no-candidate' | 'ambiguous' };

/**
 * Wave 9-D: decide which (if any) speaker cluster to name. Pure.
 *
 * The identity DB (speaker_identities.json) is SHARED and cumulative across meetings. The old
 * logic picked among every unlabeled identity in it and ranked by lifetime call counts, so this
 * meeting's one name could land on a stranger from another call — and a wrong name then
 * propagates to every later transcript. Rules now, each preferring "no label" to a guess:
 *  - only clusters that spoke in THIS meeting are eligible; no diarization → no label
 *  - more voices than humans on the roster → the roster scrape missed people → no label
 *  - a name already on another voice in this meeting isn't a candidate
 *  - exactly one candidate name must remain
 *  - several unlabeled voices → only the clearly dominant one (≥2× the next) in this meeting
 */
export function chooseSpeakerLabel(input: {
  identities: Record<string, { canonical_name?: string | null }>;
  talk: Map<string, number>;
  participants: Participant[];
}): LabelChoice {
  const { identities, talk, participants } = input;
  if (talk.size === 0) return { skip: 'no-diarization' };
  const present = [...talk.keys()];
  const unlabeled = present.filter((id) => identities[id] && !identities[id].canonical_name);
  if (unlabeled.length === 0) return { skip: 'all-labeled' };

  const humans = participants.filter((p) => !p.is_bot);
  if (present.length > humans.length) return { skip: 'roster-incomplete' };

  const taken = new Set(present.map((id) => identities[id]?.canonical_name).filter(Boolean));
  const spoke = humans.filter((p) => p.spoke);
  const pool = (spoke.length > 0 ? spoke : humans).map((p) => p.name).filter((n) => !taken.has(n));
  if (pool.length === 0) return { skip: 'no-candidate' };
  if (pool.length > 1) return { skip: 'ambiguous' };
  const name = pool[0];

  if (unlabeled.length === 1) return { clusterId: unlabeled[0], name };
  const secs = (id: string) => talk.get(id) ?? 0;
  const [top, next] = [...unlabeled].sort((a, b) => secs(b) - secs(a));
  return secs(top) > 0 && secs(top) >= 2 * secs(next) ? { clusterId: top, name } : { skip: 'ambiguous' };
}

/** Auto-label at most one speaker cluster of this meeting (see chooseSpeakerLabel). */
export async function autoLabelSpeakers(
  speakerDbPath: string,
  transcriptJsonPath: string | null,
  participants: Participant[],
  cwd: string,
): Promise<void> {
  try {
    const db = JSON.parse(fs.readFileSync(speakerDbPath, 'utf8'));
    const transcript = transcriptJsonPath ? JSON.parse(fs.readFileSync(transcriptJsonPath, 'utf8')) : null;
    const choice = chooseSpeakerLabel({
      identities: db.identities || {},
      talk: meetingSpeakerTalk(transcript),
      participants,
    });
    if ('skip' in choice) {
      console.error(`[mibot] Auto-label skipped (${choice.skip}) — manual review if needed`);
      return;
    }
    console.error(`[mibot] Auto-labeling: ${choice.clusterId} → ${choice.name}`);
    await labelSpeaker(choice.clusterId, choice.name, speakerDbPath, cwd);
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
