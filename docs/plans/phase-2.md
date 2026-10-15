# Phase 2 — The live Copilot

## Goal

A Rep places or takes a phone Call from a softphone in the portal. Every Call opens with the
Disclosure, is recorded, and is transcribed live, one channel per side. When the Prospect finishes a
turn, the Copilot shows the Rep a Suggestion drawn from the Organization's Playbook and from how
similar moments went in won Deals, within 1.5 s at p95. When the Call ends, its Recording, Transcript
and Suggestions are stored in the Organization's Region, and the Call joins the Playbook so later
Calls learn from it.

The vendors, prices and the cost model behind this plan are in
[`docs/research/2026-10-copilot-vendors.md`](../research/2026-10-copilot-vendors.md). Two decisions
there need the owner and are drafted as Proposed: telephony
([ADR 0020](../adr/0020-telephony-telnyx-behind-a-call-port.md)) and live transcription
([ADR 0021](../adr/0021-streaming-speech-to-text-assemblyai-one-stream-per-side.md)).

Out of scope: the Inbound Agent and Voice Profiles (phase 3), the Outbound Agent (phase 4), a Manager
listening to a live Call, and languages other than English. Voice Profiles plug in on the same media
path in the other direction: an Agent's synthesized voice goes back down the bidirectional stream that
the Copilot only listens to. Nothing in phase 2 synthesizes speech.

## Target

- **Latency.** A Suggestion's first words on the Rep's screen within **1.5 s of the Prospect's
  acoustic end of turn, p95**, measured end to end in the load test.
- **Scale.** Nothing on a Call's path grows with the Organization or with the number of Calls:
  per-Call work is bounded, live state is in Valkey, Postgres sees three writes a Call. Capacity grows
  by adding tasks and, past one Region's ceiling, Region deployments (ADR 0001).
- **Cost.** About $1.26 per Rep-hour at list on the managed path, falling to about $0.80 on our own
  media layer and about $0.42 with negotiated rates (research report, section 7). The model is under
  1% of it; telephony and transcription are the levers.

## Architecture

```
 Rep's browser (portal)                         Telnyx                         Prospect's phone
  softphone (WebRTC SDK) ── browser leg ──►  Call Control  ◄── PSTN leg ──────────────────┘
  Copilot panel ◄── SSE ── edge task              │ webhooks (signed)     │ media stream, both tracks
                               ▲                  ▼                       ▼
                               │            voice: control          voice: call loop task
                               │            (REST, webhooks)        ├─ two transcriber streams (AssemblyAI)
                               │                  │                 ├─ live Transcript window  ──► Valkey
                               └── direct post ───┼──────────────── ├─ gate ─► retrieval ─► model (Haiku 5.5, Bedrock)
                                  (registry in    │                 └─ Suggestions ──► edge ──► browser
                                   Valkey)        ▼                            │
                                            Postgres `voice`      playbook internal route:
                                            (3 writes a Call)     one embedding, Moments + documents
                                                  │
                                    Call end ─► S3 (Recording, Transcript, Suggestion log)
                                              ─► queue `voice.call-ended` ─► playbook (joins sales history)
                                                                            ─► core (metering)
```

### The Call path

- The portal asks voice for a short-lived softphone credential (Telnyx WebRTC) for the signed-in Rep.
  An outbound Call is placed through voice, which checks the Rep's role and Organization and creates
  the Call; an inbound Call to a Rep's number is routed by voice to that Rep's browser.
- Vendor webhooks are verified by signature and are idempotent on the vendor's event id. Every vendor
  call has a timeout and a bounded, jittered retry.
- **The Disclosure plays first** (see Consent and Disclosure). Only when the vendor confirms playback
  finished does voice start the media stream and the recording.

### The media path

- Telnyx streams both tracks over one websocket to a voice task, as 16 kHz linear PCM. The two tracks
  are the two sides, so the speaker of every word is known exactly.
- The task holding the stream owns the Call's live loop. It downsamples each side and sends it as one
  mono stream to the transcriber (8 kHz mu-law for both, a quarter of the bytes of 16 kHz PCM, if the
  trial shows no accuracy loss). Voice tasks egress without a NAT gateway.
