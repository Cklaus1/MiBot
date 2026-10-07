# Wave 10 spec — make MiBot measurable, lawful, and useful

**Status:** Draft. Open questions are marked **OQ-n**; each carries a recommended default, so
a build can start once they're answered or the defaults are accepted.
**Date:** 2026-10-07
**Scope:** the Critical and High items from the PM review (#1–#7). The Medium items are
backlog, listed at the end and in `tasks/opportunities.md`.

---

## 1. Why

MiBot's core job (join, record, transcribe) mostly does not complete, and today nobody
can tell why. Production DB snapshot (2026-10-07, read-only, before migrations v5–v7):

| | done | failed | stuck (joining/in_call/processing) | scheduled |
|---|---|---|---|---|
| Teams | 4 | 534 | 43 | 344 |
| Zoom | 2 | 62 | 10 | 19 |
| Meet | 2 | 12 | 0 | 34 |

Across 1,066 meetings there are **12 transcripts**. Some of these rows are dev/test pollution,
and Waves 7–9 fixed several root causes: silent recordings, single-page sync, one-shot joins,
and false stale-kills. But no row records *why* it failed. So we can't measure whether those
fixes worked, and every further reliability fix is a guess.

Beyond reliability:
- **No disclosure.** The bot records silently, with no notice and no way for participants to
  stop it. That's a legal exposure on the first external call (all-party-consent states,
  GDPR).
- **Pull-only output.** Value only reaches the user if they remember to run `mibot show`.
- **Silent outages.** An expired login, camofox being down, or a dead watcher shows up only
  in log files.

## 2. Goals and non-goals

