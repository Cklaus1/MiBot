# MiBot — Product Requirements Document

**Version:** 0.1 (Draft)
**Date:** 2026-03-27
**Status:** Discovery

---

## 1. Vision

MiBot is an AI meeting participant that joins your Zoom, Microsoft Teams, and Google Meet calls automatically — listens, transcribes, understands context, takes notes, extracts action items, and answers questions on your behalf when you're multitasking or absent.

It's not a passive recorder. It's a teammate that shows up to every meeting so you don't have to.

---

## 2. Problem

Knowledge workers spend 15-25 hours/week in meetings. Most of that time is wasted:

- **You can't be in two meetings at once** — you miss one, rely on someone else's recap
- **Notes are inconsistent** — depends on who's taking them, what they caught, what they forgot
- **Action items fall through** — said aloud, never written down, never tracked
- **Context is lost** — "what did we decide last Tuesday?" requires searching Slack, email, memory
- **Prep is manual** — you scramble to remember what happened in the last meeting 5 minutes before the next one
- **Recordings are useless** — nobody watches a 60-minute recording to find the 2 minutes that matter

Existing tools (Otter, Fireflies, Gong) are **record-and-transcribe** — passive, after-the-fact. MiBot is **AI-first** — it participates, reasons, and acts.

---

## 3. Users

**Primary:** Individual knowledge workers who are in 4+ meetings/day and want their time back.

**Secondary:** Small teams who want shared meeting intelligence without enterprise contracts.

**Anti-user:** Enterprise compliance teams who need on-prem recording (not our v1 market).

---

## 4. Core Capabilities

### 4.1 Auto-Join

MiBot joins meetings without manual intervention.

| Source | How |
|--------|-----|
| **Google Calendar** | Watches for events with Meet/Zoom/Teams links via Calendar API |
| **Microsoft 365 Calendar** | Watches via Graph API (leverage ms365-cli auth infrastructure) |
| **Manual invite** | User pastes a meeting link, MiBot joins on demand |
| **Recurring meetings** | Remembers join preferences per recurring series |

**Join behavior:**
- Joins 1-2 minutes before start time
- Identifies itself: "MiBot (recording for [User Name])"
- Respects "do not join" rules (1:1s, personal events, declined meetings)
- Can join multiple simultaneous meetings across platforms

### 4.2 Real-Time Transcription

- **Speaker diarization** — who said what, not just what was said
- **Multi-language support** — English primary, detect and transcribe other languages
- **Technical vocabulary** — learns domain-specific terms (product names, acronyms, jargon) from prior meetings
- **Low latency** — transcript available within seconds, not minutes
- **Confidence scoring** — flags uncertain transcription segments

### 4.3 AI Understanding (not just transcription)

This is what separates MiBot from a recorder:

| Capability | Description |
|------------|-------------|
| **Live summary** | Rolling 2-3 sentence summary updated every few minutes |
| **Topic segmentation** | Detects when conversation shifts topics, labels each segment |
| **Decision detection** | Identifies when a decision is made ("Let's go with option B") |
| **Action item extraction** | Detects commitments ("I'll send that by Friday") with owner + deadline |
| **Question tracking** | Flags unanswered questions that were asked but never resolved |
| **Sentiment/energy** | Detects heated discussions, confusion, alignment, disagreement |
| **Key moments** | Bookmarks critical moments: decisions, blockers, disagreements, breakthroughs |

### 4.4 Active Participation

MiBot can participate in the meeting when enabled:

- **Answer questions about you** — "Is [User] available Thursday?" (checks calendar, responds)
- **Provide context** — "What did we decide last sprint?" (searches prior meeting notes)
- **Take attendance** — tracks who joined, when, duration
- **React/acknowledge** — confirms when the user asks MiBot to note something ("MiBot, note that we're pushing the deadline to April 5th")
- **Screen content capture** — captures shared screens periodically for context (with consent indicators)

**Voice interaction:**
- Wake word: "MiBot" or "Hey Bot"
- Text-to-speech responses in the call (natural voice, not robotic)
- Can be muted/silenced by any participant

### 4.5 Post-Meeting Intelligence

Within 60 seconds of meeting end:

| Deliverable | Format |
|-------------|--------|
| **Meeting brief** | 5-10 bullet executive summary |
| **Full transcript** | Searchable, speaker-labeled, timestamped |
| **Action items** | Owner, description, deadline, status — pushed to MiAction |
| **Decisions log** | What was decided, who decided, context |
| **Follow-up draft** | AI-drafted follow-up email for host to review and send |
| **Key moments clip** | Short audio/video clips of the 3-5 most important moments |

### 4.6 Meeting Memory

MiBot builds institutional memory across meetings:

- **Cross-meeting search** — "When did we last discuss the pricing model?" returns the exact moment
- **Person profiles** — what topics each person typically discusses, their communication style, their commitments
- **Project threads** — links related meetings into a narrative ("The auth migration was discussed in 7 meetings over 3 weeks, here's the arc")
- **Trend detection** — "This topic has come up in 4 consecutive standups without resolution"
- **Prep briefs** — before a meeting, MiBot generates a brief: last meeting summary, open action items, unresolved questions