- If the task dies, the stream drops. Any voice task sees the Call's missed heartbeat in Valkey,
  restarts the stream through Call Control, and the new owner rebuilds from the live Transcript in
  Valkey. The Rep loses a few seconds of Suggestions, never the Call.

### The transcript stream

- The transcriber returns immutable turns per side and an end-of-turn event on the Prospect's side.
- The live Transcript window (the last turns, bounded by count and characters) lives in Valkey under
  the Call, with a TTL. Coalesced updates (stable text, a few times a second, never every partial
  word) go to the Rep's screen.
- No transcript text goes to Postgres while the Call runs.

### Retrieval

- A new internal playbook route serves the Copilot: **one embedding** of the latest turns feeds a
  Moment search (won Deals) and a document search in parallel, returning both, with the evidence
  count. It reuses phase 1's search functions and their checks (Postgres decides eligibility; the
  vector tag is a hint). It is internal (ADR 0013): voice calls it with its service secret and the
  Call's Organization, because Moment search is open only to Owners and Admins and the Rep's token
  must not widen that.
- **Prefetch.** Retrieval runs on the Prospect's stable partial text while they are still talking, at
  most once a second, and the result is reused at end of turn when it covers most of the turn. In the
  common case retrieval is off the critical path.
- **Warm at Call start.** Voice asks playbook to warm the Organization's namespace when a Call starts
  (an idle turbopuffer namespace answers its first query in about 0.9 s).

### The Suggestion loop

1. End of turn on the Prospect's stream.
2. **The gate** (code, microseconds): Prospect turns only; skip backchannels and turns under about four
   words; a cooldown of about 20 s after a Suggestion unless the turn is a question; at most about 30
   Suggestions a Call-hour; skip if the top Moments match the last Suggestion's; never while the Rep is
   talking. Thresholds are configuration, tuned on the evaluation set. About 20 model calls a
   Call-hour are expected.
3. Retrieval from the prefetch, or fresh with a short deadline; on a miss the Suggestion is made
   without evidence rather than late.
4. **The model**: Claude Haiku 5.5 on Bedrock (EU profile in the EU Region), thinking off, at most
   about 120 output tokens, streamed. The prompt is ordered for the cache: fixed system prompt, the
   Organization's Playbook brief, the Call's turns so far, then the retrieved material and the latest
   turn. The model has no tools. Its output is checked (length, no control characters) and is shown
   only to the Rep, never spoken, never sent to the Prospect.
5. Tokens stream to the edge task holding the Rep's connection and on to the browser. The Rep can mark
   a Suggestion used or dismissed; those marks are the labels for the gate evaluation (issue 64).

### Transport to the portal

Server-Sent Events from edge tasks that hold browser connections and nothing else. An edge task
records `Call → edge` in Valkey on connect; the Call's loop task looks it up and posts to it directly.
Each Call keeps a short event ring buffer in Valkey so a reconnect to any edge replays what was
missed with `Last-Event-ID`. The Rep's actions are plain POSTs. No sticky sessions, no pub/sub
channel per Call.

### Storage of Call artefacts

| What | Where | When written |
| --- | --- | --- |
| The Call (Organization, Rep, direction, Prospect number, Deal id if given, Disclosure version and time, start, end, artefact keys) | Postgres, `voice` schema, row-level security | created, Disclosure confirmed, ended: three writes |
| Live Transcript window, Call state, heartbeat, event ring buffer, `Call → edge` | Valkey, keyed by Call, TTL | continuously; never the system of record |
| Recording (dual-channel, copied from Telnyx then deleted there, stored as Opus) | S3 in the Region | after the Call ends |
| Transcript (all turns, per side, with times) and Suggestion log (what was shown, when, on what evidence, used or dismissed) | S3 in the Region, one object each | once, at Call end |
| Moments of the Call | playbook, through its sales history path (ADR 0018) | on `voice.call-ended`; the live Transcript is reused, never re-transcribed |
| Copilot minutes | core, metering | on `voice.call-ended` |

The end of a Call is a queued, idempotent job (it survives the task that ran the Call): flush,
copy the Recording, write the objects, close the row, publish `voice.call-ended`. A deleted Call in
voice removes its Moments in playbook by an event, as ADR 0016 does for documents.

