# Phase 2 — The live Copilot

## Goal

A Rep places or takes a phone Call from a softphone in the portal. Every Call opens with the
Disclosure, is recorded, and is transcribed live, one channel per side. When the Prospect finishes a
turn, the Copilot shows the Rep a Suggestion drawn from the Organization's Playbook and from how
similar moments went in won Deals, within 1.5 s at p95. The Rep sees advice only, never another
Call's words ([ADR 0029](../adr/0029-copilot-advice-only-no-quotes.md)). When the Call ends, its
Recording, Transcript and Suggestions are stored in the Organization's Region, and once its Deal is
won the Call joins the Playbook so later Calls learn from it.

The vendors, prices and the cost model behind this plan are in
[`docs/research/2026-10-copilot-vendors.md`](../research/2026-10-copilot-vendors.md). The owner's
decisions of 2026-10-14 are recorded in [ADR 0027](../adr/0027-telephony-telnyx-behind-a-call-port.md)
(telephony), [ADR 0028](../adr/0028-streaming-speech-to-text-assemblyai-one-stream-per-side.md) (live
transcription), [ADR 0029](../adr/0029-copilot-advice-only-no-quotes.md) (advice only) and the
section "Owner decisions" below.

Out of scope: the Inbound Agent and Voice Profiles (phase 3), the Outbound Agent (phase 4), a Manager
listening to a live Call, and languages other than English. Voice Profiles plug in on the same media
path in the other direction: an Agent's synthesized voice goes back down the bidirectional stream that
the Copilot only listens to. Nothing in phase 2 synthesizes speech.

## Target

- **Latency.** A Suggestion's first words on the Rep's screen within **1.5 s of the Prospect's
  acoustic end of turn, p95**, on both the prefetch-hit and the prefetch-miss path, measured end to
  end in the load test.
- **Scale.** Nothing on a Call's path grows with the Organization or with the number of Calls:
  per-Call work is bounded, live state is in Valkey, and Postgres sees a fixed, counted number of
  writes a Call (see Storage). Capacity grows by adding tasks and, past one Region's ceiling, Region
  deployments (ADR 0001).
- **Cost.** About $1.27 per Rep-hour at list on the managed path, about $0.81 on our own media layer,
  and about $0.43 with negotiated rates nobody has quoted yet (research report, section 7; all three
  are totals across every line). The model and retrieval are under 2% of it; telephony and
  transcription are the levers.

## Architecture

```
 Rep's browser (portal)                         Telnyx                         Prospect's phone
  softphone (WebRTC SDK) ── browser leg ──►  Call Control  ◄── PSTN leg ──────────────────┘
  Copilot panel ◄── SSE ── edge task              │ webhooks (signed)     │ media stream, both tracks
                               ▲                  ▼                       ▼
                               │            voice: control          voice: call loop task
                               │            (REST, webhooks)        ├─ two transcriber streams (AssemblyAI)
                               │                  │                 ├─ live Transcript window  ──► Valkey
                               └── direct post ───┼──────────────── ├─ gate ─► retrieval ─► gate ─► model (Haiku 5.5)
                                  (registry in    │                 ├─ overlap check (ADR 0029)
                                   Valkey)        ▼                 └─ Suggestions ──► edge ──► browser
                                            Postgres `voice`                   │
                                            (counted writes)      playbook internal route: one embedding,
                                                  │               Moments + documents, identifiers stripped
                                    Call end ─► S3 (Recording, Transcript, Suggestion log, audit)
                                              ─► queue `voice.call-ended` ─► playbook (joins sales history)
                                                                            ─► core (metering)
```

### The Call path

- The portal asks voice for a short-lived softphone credential (Telnyx WebRTC) for the signed-in Rep.
  An outbound Call is placed through voice, which checks the caller's role and Organization and
  creates the Call; an inbound Call to a Rep's number is routed by voice to that Rep's browser.
  **Plan default, pending the owner:** Owners, Admins, Managers and Reps may all place Calls, and an
  inbound Call goes to the member who holds the number.
- Vendor webhooks are verified by their Ed25519 signature and refused when their signed timestamp is
  more than 5 minutes from voice's clock, before anything else is done with them. They are deduped
  on the vendor's event id with a set-if-absent key in Valkey (TTL 24 h), not in Postgres. Every
  vendor call has a timeout and a bounded, jittered retry.