---

## 5. Platform Integration

### 5.1 Meeting Platforms

| Platform | Join Method | Audio Capture | Video Capture |
|----------|------------|---------------|---------------|
| **Zoom** | Bot SDK / Web SDK | Real-time audio stream | Screen share capture |
| **Microsoft Teams** | Graph Communications API + Bot Framework | Real-time audio stream | Screen share capture |
| **Google Meet** | Puppeteer/Playwright headless browser | System audio capture | Screen capture |

### 5.2 Calendar Integration

| Provider | Method | Capability |
|----------|--------|------------|
| **Google Calendar** | Calendar API + Push Notifications | Read events, detect meeting links, watch for changes |
| **Microsoft 365** | Graph API (reuse ms365-cli auth) | Read events, detect meeting links, webhooks |
| **Apple Calendar** | CalDAV | Read-only polling |

### 5.3 Output Destinations

| Destination | What gets sent |
|-------------|---------------|
| **MiNotes** | Full meeting notes (transcript, summary, decisions) as a structured note |
| **MiAction** | Action items with owner, deadline, meeting context |
| **Slack/Teams chat** | Summary posted to a channel after the meeting |
| **Email** | Follow-up draft sent to host for review |
| **Google Docs** | Shared meeting notes document |
| **CRM (future)** | Customer meeting intelligence for sales/CS teams |

---

## 6. Architecture (High Level)

```
                    +------------------+
                    |  Calendar Watcher |
                    |  (Google, M365)   |
                    +--------+---------+
                             |
                             v
                    +------------------+
                    |   Meeting Scheduler  |
                    |   (join queue)    |
                    +--------+---------+
                             |
              +--------------+--------------+
              |              |              |
              v              v              v
        +-----------+  +-----------+  +-----------+
        | Zoom Bot  |  | Teams Bot |  | Meet Bot  |
        | (SDK)     |  | (Graph)   |  | (Browser) |
        +-----------+  +-----------+  +-----------+
              |              |              |
              +--------------+--------------+
                             |
                             v
                    +------------------+
                    |   Audio Pipeline  |
                    | STT + Diarization|
                    +--------+---------+
                             |
                             v
                    +------------------+
                    |    AI Engine      |
                    | Summary, Actions, |
                    | Decisions, Q&A    |
                    +--------+---------+
                             |
              +--------------+--------------+
              |              |              |
              v              v              v
        +-----------+  +-----------+  +-----------+
        | MiNotes   |  | MiAction  |  |Slack/Email|
        +-----------+  +-----------+  +-----------+
```

### 6.1 Key Technical Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| **Runtime** | Node.js / TypeScript | Consistent with ms365-cli, MiNotes ecosystem |
| **Deployment** | Cloud service (always-on) | Must join meetings on schedule, can't depend on user's machine being on |
| **STT Engine** | Deepgram or AssemblyAI | Best real-time accuracy + diarization |
| **AI Model** | Claude API | Superior reasoning for summaries, action extraction, context understanding |
| **Audio transport** | WebRTC / platform SDKs | Native integration, lowest latency |
| **Storage** | PostgreSQL + S3 | Structured data + audio/transcript blobs |
| **Meet joining** | Headless Chromium | Google doesn't offer a bot SDK — browser automation is the standard approach |

---

## 7. User Experience

### 7.1 Setup (5 minutes)

```
1. Sign up at mibot.ai
2. Connect Google Calendar and/or Microsoft 365
3. Set join preferences:
   - Join all meetings / only meetings I organize / only meetings with 3+ people
   - Never join: 1:1s, personal events, specific recurring meetings
   - Notify me before joining (yes/no)
4. Done — MiBot appears in your next meeting
```

### 7.2 During Meeting

- MiBot appears as a participant named "MiBot (Notes for [User])"
- User sees a live dashboard (web/mobile):
  - Rolling transcript
  - Live summary updating in real-time
  - "Star" button to bookmark moments
  - "Ask MiBot" chat for questions about current or past meetings
- Other participants see MiBot in the attendee list
  - Can ask MiBot questions verbally
  - Can say "MiBot, stop recording" to pause

### 7.3 After Meeting

- Push notification: "Meeting notes ready for [Meeting Name]"
- One-tap access to: summary, full transcript, action items, key moments
- Action items auto-created in MiAction
- Notes auto-created in MiNotes
- Optional: follow-up email draft ready to send

### 7.4 Between Meetings

- Search across all meeting history: "What did Sarah say about the Q3 budget?"
- Meeting prep: "Brief me on my 2pm with the design team" returns last meeting summary + open items
- Weekly digest: meetings attended, total hours, action items created/completed, decisions made

---

## 8. Privacy & Consent

This is a make-or-break concern. MiBot must handle it perfectly.