## Services and repos touched

| Repo | What phase 2 adds |
| --- | --- |
| hub | this plan, ADR 0020 and 0021, the glossary terms Suggestion and Disclosure, the evaluation set, local stack and smoke test for voice, the load test |
| contract | the `voice` area: routes, Suggestion and transcript event schemas, `voice.*` error codes, the `voice.call-ended` message; the internal Copilot retrieval route in the `playbook` area |
| db | the `voice` schema and role |
| kit | the streaming transcriber port with memory and AssemblyAI adapters; the Bedrock model client wrapper is left in voice until a second consumer exists |
| voice | **new repo**: the service, the call port and Telnyx adapter, the media loop, the gate, the Suggestion loop, the SSE edge, Call end |
| playbook | the internal Copilot retrieval route, namespace warming, importing live Calls |
| core | Copilot metering per Organization; phone numbers on a Rep's membership if the owner wants them there |
| portal | the softphone and the Copilot panel; Call history with Transcript and Recording |
| infra | voice in both Regions, Valkey, the websocket and SSE ingress, webhook ingress, secrets |

## Steps

Each step is one ticket. "After" lists the steps that must be merged first. Library steps land and
are tagged before the steps that consume them. Steps marked **creds** run on fakes until the owner's
accounts exist, as phase 1 did.