- **The Disclosure plays first** (see Consent and Disclosure). Only when the vendor confirms playback
  finished does voice record "Disclosure confirmed" on the Call row and start the media stream and
  the recording.
- **Fail mode (owner decision).** If the Disclosure, the recording or the transcriber fails to start,
  the Call goes on as a plain phone Call with no Recording, no Transcript and no Suggestions, and the
  Rep is told why. Our outage never blocks a Call.

### The media path

- Telnyx streams both tracks over one websocket to a voice task, as 16 kHz linear PCM. The two tracks
  are the two sides, so the speaker of every word is known exactly.
- The task holding the stream owns the Call's live loop. It downsamples each side and sends it as one
  mono stream to the transcriber (8 kHz mu-law for both, a quarter of the bytes of 16 kHz PCM, if the
  trial shows no accuracy loss).
- **Egress.** Voice tasks reach the vendors through an internet gateway from tasks with public
  addresses and no inbound access except from the load balancer, not through a NAT gateway, whose
  $0.045 a GB would be paid on every second of audio; ADR 0013 rule 5 still allows a deliberately
  configured egress proxy for vendor calls later.
- If the task dies, the stream drops. Any voice task sees the Call's missed heartbeat in Valkey and
  restarts the stream through Call Control, **but only after reading "Disclosure confirmed" from the
  Call's Postgres row**, never from Valkey alone. The new owner rebuilds from the live Transcript in
  Valkey. The Rep loses a few seconds of Suggestions, never the Call.

### The transcript stream

- The transcriber returns immutable turns per side and an end-of-turn event on the Prospect's side.
- The live Transcript window (the last turns, bounded by count and characters) lives in Valkey under
  the Call, with a TTL. Coalesced updates (stable text, a few times a second, never every partial
  word) go to the Rep's screen.
- No transcript text goes to Postgres while the Call runs.

### Retrieval

- A new internal playbook route serves the Copilot: **one embedding** of the latest turns feeds a
  Moment search (won Deals) and a document search in parallel, returning both, bounded, with the
  evidence count. It reuses phase 1's search functions and their checks (Postgres decides
  eligibility; the vector tag is a hint), and it **strips Prospect identifiers from Moment text with
  kit's scrubber before returning it** (ADR 0029). Retrieved text goes to voice only, never to the
  portal.
- **Internal calls (ADR 0013).** voice calls playbook and core with kit's `createInternalClient`,
  which ignores proxy variables, using voice's own secret for each receiver; playbook and core accept
  it beside their existing callers' secrets, two at a time during rotation. The Organization comes
  from the Call, because Moment search is open only to Owners and Admins and the Rep's token must not
  widen that.
- **Prefetch.** Retrieval runs on the Prospect's stable partial text while they are still talking,
  each time about 8 new stable words have arrived and at most once a second. At end of turn, a result
  covering at least 60% of the turn's words is reused (a **hit**); otherwise retrieval runs fresh with
  a 150 ms deadline (a **miss**), and past the deadline the Suggestion is made without evidence rather
  than late. **Assumed hit rate: 80%** of the turns that pass the first gate (an estimate; misses
  concentrate on short turns, which the first gate mostly drops). The load test measures the rate and
  the p95 of each path separately. About 600 retrievals a Call-hour, about $0.01 a Rep-hour.
- **Warm at Call start.** voice asks playbook to warm the Organization's namespace when a Call starts
  (an idle turbopuffer namespace answers its first query in about 0.9 s).

### The Suggestion loop

1. End of turn on the Prospect's stream.
2. **The first gate** (code, budget 1 ms): Prospect turns only; skip backchannels and turns under about
   four words; a cooldown of about 20 s after a Suggestion unless the turn is a question; at most
   about 30 Suggestions a Call-hour and the per-Rep daily cap (ADR 0029, 400 a UTC day to start); never
   while the Rep is talking.
3. Retrieval: the prefetch on a hit, fresh on a miss.
4. **The second gate** (code, budget 1 ms): skip if the top Moments match the last Suggestion's. It is
   skipped when a miss returned nothing.
5. **The model**: Claude Haiku 5.5 on Bedrock (EU profile in the EU Region), thinking off, at most
   about 120 output tokens, streamed, no tools, told to advise in its own words and never quote. The
   prompt is ordered for the cache: the fixed system prompt, the Organization's **Playbook brief**
   (built by a queued job in playbook, step 2.27), the Call's turns so far, then the retrieved
   material and the latest turn.