| Requirement | Implementation |
|-------------|----------------|
| **Announce presence** | MiBot states it's recording when it joins. Always. |
| **Consent model** | Configurable: announce-only, opt-out (any participant can say "stop recording"), or opt-in (requires explicit consent from all) |
| **Data ownership** | User owns all transcripts and recordings. Delete anytime. |
| **Retention policy** | Configurable: 30/90/365 days, or indefinite |
| **Guest privacy** | External participants can request their portions be redacted |
| **Compliance** | SOC 2, GDPR, CCPA from day one |
| **Recording indicator** | Meeting platform's native recording indicator is triggered where possible |
| **No training on user data** | Meeting content is never used to train AI models |

---

## 9. Differentiation from Competitors

| Feature | Otter.ai | Fireflies | Gong | **MiBot** |
|---------|----------|-----------|------|-----------|
| Auto-join meetings | Yes | Yes | Yes | **Yes** |
| Real-time transcription | Yes | Yes | Yes | **Yes** |
| Speaker diarization | Yes | Yes | Yes | **Yes** |
| AI summary | Basic | Basic | Sales-focused | **Deep reasoning** |
| Action item extraction | No | Basic | No | **With owner + deadline** |
| Decision tracking | No | No | No | **Yes** |
| Unanswered question tracking | No | No | No | **Yes** |
| Active participation (voice) | No | No | No | **Yes** |
| Cross-meeting memory | No | Basic | Sales CRM | **Full knowledge graph** |
| Meeting prep briefs | No | No | Yes (sales) | **Yes (all meetings)** |
| Open ecosystem (MiNotes, MiAction) | No | Zapier | Salesforce | **Native integration** |
| Privacy-first design | Varies | Varies | Enterprise | **User-controlled** |

**MiBot's moat:** It's not a recorder with AI bolted on. It's an AI that happens to attend meetings. The understanding is the product, not the transcript.

---

## 10. Milestones

### v0.1 — Proof of Concept (4 weeks)
- [ ] Join a single Zoom meeting via Bot SDK
- [ ] Real-time transcription with speaker diarization
- [ ] Post-meeting summary via Claude API
- [ ] Action item extraction
- [ ] Output to console/JSON

### v0.2 — Multi-Platform (4 weeks)
- [ ] Google Meet joining (headless browser)
- [ ] Microsoft Teams joining (Bot Framework)
- [ ] Google Calendar watching
- [ ] Microsoft 365 Calendar watching
- [ ] Auto-join based on calendar events

### v0.3 — Intelligence (3 weeks)
- [ ] Decision detection
- [ ] Unanswered question tracking
- [ ] Topic segmentation
- [ ] Meeting prep briefs from prior meetings
- [ ] Cross-meeting search

### v0.4 — Integration (3 weeks)
- [ ] MiNotes output (structured meeting notes)
- [ ] MiAction output (action items with context)
- [ ] Slack/Teams post-meeting summary
- [ ] Follow-up email drafts
- [ ] Web dashboard for live meeting view

### v0.5 — Active Participation (4 weeks)
- [ ] Voice interaction ("MiBot, note that...")
- [ ] Calendar queries ("Am I free Thursday?")
- [ ] Context from prior meetings ("What did we decide last week?")
- [ ] Text-to-speech responses

### v1.0 — Production (4 weeks)
- [ ] Multi-tenant cloud deployment
- [ ] User authentication and onboarding flow
- [ ] Privacy controls and consent management
- [ ] Billing
- [ ] SOC 2 audit

---

## 11. Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| **Platform ToS** | High | Zoom Bot SDK is sanctioned. Teams has official bot APIs. Google Meet has no bot SDK — browser automation is gray area. Monitor ToS changes. |
| **Audio quality** | Medium | Bad mics/connections degrade transcription. Use noise suppression + confidence scoring. |
| **Privacy backlash** | High | Lead with consent, make recording obvious, give participants control. Never be the "creepy recorder." |
| **Cost per meeting** | Medium | STT + LLM costs per hour of audio. Optimize with local whisper for transcription, Claude only for reasoning. |
| **Google Meet access** | High | No official bot API. Headless browser approach may break with UI changes. Invest in resilient selectors + monitoring. |
| **Multi-meeting concurrency** | Medium | Each simultaneous meeting needs its own audio pipeline. Design for horizontal scaling from day one. |

---

## 12. Success Metrics

| Metric | Target (v1.0) |
|--------|---------------|
| Meetings auto-joined successfully | > 95% |
| Transcription word error rate | < 10% |
| Action items correctly extracted | > 80% precision |
| Summary rated "useful" by user | > 85% |
| Time from meeting end to notes delivered | < 60 seconds |
| User retention (weekly active) | > 70% at 30 days |
| Meetings where a participant asks MiBot to stop | < 5% |

---

## 13. Open Questions

1. **Should MiBot have a camera feed?** A virtual avatar/face makes it feel more human but uses more bandwidth and raises more privacy concerns.
2. **Should MiBot join meetings the user declined?** Could be useful ("keep me informed") but could also be seen as surveillance.
3. **How to handle confidential meetings?** Auto-detect sensitivity from invite labels/titles? Let users tag meetings as "no bot"?
4. **Mobile-first or web-first dashboard?** Meeting prep is mobile (walking between meetings), review is web (at desk).
5. **Pricing model?** Per-seat/month? Per-meeting? Per hour of transcription? Freemium with X meetings/month?