| Step | Repo | What | After |
| --- | --- | --- | --- |
| 2.1 | hub | Research and decision records: this plan, the vendor report, ADR 0020 and 0021 (Proposed) | — |
| 2.2 | hub | **ready-for-human.** Owner decisions and accounts: confirm or change ADR 0020 and 0021; Telnyx account, business profile, numbers and STIR/SHAKEN registration; written EU terms (Telnyx, AssemblyAI); AssemblyAI streaming concurrency; Bedrock access to Haiku 5.5 and Sonnet 5.5 in both Regions; the lawyer-checked Disclosure wording | 2.1 |
| 2.3 | contract | The `voice` area: start, answer and end a Call; softphone credential; Rep actions on a Suggestion; the SSE event schemas (transcript update, Suggestion start, token, end, Call state) with a version field; `voice.*` error codes; the `voice.call-ended` message. The internal `copilotContext` route in the `playbook` area (turns in, Moments and passages out, both bounded). Release a tag | — |
| 2.4 | db | The `voice` schema and database role: Calls (with Disclosure version and time), phone numbers, consumed messages, idempotency keys; fail-closed row-level security; the work hint kinds for Call end (ADR 0017). Release a tag | — |
| 2.5 | kit | Streaming transcriber port: open a stream per side, push audio, receive immutable turns and end-of-turn events, close. A memory adapter that replays a scripted Transcript with timings; one behaviour suite. Release a tag | — |
| 2.6 | kit | AssemblyAI Universal-Streaming adapter passing the 2.5 suite: EU endpoint by Region, timeouts, bounded jittered reconnect, turn settings from configuration, nothing logged but ids. **creds** | 2.5 |
| 2.7 | hub | Create `tula-closeline-voice` with `scripts/new-repo.sh`; add it to the sync list and CI | — |
| 2.8 | voice | Service skeleton from `templates/service`: library tags, container, env (`ENVIRONMENT`, `REGION`), token middleware, error handler, OpenAPI, health and readiness, queue, storage and Valkey on memory adapters. `AGENTS.md` names the hot paths below | 2.3, 2.4, 2.5, 2.7 |
| 2.9 | voice | Call port with memory adapter and a fake vendor for local development; Telnyx adapter: softphone credential, place and receive Calls, signed webhooks idempotent on event id, play the Disclosure and confirm, start and stop the stream and the dual-channel recording, fetch and delete the Recording. Outbound Calls by Owner, Admin, Manager and Rep; an inbound Call goes to the Rep who owns the number. A second Organization cannot start, see or end the first one's Calls. **creds** for the adapter | 2.8 |
| 2.10 | voice | **The Disclosure gate.** Every Call plays the Disclosure before media flows. The stream and recording start only on the vendor's playback-finished event; if playback fails, the Call continues with neither, and the Rep is told. No setting, flag or role can skip it. The Call row stores the wording version and time. Tests: no audio frame reaches the transcriber before confirmation; a failed playback starts nothing | 2.9 |
| 2.11 | voice | **The media loop** (hot path). Accept the vendor's websocket per Call (authenticated per Call), split the tracks, downsample, open two transcriber streams, keep the live Transcript window in Valkey, heartbeat, coalesced transcript events. A task that dies: another task restarts the stream and resumes from Valkey. Benchmark: per-frame cost and per-Call memory | 2.6, 2.10 |
| 2.12 | playbook | **The internal `copilotContext` route** (hot path): one embedding, Moment and document search in parallel, the same eligibility checks as phase 1, a deadline per step; plus a warm route called at Call start. Internal secret (ADR 0013), Organization from the caller, a second Organization proves isolation. Benchmark next to `search.bench.test.ts`; real-adapter p95 target 300 ms warm | 2.3 |
| 2.13 | voice | **The Suggestion loop** (hot path): the gate, retrieval prefetch during the turn and reuse at end of turn, the model port with a memory adapter and a Bedrock adapter for Haiku 5.5 (thinking off, cached prefix, streamed, output checked, timeout and one jittered retry inside the budget), the Suggestion events, Rep actions. Benchmark the gate and the prompt assembly; the end-to-end budget is measured in 2.20. **creds** for Bedrock | 2.11, 2.12 |
| 2.14 | kit | Fan-out registry port (`Call → edge`, with TTL and an event ring buffer) with memory and Valkey adapters and one behaviour suite. Release a tag | 2.5 |
| 2.15 | voice | **The SSE edge** (hot path): authenticated SSE per Call for the Rep on it (and only them), registry on connect, heartbeat, `Last-Event-ID` replay from the ring buffer, a bounded per-connection queue that drops a slow client rather than holding memory; the internal post route the loop uses. Benchmark per-event cost; connections per task measured in 2.20 | 2.8, 2.14 |
| 2.16 | voice | **Call end**: a queued, idempotent job that flushes the Transcript and Suggestion log to S3, copies the Recording (as Opus) and deletes the vendor copy, closes the Call row and publishes `voice.call-ended`. Deleting a Call publishes its deletion. Retention and purge follow ADR 0016 and 0018 | 2.11, 2.13 |
| 2.17 | playbook | Consume `voice.call-ended`: the live Call joins sales history as a Call with the Rep's side known by channel and the Deal id if given, reusing the live Transcript; Moments become searchable when the Deal is won (ADR 0018). Consume Call deletion | 2.3, 2.16 |
| 2.18 | core | Consume `voice.call-ended`: Copilot minutes per Organization for billing; idempotent per Call | 2.3, 2.16 |
| 2.19 | portal | The softphone (dial pad, mute, hold, hang up, microphone permission, the Telnyx WebRTC SDK) and the Copilot panel (live Transcript, streamed Suggestions with their evidence count, use and dismiss, Deal id on the Call). Checked in a real browser with `agent-browser` against the local stack | 2.9, 2.15 |
| 2.20 | portal | Call history: a Rep sees only their own Calls, a Manager their Team's, an Admin and Owner all; Transcript, Suggestions and Recording playback | 2.16 |
| 2.21 | infra | voice in both Regions on Fargate (control, loop and edge as separate services that scale on their own load), ElastiCache Valkey, load balancer idle timeouts for websockets and SSE, a public webhook route and the media websocket route, internal routes kept private (ADR 0013), egress without NAT for voice, secrets | 2.8 |
| 2.22 | hub | Local stack and smoke test: `bun run dev` runs voice with the fake vendor and the scripted transcriber; `dev:smoke` places a fake Call that streams a recorded WAV and asserts the Disclosure came first, a Suggestion arrived, the Call ended with its artefacts, and a second Organization saw none of it | 2.13, 2.15, 2.16 |
| 2.23 | hub | **The evaluation set**: 30 to 50 recorded two-sided Calls with hand-marked Prospect turns where a Suggestion helps and what good advice is; a replay harness that runs them through the loop offline; a quality rubric graded by people and a model. Decides Haiku 5.5 against Sonnet 5.5 and the gate thresholds; evaluates Laya, a small fine-tuned classifier and a one-token Haiku router for the gate (issue 64) | 2.13 |
| 2.24 | hub | **The vendor trial**: 20 to 30 recorded 8 kHz sales Calls through AssemblyAI (default and tuned turn settings) and Deepgram Flux: word error rate per side, end-of-turn latency against the acoustic end, 8 kHz mu-law against 16 kHz PCM. Records the result in the research report and closes ADR 0021. **creds** | 2.6 |
| 2.25 | hub | **The phase 2 load test** against the target below, with results recorded here | 2.20, 2.21, 2.22, 2.24 |