6. **The overlap check** (ADR 0029): the Suggestion streams with the last 5 words held back, and every
   6-word run is checked against a hashed set of the retrieved text's runs; on a match the Suggestion
   is withdrawn from the screen. The output is also checked for length and control characters. It is
   shown only to the Rep, never spoken, never sent to the Prospect.
7. Tokens stream to the edge task holding the Rep's connection and on to the browser. The Rep can mark
   a Suggestion used or dismissed (deduped in Valkey); those marks are the labels for the gate
   evaluation (issue 64).
8. An **audit entry** (Rep, Call, time, evidence ids, shown or blocked) is kept with the Call's live
   state for every retrieval that reached the model, and written out at Call end (ADR 0029).

About 20 model calls a Call-hour are expected; thresholds are configuration, tuned on the evaluation
set.

### Transport to the portal

Server-Sent Events from edge tasks that hold browser connections and nothing else. An edge task
records `Call → edge` in Valkey on connect; the Call's loop task looks it up and posts to it directly.
Each Call keeps a short event ring buffer in Valkey so a reconnect to any edge replays what was
missed with `Last-Event-ID`. The Rep's actions are plain POSTs. No sticky sessions, no pub/sub
channel per Call. Every Valkey use goes through kit's key-value port (step 2.14).

### Call history and who sees which Call

**Plan default, pending the owner, following the glossary:** a Rep sees their own Calls, a Manager
the Calls of the Reps on their Teams, an Admin and the Owner every Call in the Organization.

- **Team scope.** The access token carries the user, Organization and role but no Teams. voice asks
  core for a Manager's Reps through a new internal route (step 2.26) with a 1 s timeout and one
  jittered retry, and caches the answer in Valkey for 60 s. If core does not answer, the request
  fails with `server.unavailable` and a Retry-After; it never falls back to a wider scope. A Team
  claim in the token was rejected: a change of Team would wait for the token to expire, and the token
  is capped at 4,096 characters. A Manager's scope is capped at 1,000 Reps in phase 2 (plan default).
- **Routes** (contract step 2.3): list Calls with a cursor (default 25, at most 100 a page); get one
  Call; its Transcript, by cursor over turns (at most 500 a page); its Suggestions, by cursor, with
  evidence counts and no retrieved text; and a Recording playback URL.
- **Playback.** After the same scope check, voice returns a presigned URL for the Recording object
  that expires in 5 minutes. The URL is never logged, and each issue is counted on the Call.

### Storage of Call artefacts

| What | Where | When written |
| --- | --- | --- |
| The Call (Organization, Rep, direction, Prospect number, Deal id if given, Disclosure version and time, start, end, artefact keys, audit count) | Postgres, `voice` schema, row-level security | see the count below |
| Live Transcript window, Call state, heartbeat, event ring buffer, `Call → edge`, dedupe keys, caps, audit entries until Call end | Valkey through kit's key-value port, TTL | continuously; never the system of record |
| Recording (dual-channel, copied from Telnyx then deleted there, stored as Opus) | S3 in the Region | after the Call ends |
| Transcript (all turns, per side, with times), in the versioned format defined in the contract (step 2.3) | S3 in the Region, one object | once, at Call end |
| Suggestion log (what was shown, when, evidence ids and scores only, used or dismissed) and retrieval audit (ADR 0029) | S3 in the Region, one object each | once, at Call end |
| Moments of the Call | playbook, through its sales history path (ADR 0018); playbook reads the Transcript from voice's internal route, never re-transcribes | on `voice.call-ended` |
| Copilot minutes | core, metering | on `voice.call-ended` |