**Goals**
- Every meeting's outcome is explained, and the success rate is one command away (#1).
- Participants are told they're being recorded and can stop it (#2).
- Results and problems reach the user without being asked for (#3, #4).
- The user can control individual meetings (#5).
- Breakage is caught before a real meeting (#6).
- Past meetings are searchable (#7).

**Non-goals (this wave)**
- Web UI.
- Live/real-time transcription.
- New meeting platforms.
- Multi-user / multi-tenant.
- Video recording beyond the existing screen-share screenshots.

## 3. Build order and dependencies

```
#1 diagnostics ──► #3/#4 notifier (digests and alerts include failure reasons)
      │                 ▲
      ├──► #6 self-test ┘ (failures raise alerts)
#2 consent (independent; needs per-platform chat steps)
#5 per-meeting control (independent; reuses the leave path #2 adds)
#7 search (independent; hooks the transcription-success path)
```

Recommended sequence: **#1 → #2 → #3+#4 → #5 → #6 → #7**.

#1 comes first because its report is the acceptance gauge for everything after it.

---

## 4. Items

### #1 — Failure diagnostics and success reporting  ·  CRITICAL

**Problem.** `meetings` has no failure reason. A join failure, a crash, a missing-audio
recording and a transcription error all collapse into `failed` (or into `no_audio` /
`transcribe_failed` on the recording). A screenshot is captured only on a normal
"meeting ended" exit, never on a failure.

**Design.**
- **Attempt history.** New table `join_attempts`, written once per bot run:
  - Columns: `id, meeting_id, attempt, started_at, ended_at, outcome, reason, step, detail,
    screenshot_path`.
  - Join retries (Wave 8) make one meeting produce several attempts, so a row on `meetings`
    alone would lose history.
- **Reason codes**, a closed enum in `status.ts`:
  - `join_step_failed`, `waiting_room_timeout`, `not_admitted`, `meeting_not_started`,
    `auth_required`.
  - `unsupported_url`, `browser_launch_failed`, `camofox_unavailable`.
  - `crashed` (set by recovery), `no_audio`, `transcribe_failed`, `missed`, `cancelled`,
    `skipped`, `stopped_by_participant` (#2), `unknown_legacy` (backfill).
- **Step attribution.**
  - Both playbook engines throw a `PlaybookStepError { stepIndex, action, target, cause }`,
    so a failure names the step ("step 7: click role=button 'Join now'").
  - `handleJoinFailure` records it.
- **Failure screenshot.**
  - On any join failure, capture the page (Playwright `page.screenshot`; camofox
    `/screenshot`) to `recordings/failures/<meetingId>-<attempt>.<ext>`.
  - Bounded by the existing retention.
- **Waiting-room classification.**
  - Before giving up, probe for known lobby / "host hasn't started" texts per platform.
  - The texts live in `~/.config/mibot/selectors/*.json` (config-driven, like `activeSpeaker`).
  - A match gives `waiting_room_timeout` / `meeting_not_started` instead of a generic step
    failure.
- **`mibot report [--days N] [--platform P]`.**
  - Success rate by platform.
  - Reason histogram.
  - Median join time.
  - The 10 most recent failures, each with its step and screenshot path.
  - "Success" = reached `in_call` **and** the recording ended `done` with usable audio.
- **Backfill.** Migration sets `failure_reason = 'unknown_legacy'` on existing `failed`
  rows, so the report separates old noise from new data.

**Acceptance criteria.**
- Every meeting that ends `failed` / `missed` / `cancelled` has a non-null reason; enforced
  by a test that walks every write path to a terminal status.
- Each join attempt produces exactly one `join_attempts` row, including retried and crashed
  attempts (recovery writes `crashed`).
- A playbook failure records the failing step index and action on both engines.
- `mibot report` output is covered by tests on a seeded DB.
- The waiting-room classifier is covered by tests on snapshot fixtures per platform.

**Risks.** Lobby texts are localized and change over time. Keeping them config-driven makes
them fixable without a rebuild.

---

### #2 — Recording disclosure and participant stop  ·  CRITICAL

**Problem.** Nothing tells participants they're being recorded, and nobody but the operator
can stop it.

**Design.**
- **Announcement.**
  - Within 30s of reaching `in_call`, post the configured message to the meeting chat.
  - New optional playbook section `"announce"`: a step list that opens chat, types and
    sends. It's per-platform and JSON-editable like the join flow.
  - Both engines gain a `postChat(text)` helper built from those steps.
  - Default message: OQ-1.
- **Display name.** Optionally suffix the bot's display name (for example
  "MiBot (recording)") as a second, always-visible signal: OQ-3.
- **Stop keyword.**
  - Both engines already capture chat into signals.
  - A message from any non-bot participant that exactly matches the stop keyword (OQ-2) ends
    the meeting through the normal leave path within one monitor tick (≤10s).
  - The recording is handled per OQ-2.
  - Outcome: `stopped_by_participant`.
- **Announcement failure** (chat disabled, selector broken): OQ-4.
- **Re-announcement.** If the bot rejoins after a retry, it posts again. It never posts more
  than once per attempt.

**Acceptance criteria.**
- The announce steps for each platform are verified live once (checklist in §6), and are
  unit-tested with the FakePage / vm patterns.
- The stop keyword is case-insensitive, must be the whole message, and is ignored when it
  comes from the bot itself or another bot.
- Stop → leave ≤10s → recording handled per OQ-2 → digest (#3) states that it was stopped
  and by whom.
- If the announcement fails, behaviour follows OQ-4 and is recorded with a reason.

**Risks.**
- Chat UIs are among the most volatile surfaces. Zoom's chat sits in an iframe, and Teams
  meeting chat can be disabled by policy.
- This item needs live verification on all three platforms; tests alone can't prove it.

---

### #3 + #4 — Notifier: post-meeting digest and operational alerts  ·  HIGH

**Problem.** Output is pull-only, and outages are only visible in logs. One notification
channel serves both needs.

**Design.**
- **`Notifier` interface:** `send({ kind: 'digest' | 'alert' | 'resolved', title, body,
  links })`.
- **Channels:** configured as a list (OQ-5). Candidates:
  - `email`: via `ms365 mail send`, which reuses the existing ms365 auth with no new
    credentials. Verified that the installed CLI supports `--to --subject --body --html`.
  - `slack`: incoming webhook URL.
  - `file`: a Markdown note per meeting in a folder, e.g. an Obsidian vault.
- **Outbox.**
  - Table `notifications (id, kind, dedupe_key, payload, status, attempts, next_attempt_at,
    created_at)`.
  - Sends are retried with backoff and survive restarts.
  - A send failure never affects the meeting pipeline.
- **Digest**, sent once a meeting is final. Contents:
  - Title, time, duration, participants and who spoke.
  - The summary (`*.summary.txt`).
  - Action items and decisions (`llm_analysis.action_items` / `key_decisions` from the
    transcript JSON).
  - Path or link to the transcript.
  - For an unsuccessful meeting, a one-line explanation from #1 ("Couldn't record *Design
    review*: waiting room — not admitted after 15 min").
  - Batching: OQ-6.
- **Alerts.** Each rule has a dedupe key and fires at most once per hour; a matching
  `resolved` message is sent when the condition clears.
  - Calendar sync failing 3 times in a row (per provider): usually an expired login.
  - Camofox unreachable when a Meet join is due.
  - A meeting that exhausted its join retries.
  - A transcription that gave up (Wave 9-B cap) or ended `transcribe_failed`.
  - The watcher restarting after a crash (recovery found its rows).
  - Self-test failure (#6).
- **Config:** `notify.channels`, `notify.digest: 'each' | 'daily' | 'off'`,
  `notify.alerts: boolean`.

**Acceptance criteria.**
- Digest content is built by a pure function from DB rows and transcript artifacts, and
  snapshot-tested.
- Outbox retry and dedupe are tested with an injected clock and a failing channel. The
  pipeline completes even when every channel fails.
- Each alert rule has a test that triggers and resolves it.
- Each configured channel is verified live once.

---

### #5 — Per-meeting control  ·  HIGH

**Problem.** The only filters are global (title regex, `onlyOrganized`, `minAttendees`).
There's no way to skip one meeting, or to make a running bot leave.

**Design.**
- **Event keywords.**
  - A configurable token in the event title or description skips the meeting, e.g.
    `[no-bot]` (OQ-7).
  - Optional opposite token forces a join even when `onlyOrganized` / `minAttendees` would
    skip it (OQ-8).
  - Evaluated in `meetingSkipReason`.
- **`mibot skip <id>` / `mibot unskip <id>`.**
  - New `user_skip` flag on `meetings`, set by the operator.
  - Calendar sync never clears it, unlike the CA2 revive.
  - Outcome reason: `skipped`.
- **`mibot leave <id>`.**
  - New `leave_requested_at` column. Both monitor loops check it every tick and leave
    through the normal path, so audio is finalized and transcribed as usual.
  - This works for camofox, which has no control socket, and for a bot in another process.
  - It's the same leave path #2's stop keyword uses.

**Acceptance criteria.**
- A keyword in either field skips the meeting, and the skip is logged once.
- `skip` survives a calendar sync that changes the event's time.
- `leave` is honored within one tick on both engines, and the recording proceeds to `done`.
- Tests cover all three, including `unskip`.

---

### #6 — Self-test  ·  HIGH

**Problem.** The silent-recording bug lived for months because nothing exercised the real
audio path. Breakage is discovered during a real meeting.

**Design.**
- **`mibot selftest`: preflight**, no meeting. Exits non-zero with a list of what failed.
  Checks:
  - `ffmpeg`/`ffprobe` present.
  - `audioscript` (and `deepscript`, if used) present.
  - Playwright Chromium launches.
  - Camofox reachable.
  - Calendar CLIs authenticated (cheap read calls).
  - Config valid.
  - Disk space above a threshold.
  - DB migrations current.
- **`mibot selftest --live <platform>`.**
  - Joins the operator's test meeting (OQ-9) with the recorder bot.
  - Launches a second headless "speaker" browser into the same meeting, using Chromium's
    fake media flags (`--use-file-for-fake-audio-capture=<tone.wav>`) so it plays a known
    tone.
  - After N seconds, finalizes the recording and asserts: usable audio (Wave 8 decode probe,
    above the −70 dB ceiling); duration ≥ 80% of the window; one webm segment or a clean
    join.
  - With #2 done, it also asserts the announcement was posted.
- **Schedule.** The watcher runs the preflight daily; failures go to #4 alerts. The live
  test runs on demand, or on a schedule if OQ-10 allows.

**Acceptance criteria.**
- Each preflight check has a test with a forced failure.
- The live test passes on at least one platform end to end (verified live) and fails
  correctly when the speaker is muted.
- A selftest never touches real calendar meetings or the production recordings list. Its
  rows are tagged and excluded from `report`.

**Risks.**
- Meet's guest join may need admission. The test meeting must allow open join, or the
  operator must be present.
- The fake-audio flags apply to Chromium. The Meet path uses camofox (Firefox-based), so the
  speaker may need to join via Chromium even for a Meet test.

---

### #7 — Transcript search  ·  HIGH

**Problem.** There's no way to find "what did we decide about pricing?" across meetings.

**Design.**
- **Index.** SQLite FTS5 (verified available: SQLite 3.49.2 in better-sqlite3).
  - Table `transcript_fts(text, speaker, meeting_id UNINDEXED, recording_id UNINDEXED,
    seg_start UNINDEXED)`, one row per transcript segment so hits carry timestamps.
  - Summaries are indexed too, flagged as such.
- **Population.** Hooked into the transcription-success path, including Wave 9-B resume.
  `mibot search --reindex` rebuilds the index from existing transcript JSON.
- **`mibot search "<query>" [--since 30d] [--platform P] [--speaker S]`.**
  - Results ranked by BM25, grouped by meeting: title, date, speaker, timestamp, and a
    `snippet()` excerpt.
- **Retention.** Pruning a meeting's rows also removes its index rows. Transcripts are kept,
  so index rows for kept transcripts stay.

**Acceptance criteria.**
- Indexing is idempotent: re-indexing creates no duplicates.
- Phrase, prefix and filter queries are tested on a seeded index.
- `--reindex` over the existing `recordings/output/*.json` succeeds, and transcripts without
  diarization are indexed with speaker = null.

---

## 5. Cross-cutting

- **Schema.** Additive migrations only:
  - v8: `join_attempts`, plus `meetings.failure_reason` / `failure_detail`.
  - v9: `notifications`.
  - v10: `meetings.user_skip`, `meetings.leave_requested_at`.
  - v11: `transcript_fts`.
- **Config keys (defaults):**
  - `consentMessage` (OQ-1), `consentStopKeyword` (OQ-2), `consentOnFailure` (OQ-4).
  - `botNameSuffix` (OQ-3).
  - `notify` (OQ-5/6).
  - `skipKeyword` / `forceKeyword` (OQ-7/8).
  - `selftest.testMeetings` (OQ-9).
- **Engineering rules** (as in Waves 7–9):
  - One commit per item, test-first.
  - In-page logic is executed under test, not string-matched.
  - No destructive defaults.
  - Verification runs against copies of production data.

## 6. Live verification checklist (cannot be proven by tests)

- [ ] #2: announcement posts in Teams, Zoom and Meet; the stop keyword ends each.
- [ ] #3: a real digest arrives on each configured channel after a real meeting.
- [ ] #4: an expired-login alert fires and resolves.
- [ ] #6: `selftest --live` passes on at least one platform, and fails correctly when muted.
- [ ] #1: `mibot report` after a week of real use; this is the baseline for future reliability work.

## 7. Open questions

| # | Question | Recommended default |
|---|---|---|
| **OQ-1** | Exact consent message text. | "Hi — I'm MiBot, recording and transcribing this meeting for [operator]. Type **!stop** in chat and I'll leave." |
| **OQ-2** | `!stop`: leave only, or leave **and delete** the recording? Deletion is irreversible. | Leave, and **delete** the audio and transcript of that meeting (the safer legal default); the digest records that it was stopped. |
| **OQ-3** | Add a visible display-name suffix, e.g. "MiBot (recording)"? | Yes. |
| **OQ-4** | If the announcement can't be posted (chat disabled / broken): keep recording, or leave? | Leave and record `consent_not_posted`. Recording without disclosure is the exposure #2 exists to remove. |
| **OQ-5** | Notification channel(s): email (via ms365, no new credentials), Slack webhook, Markdown folder, or several? | Email via ms365 to your own address. |
| **OQ-6** | Digest cadence: one per meeting, or a daily roll-up? | One per meeting; alerts always immediate. |
| **OQ-7** | Skip keyword. | `[no-bot]` in title or description. |
| **OQ-8** | Also support a force-join keyword that overrides `onlyOrganized` / `minAttendees`? | Yes: `[bot]`. |
| **OQ-9** | Test meeting URLs per platform for `selftest --live`; can they be joined without admission? | You supply one persistent room per platform you use; Meet room set to open access. |
| **OQ-10** | Run the live self-test on a schedule (e.g. nightly), or only on demand? | Preflight daily; live on demand only, since it occupies a meeting room. |
| **OQ-11** | Should the digest go to meeting participants too, or only the operator? | Operator only. Sharing with participants is a separate consent and privacy decision. |

## 8. Backlog (Medium, not in this wave)

- Push action items to a task tool.
- A command to name unknown speakers (auto-labeling now leaves unclear ones unnamed).
- Web dashboard.
- Shared/delegate calendars and non-primary Google calendars.
- Webex / Slack huddles.
- Export to Markdown/PDF/Docs/Notion.
- Live in-meeting notes.