Steps with no "after" (2.1, 2.3, 2.4, 2.5, 2.7) start in parallel. Steps 2.2, 2.23 and 2.24 can run
alongside the build; 2.2 blocks only the real adapters and the end of the phase.

## Hot paths

Each is named in the voice or playbook `AGENTS.md`, has a benchmark in `bench/` with a budget, and
states its complexity in the PR (ADR 0009).

| Hot path | Complexity | Budget |
| --- | --- | --- |
| Media frame handling (2.11) | O(frame) per frame; O(window) memory per Call, bounded by turn count and characters | benchmark: per-frame cost at about 5 times its measured typical time |
| Live Transcript window update (2.11) | O(turn) per turn; the window is a bounded ring | the same |
| The gate (2.13) | O(turn length) | under 1 ms at p95 |
| Prompt assembly (2.13) | O(window + retrieved items), both bounded; the cached prefix is never rebuilt | under 2 ms at p95 |
| `copilotContext` retrieval (2.12) | O(query) + O(candidates, at most 100) for each of two searches, one embedding, one indexed read; nothing grows with the Organization | 300 ms p95 warm, real adapters; off the critical path when prefetched |
| SSE event delivery (2.15) | O(1) registry lookup per Call, then O(1) per event; O(connections) per edge task | under 100 ms p95 loop task to browser, in-Region |
| Call end (2.16) | O(Transcript length) once, queued, never on a request path | not on the Suggestion budget |

**The end-to-end budget**, from the Prospect's acoustic end of turn to the Suggestion's first words on
screen, p95:

| Stage | Budget |
| --- | --- |
| End of turn detected (transcriber, tuned) | 700 ms |
| Gate and prompt assembly | 5 ms |
| Retrieval (prefetched; fresh only on a miss, with a 250 ms deadline) | 50 ms |
| Model first token (Haiku 5.5, thinking off, cached prefix) | 500 ms |
| Loop task to edge to browser, and render | 150 ms |
| **Total** | **about 1,400 ms** |

The end of turn and the model's first token are unmeasured for our setup; 2.24 and 2.13 measure them
first. If end of turn misses its 700 ms, the fallbacks in order are tuning the turn settings, Deepgram
Flux (ADR 0021), and an open turn model on CPU. If the model misses its 500 ms, the fallback is a
faster host for the same class of model, which has no documented EU region.

## Consent and Disclosure

ADR 0003 applies as written. In phase 2 that means:

- **Every Copilot Call plays the Disclosure**, that the Call is recorded and that AI assists, before
  any audio is transcribed or recorded. An outbound Call plays it when the Prospect answers; an
  inbound Call plays it before the Rep is connected. No Organization, role, flag or environment
  turns it off, and the code has no path that starts the stream without the vendor's confirmation.
- **Fail closed.** If the Disclosure does not play, the Call goes on as a plain phone Call with no
  Recording, no Transcript and no Copilot, and the Rep sees why.
- **The record.** Each Call stores which wording version played and when, as evidence.
- **A Rep may cold-call.** ADR 0003's Contact Consent covers contact an Agent starts; a Rep's Call
  needs none, and the Disclosure still plays. The Copilot never places, answers or speaks on a Call.
- **The Prospect objects.** The Rep can stop the Recording and the Copilot for the rest of the Call
  with one control; the streams close at once. What happens to what was already captured is a legal
  question below.