**Postgres writes per Call.** voice: the Call insert and its idempotency key (2), "Disclosure
confirmed" (1), the Call-end work hint registered and cleared (2, ADR 0017), the consumed message of
the Call-end job (1), and the closing update (1): **7**. Webhooks, Rep actions and transcriber events
are deduped in Valkey, never in Postgres. Consumers of `voice.call-ended`: playbook's consumed message
and its Call import (about 5, ADR 0018's path) and core's consumed message and metering row (2). **About
14 a Call across the Region's Postgres.** At 1,000,000 concurrent Calls of 6 minutes on average that is
about 2,800 Calls and 39,000 writes a second in one Region, which the capacity statement must address
(batching core's metering per Organization is the first lever).

The end of a Call is a queued, idempotent job (it survives the task that ran the Call): flush,
copy the Recording, write the objects, close the row, publish `voice.call-ended`. A Call whose loop
task vanished is ended by the heartbeat watchdog the same way. A deleted Call in voice removes its
Moments in playbook by an event, as ADR 0016 does for documents.

**Live Calls join the Playbook (owner decision).** By default a live Call's Moments become searchable
once its Deal is won, through ADR 0018's rules. The Owner can switch this off for the Organization.
Lead's reading: switching it off stops new Calls joining; Calls already joined stay until deleted.

## Services and repos touched

| Repo | What phase 2 adds |
| --- | --- |
| hub | this plan, ADR 0027 to 0029, the glossary terms Suggestion and Disclosure, the evaluation set, the vendor trial, local stack and smoke test for voice, the load test |
| contract | the `voice` area: Call routes and Call history, Suggestion and transcript event schemas, the Transcript artefact format, `voice.*` error codes, the `voice.call-ended` message; the internal Copilot retrieval and warm routes and the live-Calls setting in the `playbook` area; core's internal Team-scope route |
| db | the `voice` schema and role; the live-Calls setting and the Playbook brief in the `playbook` schema |
| kit | the live transcriber port (separate from kit's batch `Transcriber`) with memory and AssemblyAI adapters; the key-value port with TTL, memory and Valkey adapters. The Bedrock model client stays in voice until a second consumer exists |
| voice | **new repo**: the service, the call port and Telnyx adapter, the media loop, the gates, the Suggestion loop and overlap check, the SSE edge, Call history, Call end |
| playbook | the internal Copilot retrieval and warm routes, the Playbook brief job, importing live Calls and the Owner's switch |
| core | the internal Team-scope route; Copilot metering per Organization |
| portal | the softphone and the Copilot panel; Call history with Transcript and Recording |
| infra | voice in both Regions, Valkey, the websocket and SSE ingress, webhook ingress, egress without NAT, secrets |

## Steps

Each step is one ticket. "After" lists the steps that must be merged first. Library steps land and
are tagged before the steps that consume them. Steps marked **creds** run on fakes until the owner's
accounts exist, as phase 1 did.

| Step | Repo | What | After |
| --- | --- | --- | --- |
| 2.1 | hub | Research and decision records: this plan, the vendor report, ADR 0027 to 0029 | — |
| 2.2 | hub | **ready-for-human.** Accounts and open terms: Telnyx account, business profile, numbers and STIR/SHAKEN registration; written EU terms (Telnyx processing, AssemblyAI); AssemblyAI streaming concurrency; Bedrock access to Haiku 5.5 in both Regions; the lawyer-checked Disclosure wording; the plan defaults marked pending the owner | 2.1 |
| 2.3 | contract | The `voice` area: start, answer and end a Call; softphone credential; Rep actions on a Suggestion; **Call history**: list (cursor, default 25, at most 100), get, Transcript (cursor over turns, at most 500), Suggestions (cursor, evidence counts, no retrieved text), Recording playback URL; the SSE event schemas (transcript update, Suggestion start, token, withdraw, end, Call state) with a version field; the **Transcript artefact format** (versioned turns with side, times and text) and voice's internal route that serves it; `voice.*` error codes; the `voice.call-ended` message. In the `playbook` area: the internal `copilotContext` and warm routes (turns in, scrubbed Moments and passages out, both bounded) and the Owner's live-Calls setting. In the `core` area: the internal Team-scope route (a Manager's Rep ids, at most 1,000). Release a tag | — |
| 2.4 | db | The `voice` schema and database role: Calls (with Disclosure version and time, audit count), phone numbers, consumed messages, idempotency keys, the Call-end work hint kind (ADR 0017); fail-closed row-level security. In the `playbook` schema: the live-Calls setting and the Playbook brief (versioned, per Organization). Release a tag | — |
| 2.5 | kit | Live transcriber port: open a stream per side, push audio, receive immutable turns and end-of-turn events, close; separate from the batch `Transcriber` port. A memory adapter that replays a scripted Transcript with timings; one behaviour suite. Release a tag | — |
| 2.6 | kit | AssemblyAI Universal-Streaming adapter passing the 2.5 suite: EU endpoint by Region, timeouts, bounded jittered reconnect, turn settings from configuration, nothing logged but ids. **creds** | 2.5 |
| 2.7 | hub | Create `tula-closeline-voice` with `scripts/new-repo.sh`; add it to the sync list and CI | — |
| 2.8 | voice | Service skeleton from `templates/service`: library tags, container, env (`ENVIRONMENT`, `REGION`), token middleware, error handler, OpenAPI, health and readiness, queue, storage and the key-value port on memory adapters, kit's internal client for playbook and core. `AGENTS.md` names the hot paths below | 2.3, 2.4, 2.5, 2.7, 2.14 |
| 2.9 | voice | Call port with memory adapter and a fake vendor for local development; Telnyx adapter: softphone credential, place and receive Calls, webhooks verified by signature with a 5-minute timestamp tolerance and deduped in Valkey on event id, play the Disclosure and confirm, start and stop the stream and the dual-channel recording, fetch and delete the Recording. Roles per the plan default. A second Organization cannot start, see or end the first one's Calls. **creds** for the adapter | 2.8 |
| 2.10 | voice | **The Disclosure gate and fail mode.** Every Call plays the Disclosure before media flows. The stream and recording start only after the vendor's playback-finished event has been written to the Call row. If the Disclosure, the recording or the transcriber fails to start, the Call continues with none of them, and the Rep is told why. No setting, flag or role can skip the Disclosure. Tests: no audio frame reaches the transcriber before confirmation; a failed playback starts nothing and the Call stays up; a transcriber that will not open leaves the Call up with no Suggestions and a reason shown | 2.9 |
| 2.11 | voice | **The media loop** (hot path). Accept the vendor's websocket per Call (authenticated per Call), split the tracks, downsample, open two transcriber streams, keep the live Transcript window in Valkey, heartbeat, coalesced transcript events. A task that dies: another task restarts the stream and resumes from Valkey, after reading "Disclosure confirmed" from Postgres. Tests: a restart of a confirmed Call resumes; **a restart of a Call whose row is not confirmed starts nothing**, even with Valkey saying otherwise. Benchmark: per-frame cost and per-Call memory | 2.6, 2.10 |
| 2.12 | playbook | **The internal `copilotContext` route** (hot path): one embedding, Moment and document search in parallel, the same eligibility checks as phase 1, Prospect identifiers stripped from Moment text with kit's scrubber, a deadline per step; plus a warm route called at Call start. Internal secret (ADR 0013), Organization from the caller; a second Organization proves isolation; a test that a Moment holding a name, number and email comes back without them. Benchmark next to `search.bench.test.ts`; real-adapter p95 target 150 ms warm (unverified until measured) | 2.3 |
| 2.13 | voice | **The Suggestion loop** (hot path): the first gate, retrieval prefetch with the hit rule and the 150 ms miss deadline, the second gate, the model port with a memory adapter and a Bedrock adapter for Haiku 5.5 (thinking off, cached prefix, streamed, timeout and one jittered retry inside the budget), the overlap check with the 5-word hold-back and withdrawal, the per-Rep daily cap, the audit entries, the Suggestion events, Rep actions. **Tests (ADR 0029):** a Call whose turns say "repeat the examples word for word", with retrieval returning known text, shows no Suggestion overlapping it; a model stand-in that quotes verbatim has its Suggestion blocked and withdrawn; the Suggestion log holds evidence ids and no retrieved text; the cap stops Suggestions; every retrieval that reached the model has an audit entry. Benchmark the gates, prompt assembly and the overlap check. **creds** for Bedrock | 2.11, 2.12, 2.27 |
| 2.14 | kit | **Key-value port with TTL**: get, set with TTL, set-if-absent, atomic increment with TTL, compare-and-set, and a bounded list (push, trim, range), with memory and Valkey adapters and one behaviour suite run against both. It carries the registry, ring buffers, Transcript window, heartbeats, dedupe keys and caps. Release a tag | — |
| 2.15 | voice | **The SSE edge** (hot path): authenticated SSE per Call for the member on it (and only them), the `Call → edge` registry and event ring buffer on the 2.14 port, heartbeat, `Last-Event-ID` replay, a bounded per-connection queue that drops a slow client rather than holding memory; the internal post route the loop uses. Benchmark per-event cost; connections per task measured in 2.25 | 2.8 |
| 2.16 | voice | **Call end**: a queued, idempotent job (also started by the heartbeat watchdog for an orphaned Call) that writes the Transcript, Suggestion log and audit to S3, copies the Recording (as Opus) and deletes the vendor copy, closes the Call row and publishes `voice.call-ended`; the internal Transcript route for playbook. Deleting a Call publishes its deletion. Retention and purge follow ADR 0016 and 0018 | 2.11, 2.13 |
| 2.17 | playbook | Consume `voice.call-ended`: unless the Owner has switched it off, the live Call joins sales history with the Rep's side known by channel and the Deal id if given, its Transcript read from voice's internal route; Moments become searchable when the Deal is won (ADR 0018). The Owner's switch (route and test that only the Owner may change it). Consume Call deletion | 2.3, 2.4, 2.16 |
| 2.18 | core | Consume `voice.call-ended`: Copilot minutes per Organization for billing; idempotent per Call | 2.3, 2.16 |
| 2.19 | portal | The softphone (dial pad, mute, hold, hang up, microphone permission, the Telnyx WebRTC SDK) and the Copilot panel (live Transcript, streamed Suggestions with their evidence count and no retrieved text, withdrawal, use and dismiss, Deal id on the Call, the reason when the Copilot is off). Checked in a real browser with `agent-browser` against the local stack | 2.9, 2.15 |
| 2.20 | voice, portal | Call history: the routes of 2.3 in voice, with the Team scope from 2.26 and the playback URL; the portal pages. Tests: a Rep cannot list or open another Rep's Call; a Manager sees only their Teams'; a core outage fails closed; a second Organization sees nothing | 2.16, 2.26 |
| 2.21 | infra | voice in both Regions on Fargate (control, loop and edge as separate services that scale on their own load), ElastiCache Valkey, load balancer idle timeouts for websockets and SSE, a public webhook route and the media websocket route, internal routes kept private (ADR 0013), egress through an internet gateway without NAT for voice, secrets including voice's internal secrets for playbook and core | 2.8 |
| 2.22 | hub | Local stack and smoke test: `bun run dev` runs voice with the fake vendor and the scripted transcriber; `dev:smoke` places a fake Call that streams a recorded WAV and asserts the Disclosure came first, a Suggestion arrived without retrieved text, the Call ended with its artefacts, and a second Organization saw none of it | 2.13, 2.15, 2.16 |
| 2.23 | hub | **The evaluation set**: 30 to 50 recorded two-sided Calls with hand-marked Prospect turns where a Suggestion helps and what good advice is; a replay harness that runs them through the loop offline; a quality rubric graded by people and a model. Tunes the gate thresholds and the overlap check's run lengths (how often it blocks useful advice), and confirms Haiku 5.5's quality. Once real Calls have produced a few thousand use and dismiss labels, runs Laya as a shadow gate (ONNX on CPU and on one GPU host) against the rule gate, measuring dismissed Suggestions avoided against latency and hosting cost (issue 64; Jev is not evaluated, research report section 6a) | 2.13 |
| 2.24 | hub | **The vendor trial**: 20 to 30 recorded 8 kHz sales Calls through AssemblyAI (default and tuned turn settings) and Deepgram Flux: word error rate per side, end-of-turn latency against the acoustic end (the 700 ms p95 line of ADR 0028), 8 kHz mu-law against 16 kHz PCM. Records the result in the research report. **creds** | 2.6 |
| 2.25 | hub | **The phase 2 load test** against the target below, with results recorded here | 2.20, 2.21, 2.22, 2.24 |
| 2.26 | core | Internal Team-scope route: a Manager's Rep user ids in the Organization, at most 1,000, behind the internal secret (ADR 0013), accepting voice's secret; a second Organization proves isolation | 2.3 |
| 2.27 | playbook | **The Playbook brief**: a queued, idempotent job that builds a per-Organization brief of at most about 3,000 tokens from its Documents (product, pricing, positioning, objections) with Haiku 5.5, stored versioned; rebuilt when a Document is added or removed, debounced; served to voice through the `copilotContext` warm route. Text from Documents only, so it holds nothing a Rep may not read | 2.3, 2.4 |

Steps with no "after" (2.1, 2.3, 2.4, 2.5, 2.7, 2.14) start in parallel. Steps 2.2, 2.23 and 2.24 can
run alongside the build; 2.2 blocks only the real adapters and the end of the phase.

## Hot paths

Each is named in the voice or playbook `AGENTS.md`, has a benchmark in `bench/` with a budget, and
states its complexity in the PR (ADR 0009).

| Hot path | Complexity | Budget |
| --- | --- | --- |
| Media frame handling (2.11) | O(frame) per frame; O(window) memory per Call, bounded by turn count and characters | benchmark: per-frame cost at about 5 times its measured typical time |
| Live Transcript window update (2.11) | O(turn) per turn; the window is a bounded ring | the same |
| The first and second gates (2.13) | O(turn length); O(top Moments) for the second | under 1 ms each at p95 |
| Prompt assembly (2.13) | O(window + retrieved items), both bounded; the cached prefix is never rebuilt | under 2 ms at p95 |
| Overlap check (2.13) | O(retrieved words) to hash the runs once, then O(1) per output word | under 1 ms per Suggestion; the 5-word hold-back adds about 25 ms of display delay |
| `copilotContext` retrieval (2.12) | O(query) + O(candidates, at most 100) for each of two searches, one embedding, one indexed read, scrubbing O(returned text); nothing grows with the Organization | 150 ms p95 warm, real adapters (unverified until measured) |
| SSE event delivery (2.15) | O(1) registry lookup per Call, then O(1) per event; O(connections) per edge task | under 75 ms p95 loop task to browser, in-Region |
| Call end (2.16) | O(Transcript length) once, queued, never on a request path | not on the Suggestion budget |

**The end-to-end budget**, from the Prospect's acoustic end of turn to the Suggestion's first words on
screen, p95. With 20% misses, the overall p95 falls inside the miss path, so the miss path must meet
1.5 s on its own:

| Stage | Hit path | Miss path |
| --- | --- | --- |
| End of turn detected (transcriber, tuned; ADR 0028's switch line) | 700 ms | 700 ms |
| First gate | 1 ms | 1 ms |
| Retrieval | 5 ms (reuse the prefetch) | 150 ms (deadline, then no evidence) |
| Second gate and prompt assembly | 3 ms | 3 ms |
| Model first token (Haiku 5.5, thinking off, cached prefix) | 500 ms | 500 ms |
| Overlap hold-back | 25 ms | 25 ms |
| Loop task to edge to browser, and render | 100 ms | 100 ms |
| **Total** | **about 1,335 ms** | **about 1,480 ms** |

End of turn, retrieval on real adapters and the model's first token are all unmeasured for our setup;
2.24, 2.12 and 2.13 measure them first. If end of turn misses its 700 ms, the fallbacks in order are
tuning the turn settings and Deepgram Flux (ADR 0028), then an open audio turn model on CPU. If the
model misses its 500 ms, the fallback is a faster host for the same class of model, which has no
documented EU region. Laya and Jev cannot shorten any stage (research report, section 6a).

## Consent and Disclosure

ADR 0003 applies as written. In phase 2 that means:

- **Every Copilot Call plays the Disclosure**, that the Call is recorded and that AI assists, before
  any audio is transcribed or recorded. An outbound Call plays it when the Prospect answers; an
  inbound Call plays it before the Rep is connected. No Organization, role, flag or environment
  turns it off, and the code has no path that starts the stream without the confirmation on the Call
  row, including a restart after a task dies.
- **Fail mode (owner decision).** If the Disclosure, the recording or the transcriber fails to start,
  the Call goes on as a plain phone Call with no Recording, no Transcript and no Suggestions, and the
  Rep sees why. The Call itself is never blocked by our outage.
- **The record.** Each Call stores which wording version played and when, as evidence.
- **A Rep may cold-call.** ADR 0003's Contact Consent covers contact an Agent starts; a Rep's Call
  needs none, and the Disclosure still plays. The Copilot never places, answers or speaks on a Call.
- **The Prospect objects. Plan default, pending the owner:** the Rep can stop the Recording and the
  Copilot for the rest of the Call with one control, and the streams close at once. What happens to
  what was already captured is a legal question below.
- **Advice only (ADR 0029).** A Rep sees paraphrased advice, never another Call's words or a
  Prospect's identifiers; quotes are blocked by a check, not only by an instruction.
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
  Pass: Suggestion p95 within 1.5 s **reported separately for prefetch hits and misses**, with the hit
  rate measured against the 80% assumption; no lost turn; no cross-Organization event; Postgres
  writes per Call as counted under Storage.
- **Kill a loop task and an edge task under load.** Pass: their Calls resume Suggestions within 5 s,
  no Call drops, and no stream restarts on a Call without a confirmed Disclosure.
- **50 concurrent real Calls** end to end with Telnyx, AssemblyAI and Bedrock (about $60 at list).
  Pass: the same p95 on both paths.
- **A capacity statement**: Calls per loop task, connections per edge task, Valkey operations per
  Call, and the named ceilings on the way to 1,000,000 concurrent Calls:
  - query embeddings at about 600 a Call-hour, about 167,000 a second at 1,000,000 Calls, against the
    Bedrock quota for Cohere Embed v4 in the Region (the query model cannot be swapped for a cheaper
    one, ADR 0010);
  - turbopuffer at two queries per retrieval, and its 16 concurrent queries per unpinned namespace
    for the largest Organizations;
  - Postgres at about 14 writes a Call, about 39,000 a second;
  - vendor concurrency terms for Telnyx and AssemblyAI.

The owner may raise the simulated count; 2,000 is enough to find per-task limits without paying for
a large fleet.

## Exit criteria

- A Rep can place and take a Call in the portal; the Disclosure plays first on every Call, proved by
  a test and by the smoke test.
- Suggestions meet the 1.5 s p95 target on both the hit and the miss path in the load test.
- No Suggestion shows retrieved text verbatim, proved by the 2.13 tests and the smoke test.
- A second Organization cannot see, join or receive events from the first one's Calls (tests in voice,
  playbook, core and the smoke test).
- A finished Call has its Recording, Transcript, Suggestion log and audit in its Region, and its
  Moments are searchable once its Deal is won unless the Owner switched that off.
- Every repo's `bun run verify` is green in CI.

## Owner decisions (2026-10-14)

- **Telephony:** Telnyx (ADR 0027, Accepted).
- **Live transcription:** AssemblyAI, one stream per side (ADR 0028, Accepted).
- **Suggestion model:** Claude Haiku 5.5 on Bedrock.
- **Live Calls join the Playbook** by default once the Deal is won; the Owner can switch it off.
- **Rep access: advice only, no quotes** (ADR 0029), with identifiers stripped, an overlap check, evidence
  ids only in the log, a per-Rep daily cap and an audit of retrievals.
- **Fail mode:** if recording or transcription fails at the start, the Call continues with no Recording,
  Transcript or Suggestions, and the Rep is told why. A Call is never blocked by our outage.

## Still open for the owner

**Plan defaults, pending the owner**
- Who may place Calls: Owners, Admins, Managers and Reps.
- Who sees which Calls: a Rep their own, a Manager their Teams' Reps' (at most 1,000), Admins and the
  Owner all.
- The Rep's control to stop the Recording and the Copilot when a Prospect objects.
- Whether phone numbers belong to a member or to the Organization, and whether inbound Calls to a Rep
  are in phase 2 (the plan assumes both directions).

**Money**
- A budget for the vendor trial (under $50) and the load test (the real-Call part is about $60 at
  list).
- Telnyx's Growth plan ($2,000 a month of spend for 15% off) once volume justifies it, and the spend at
  which we move to our own media layer (proposed: about $25,000 a month).
- The Copilot's price to Organizations. At list, a Rep on the phone 6 hours a working day for 22
  working days costs us about $168 a month on the managed path.

**Vendor accounts**
- Telnyx: account, business profile, numbers, STIR/SHAKEN and branded caller ID registration.
- AssemblyAI: streaming on the existing account, and an enterprise agreement for concurrency above
  100 new streams a minute before launch.
- Bedrock: access to Haiku 5.5 in the US and EU regions we deploy to, and a raised quota for Cohere
  Embed v4 query embeddings.
- turbopuffer credentials (hub issue 48) are still needed for real retrieval.

**Legal**
- The Disclosure wording, its languages, and whether it satisfies all-party recording consent in the
  US states that need it and recording rules in the EU.
- What happens to audio and text already captured when a Prospect objects mid-Call.
- Written EU processing terms from Telnyx (stored data is pinned; processing is best-effort today),
  needed before the first EU Call, and the same no-training and deletion terms from AssemblyAI for
  live audio as for batch (issue 81).
- Whether ADR 0018's rights confirmation covers live Calls joining the Playbook.
- How long live Recordings are kept, and the notice an Organization gives its own Reps.

## Not verified yet

- End-of-turn latency on our audio, Haiku 5.5's first-token time with thinking off on Bedrock, and the
  Copilot retrieval route's latency on real adapters from our Regions; only the retrieval benchmark
  over doubles exists today.
- The 80% prefetch hit rate.
- Telnyx's concurrency limits and EU processing; AssemblyAI's accuracy on our 8 kHz audio.
- Connections per Bun SSE task, and Calls per loop task.
- That Bedrock's EU profile for Haiku 5.5 routes only within the EU; the Bedrock embedding quota we
  can get.
- How often the overlap check blocks useful advice.