- **Data.** Recordings, Transcripts, Suggestions and Prospect numbers are tenant data: never logged,
  kept in the Organization's Region, deleted on erasure including the vendors' copies. The Transcript
  and model output are untrusted data (COMMON.md); the model has no tools and its output reaches only
  the Rep.
- **Voice Profiles** are not built in phase 2. When they are, a Voice Profile needs its owner's
  recorded consent (glossary), and an Agent using one still opens with the AI and recording
  announcement (ADR 0003).

## Load test

The phase 2 target (ADR 0009), on the dev environment in one Region:

- **2,000 concurrent simulated Calls**: a fake vendor streaming recorded audio, the scripted
  transcriber with end-of-turn timings drawn from the 2.24 trial, real retrieval against turbopuffer
  and Postgres, and the model replaced by a stand-in with Haiku's measured first-token distribution.
  Pass: Suggestion p95 within 1.5 s, no lost turn, no cross-Organization event, three Postgres writes
  a Call.
- **Kill a loop task and an edge task under load.** Pass: their Calls resume Suggestions within 5 s
  and no Call drops.
- **50 concurrent real Calls** end to end with Telnyx, AssemblyAI and Bedrock (about $60 at list).
  Pass: the same p95.
- **A capacity statement**: Calls per loop task, connections per edge task, Valkey operations per
  Call, and the named ceilings on the way to 1,000,000 concurrent Calls (vendor concurrency terms,
  turbopuffer's 16 concurrent queries per unpinned namespace, Call starts per second in Postgres).

The owner may raise the simulated count; 2,000 is enough to find per-task limits without paying for
a large fleet.

## Exit criteria

- A Rep can place and take a Call in the portal; the Disclosure plays first on every Call, proved by
  a test and by the smoke test.
- Suggestions meet the 1.5 s p95 target in the load test.
- A second Organization cannot see, join or receive events from the first one's Calls (tests in voice,
  playbook and the smoke test).
- A finished Call has its Recording, Transcript and Suggestion log in its Region, and its Moments are
  searchable once its Deal is won.
- ADR 0020 and 0021 are Accepted or replaced.
- Every repo's `bun run verify` is green in CI.

## Decisions that need the owner

**Money**
- Confirm Telnyx (ADR 0020) and AssemblyAI streaming (ADR 0021), or choose the runners-up.
- A budget for the trial and the load test (the real-Call part is about $60 at list; the vendor trial
  is under $50).
- Telnyx's Growth plan ($2,000 a month of spend for 15% off) once volume justifies it, and the spend
  at which we move to our own media layer (proposed: about $25,000 a month).
- The Copilot's price to customers. At list, a Rep on the phone 6 hours a working day costs us about
  $166 a month on the managed path.

**Vendor accounts**
- Telnyx: account, business profile, numbers, STIR/SHAKEN and branded caller ID registration.
- AssemblyAI: streaming on the existing account, and an enterprise agreement for concurrency above
  100 new streams a minute before launch.
- Bedrock: access to Haiku 5.5 and Sonnet 5.5 in the US and EU regions we deploy to.
- turbopuffer credentials (hub issue 48) are still needed for real retrieval.

**Legal**
- The Disclosure wording, its languages, and whether it satisfies all-party recording consent in the
  US states that need it and recording rules in the EU.
- What happens to audio and text already captured when a Prospect objects mid-Call.
- Written EU processing terms from Telnyx (stored data is pinned; processing is best-effort today)
  and the same no-training and deletion terms from AssemblyAI for live audio as for batch (issue 81).
- Whether live Calls join the Playbook automatically (the plan assumes yes, once a Deal id is given),
  and whether ADR 0018's rights confirmation covers them.
- How long live Recordings are kept, and the notice an Organization gives its own Reps.

**Product**
- Whether phone numbers belong to a Rep or to the Organization, and whether inbound Calls to a Rep are
  in phase 2 (the plan assumes both directions).

## Not verified yet

- Every latency figure in the budget table except retrieval's phase 1 benchmark.
- Telnyx's concurrency limits and EU processing; AssemblyAI's accuracy on our 8 kHz audio.
- Connections per Bun SSE task, and Calls per loop task.
- That Bedrock's EU profile for Haiku 5.5 routes only within the EU.
