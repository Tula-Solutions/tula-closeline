# Closeline Copilot vendors: telephony, live transcription, the Suggestion model and transport

Prices and limits were read on 2026-10-14 unless noted. Source keys in square brackets, like [T1], are listed with their URLs at the end. Anything marked "(unverified)" came from memory, an inference, or a single secondary source. Anything marked "(secondary)" came from a third-party site. Anything marked "(vendor claim)" is the vendor's own number. Anything marked "(estimate)" is my arithmetic on stated assumptions.

Page text came through a summarising fetch tool, not raw HTML, so a number may have been mis-summarised. I did not see instructions aimed at AI agents in any result, and I would have ignored them.

The job: a Rep places or takes a phone Call from a softphone in the portal. Both sides of the audio reach the voice service live, are transcribed, and the Copilot shows the Rep a Suggestion within 1.5 s of the Prospect finishing a turn, p95. The Call is recorded. The owner's goals are millions of concurrent users, optimised algorithms and the lowest cost. Phase 1 already gives us Moment search over won Deals and document search (playbook service, `src/modules/search`).

## 1. Recommendations

| Area | Choice | Cost per Rep-hour (list) | Runner-up |
| --- | --- | --- | --- |
| Telephony and softphone | **Telnyx**: WebRTC SDK, Call Control, media stream of both tracks as 16 kHz linear PCM, dual-channel recording | $0.87 to $0.99, telephony only | Twilio ($1.49); at volume, our own media layer (self-hosted LiveKit and a SIP trunk, $0.42 to $0.54, telephony only) |
| Live transcription | **AssemblyAI Universal-Streaming**, one mono stream per side, no diarization, EU endpoint | $0.30 | Deepgram Flux ($0.68 to $0.78), for its faster end of turn |
| Suggestion model | **Claude Haiku 5.5 on Amazon Bedrock**, thinking off, cached prefix, US and EU profiles | about $0.004 with gating ($0.01 without) | Claude Sonnet 5.5 only if the evaluation shows a gap worth about 18 times the cost |
| Transport to the portal | **Server-Sent Events from our own edge tasks** on Fargate behind the load balancer, with a Valkey registry of which edge holds which Call | about $0.0003 | AppSync Events for a pilot below about 10,000 connections |
| When to speak | **The vendor's end of turn on the Prospect's stream, then our own rule gate**, with retrieval prefetched during the turn | no added vendor; retrieval about $0.01 | Laya as a shadow gate, evaluated once we have labelled Calls (issue 64; section 6a). Jev, its hosted sibling, is not recommended |

**Total, at list prices on the managed path: about $1.27 per Rep-hour** (section 7), of which telephony is about three quarters and transcription about a quarter. The model, retrieval and transport together are about 1%. The cost work that matters is therefore telephony and transcription, not the model. Section 7 works the cost at 1,000, 100,000 and 1,000,000 concurrent Calls.

Two choices are hard to reverse, cost real money and need accounts, so they are drafted as Proposed decision records for the owner: telephony (ADR 0027) and live transcription (ADR 0028).

## 2. Telephony and softphone

The Copilot Call is one browser WebRTC leg, one US outbound PSTN leg, both sides streamed to our websocket, and recording.

| | Twilio | Telnyx | Vonage | Plivo | Own media: self-hosted LiveKit and Telnyx trunk | LiveKit Cloud and trunk | Amazon Chime SDK |
|---|---|---|---|---|---|---|---|
| US outbound PSTN, per min | $0.0140 [T1] | $0.005 SIP plus $0.002 Voice API [T2] | about $0.014 (secondary) [T9] | $0.0115 [T3] | $0.005 [T2] | $0.005 plus $0.003 to $0.004 LiveKit SIP [T5] | $0.0048 Voice Connector [T4] |
| US inbound local, per min | $0.0085 | from $0.0032 | about $0.0049 (secondary) | $0.0055 | from $0.0032 | $0.01 on a LiveKit number | $0.0029 |
| Browser (WebRTC) leg, per min | $0.0040 | $0.002 | unverified | $0.0033 | our compute only | $0.0004 to $0.0005 per participant | $0.0017 per attendee |
| Audio stream to our service, per min | $0.0044 [T11] | $0.0035 [T2] | about $0.0046 (unverified for the US) | included | none: our worker joins the room | $0.001 track egress | Kinesis rate not found |
| Recording, per min | $0.0025 plus storage | $0.002, storage free | unverified | free, storage free 90 days | ours | ours | $0.0028 |
| Number rental, per month | $1.15 | $1.00 | unverified | $0.50 | about $1 | $1.00 | not found for local numbers |
| Stream audio format | 8 kHz mu-law (unverified) | PCMU, PCMA, G.722 at 8 kHz; Opus 8 or 16 kHz; L16 at 16 kHz [T6] | linear PCM at 8, 16 or 24 kHz, both directions [T7] | unverified | our choice | our choice | PCM through Kinesis (unverified) |
| EU | Media Streams in Ireland (IE1), no Frankfurt [T11]; SDK edges in Dublin and Frankfurt [T10] | Frankfurt, London, Amsterdam; stored data pinned by Data Locality, processing best-effort, not contractual [T14] | unverified | unverified | ours to place | Enterprise region pinning | AWS EU regions |

Cost of one Copilot Call (estimate, no volume discounts, the stream billed once with both tracks):

| Option | Per Call-minute | Per Rep-hour |
| --- | --- | --- |
| Twilio | $0.0249 | $1.49 |
| **Telnyx** | $0.0145 to $0.0165 (the higher if the Voice API fee applies to both legs, unverified) | **$0.87 to $0.99** |
| Plivo | $0.0148 | $0.89 |
| Vonage | about $0.025 (unverified) | about $1.50 |
| LiveKit Cloud and trunk | about $0.012 to $0.014 | about $0.72 to $0.84 |
| **Own media layer: self-hosted LiveKit and a Telnyx trunk** | about $0.007 to $0.009 | **about $0.42 to $0.54** |
| Amazon Chime SDK | about $0.010 to $0.013 (unverified) | about $0.60 to $0.78 |

Notes:

- **Telnyx** is the cheapest managed option. Its stream carries both tracks, works in both directions (needed by the Inbound Agent in phase 3), and offers 16 kHz linear PCM, which the transcriber accepts without transcoding. Only one stream is allowed per Call [T6]. Its Growth plan gives 15% off for $2,000 a month of spend [T2]. I found no published concurrency limit.
- **Telnyx in the EU** keeps stored data in the EU when Data Locality is set, but the docs call processing in the EU best-effort [T14]. ADR 0001 needs more than that. It is the open point in ADR 0027: written terms from Telnyx, or a second adapter for the EU Region (Twilio's Ireland region is the candidate).
- **Twilio** has dual-channel recording (`RecordingChannels=dual`) [T8], a default of one call per second raisable to five [T12], and committed-use discounts through sales. Its Elastic SIP trunk is $0.0100 a minute outbound [T13].
- **Plivo** includes streaming and recording, but I could not confirm its stream format, dual-channel recording or EU presence.
- **Own media layer.** LiveKit and its SIP bridge on EC2 hosts (RTP and Fargate do not suit each other), with TURN, a worker fleet that forwards audio to the transcriber, and S3 for Recordings. LiveKit Cloud's Scale plan stops at 5,000 concurrent connections; above that it is Enterprise pricing [T5]. At 1,000,000 concurrent Calls, 60 million Call-minutes an hour at $0.007 is about $420,000 an hour (estimate); only carrier contracts with committed minutes reach that, and the media layer has to be ours.
- **STIR/SHAKEN and caller ID** (general knowledge, not fetched). US carriers sign calls; full attestation needs us verified as the number's owner. Each vendor has a business-profile and branded-calling registration flow. Reps calling from their own numbers need that per number.

**Recommendation: Telnyx for Phase 2, behind a call port, with the own media layer as the planned move once telephony spend passes about $25,000 a month** (about 150 Reps on the phone full time at list price), or when Telnyx will not commit to our concurrency, or when a large Organization needs the EU media path under our control.

## 3. Live transcription

We receive each side of the Call as its own channel, so two mono streams give exact speaker attribution without diarization. Costs are per stream-hour at list; a Rep-hour is two streams.

| Vendor and model | Per stream-hour | Rep-hour | End of turn | EU | Concurrency |
|---|---|---|---|---|---|
| **AssemblyAI Universal-Streaming** | $0.15 [S3] | **$0.30** | Confidence-based: a turn ends when confidence passes 0.4 and 400 ms of silence have passed, with a silence fallback at 1,280 ms; all three are tunable [S15] | `streaming.eu.assemblyai.com`, same price [S3] | 100 new streams a minute on pay-as-you-go; more by agreement [S3] |
| AssemblyAI Universal-3.6 Pro Realtime | $0.45 | $0.90 | Punctuation-based; 537 ms median (vendor claim, secondary) [S5] | Yes | Described as unlimited (vendor claim, secondary) |
| Deepgram Flux | $0.39 pay-as-you-go, $0.342 Growth [S1] | $0.68 to $0.78 | About 260 ms (vendor claim); an early end-of-turn event for speculative work, at the cost of 50 to 70% more downstream calls [S2] | `api.eu.deepgram.com` | 150 streams pay-as-you-go, 225 Growth, more by agreement [S1] |
| Deepgram Nova-3 | $0.288, $0.252 Growth | $0.50 to $0.58 | Endpointing only | Yes | Same |
| Speechmatics Linden 1 / Melia 1 / Standard | $0.30 / $0.40 / $0.45 [S6] | about $0.60 to $0.90 | Not read | EU, US or Australia [S6] | Not read |
| ElevenLabs Scribe v2 Realtime | $0.39 [S10] | about $0.78 | About 150 ms (vendor claim), voice activity with manual commit | Not confirmed | Not read |
| Soniox | about $0.10 to $0.12 (secondary) [S11] | about $0.20 to $0.24 | Not read | Not confirmed | Not read |
| Amazon Transcribe streaming | $0.60 in the page's example [S9] | $0.60 (two channels billed as one duration) | Not read | AWS EU regions | Not read |
| OpenAI realtime transcription models | about $1.02 (estimate from $0.017 a minute) [S7] | about $2.04 | Not read | Not found | Not read |
| Google Speech-to-Text V2 | $0.96 at tier 1, falling to $0.24 above 2 million minutes a month (secondary) [S8] | about $1.92 at list | Not read | Regional (unverified for Chirp 3) | Not read |
| Gladia | $0.25 to $0.75 (secondary) [S12] | $0.50 to $1.50 | Not read | Not confirmed | Not read |
| Azure AI Speech | the page rendered no prices [S13] | quote needed | | | |

Notes:

- **AssemblyAI bills streaming by session time, silence included** [S3]. Open a stream when the Disclosure has finished and close it at hang-up.
- **Deepgram's streaming rates are labelled promotional** against higher struck-through prices [S1]; plan for them to rise.
- **Accuracy.** I found no independent word error rate on 8 kHz sales Calls. AssemblyAI's and Deepgram's figures are their own. The trial in section 8 measures it on our audio.
- **Self-hosting.** NVIDIA's only data point is a full voice-agent pipeline at 64 parallel streams on three H100s, with transcription at 40 to 67 ms [S14]. I found no streams-per-GPU figure for transcription alone, so I cannot price it. At 1,000,000 concurrent Calls (2,000,000 streams) a cloud bill of $0.15 a stream-hour is $300,000 an hour, which makes measuring self-hosting worth a ticket long before that size.

**Recommendation: AssemblyAI Universal-Streaming, two mono streams, EU endpoint.** It is the cheapest option with confirmed EU processing, we already have an account and terms in progress (issue 81), and its tunable confidence-based end of turn fits our gate. **Runner-up: Deepgram Flux**, if the trial shows AssemblyAI's end of turn too slow for the budget in section 6.

## 4. The Suggestion model

A Suggestion is short: 40 to 80 output tokens. The input is a fixed system prompt, a per-Organization Playbook brief, the Call so far and the retrieved Moments and passages.

| Model | Input / output per million tokens | Cache read per million | Latency (Artificial Analysis, median) [M4] | EU path |
|---|---|---|---|---|
| **Claude Haiku 5.5** | $0.10 / $0.50 (above 100,000 input tokens, $0.50 / $2.50) [M10] | $0.01; 5-minute write $0.125, 1-hour write $0.20 [M3] | 237 tokens a second; time to first token is published only with reasoning on | Bedrock EU profile |
| Claude Sonnet 5.5 | $2 / $10 | $0.20 (0.1x) [M10] | 0.86 s at low effort, 92 tokens a second | Bedrock EU profile |
| Claude Haiku 4.5 | $1 / $5 | $0.10 | not read | Bedrock |
| OpenAI GPT-6 Luna (secondary) [M7] | $0.10 / $0.50 | $0.01 | 0.90 s without reasoning, 111 tokens a second | not confirmed |
| Gemini 3.5 Flash-Lite [M8] | $0.30 / $2.50 | $0.03 | reasoning only, 425 tokens a second | not confirmed |
| gpt-oss-20b on Groq (secondary) [M9] | $0.075 / $0.30 | not found | 0.72 s, 226 tokens a second | no EU region found |
| Amazon Nova Micro (secondary) | about $0.04 / $0.14 | not found | 0.84 s, 268 tokens a second | Bedrock EU |

Notes:

- **Haiku 5.5 runs adaptive thinking by default at medium effort.** Thinking can be turned off at effort `high` or below. With it on, the published time to first token is several seconds, which is useless here. We must turn it off and measure first-token time ourselves, from our own tasks in each Region; no published figure fits our setup.
- **Caching.** The minimum cacheable prefix on the 5.5 models is 512 tokens [M3]. Order the prompt as: fixed system prompt, then the Organization's Playbook brief (both cached, shared by every Call in the Organization), then the Call's turns so far (cached as it grows, since requests in one Call come well inside 5 minutes of each other), then the retrieved material and the latest turn (not cached). The 5-minute cache refreshes free on each read, so the 1-hour write is not needed.
- **Bedrock.** The models are `anthropic.claude-haiku-5-5` and `anthropic.claude-sonnet-5-5`; access to both is "See Access", so the owner requests it in the console [M6]. Regional and geography profiles (US, EU) cost 10% more than the global endpoint [M6][M10], and the EU Region must use the EU profile. The first-party API's `inference_geo` offers only US and global [M10], so Bedrock is the path for both Regions, and it keeps Claude inside the existing AWS relationship, as ADR 0010 did for embeddings. Whether the EU profile routes only within the EU geography should be confirmed, as ADR 0010 noted for Cohere.
- **Prompt injection.** The Transcript is untrusted: a Prospect can say anything. The model has no tools, its output only ever reaches the Rep's screen, it is length-capped and checked, and it is never spoken. That bounds what an injected instruction can do to a bad Suggestion.

Cost per Rep-hour (estimate; 3,000 cached prefix tokens, 800 uncached input tokens and 60 output tokens per Suggestion; one cache write an hour):

| Model | 60 calls an hour | 20 calls an hour (gated) |
| --- | --- | --- |
| **Claude Haiku 5.5** | $0.0088 ($0.0097 on a Bedrock geography profile) | **$0.0032 ($0.0035)** |
| Claude Sonnet 5.5 | $0.175 | $0.064 |
| Claude Haiku 4.5 | $0.085 | $0.030 |
| GPT-6 Luna (secondary) | about $0.0084 | about $0.003 |

**Recommendation: Claude Haiku 5.5 on Bedrock with thinking off.** It costs under a cent a Rep-hour. The quality question (is Haiku good enough, or is Sonnet worth 18 times more) is answered by the offline evaluation in the plan, not by guessing. If Haiku's measured first-token time at p95 misses its budget, the fallback is a faster host (Groq, Cerebras), which has no documented EU region.

### Laya and Jev (issue 64)

Both are decision models, not text generators, so neither can write a Suggestion. Where they could fit is section 6a.

## 5. Transport to the portal

Traffic is almost all from server to browser: transcript updates a few times a second and a Suggestion every minute or two. Assume about 3 messages a second of about 300 bytes, which is about 10,900 messages and 3.2 MB per connection-hour.

| Option | Price | Limits | Per connection-hour (estimate) |
|---|---|---|---|
| API Gateway WebSocket [W1][W2] | $1.00 per million messages, $0.25 per million connection-minutes | 500 new connections a second by default, 2-hour maximum, 10-minute idle timeout | $0.011 |
| AppSync Events [W3] | $1.00 per million operations, $0.08 per million connection-minutes | not read | $0.011 |
| Ably [W7] | $2.50 per million messages, $1.00 per million connection-minutes | not read | $0.027 |
| Pusher [W8] | tiers to 30,000 connections (secondary) | capped | not viable |
| **Our own SSE or WebSocket edge on Fargate behind a load balancer** [W4][W5] | Fargate Graviton about $0.032 a vCPU-hour; load balancer $0.008 an LCU-hour (an LCU is 3,000 active connections, 25 new a second or 1 GB an hour) | no Bun capacity benchmark found; Centrifugo's guidance is 50,000 to 100,000 connections a node [W6] | about $0.0003, mostly data transfer out |

Total per hour (estimate):

| Concurrent | API Gateway or AppSync, 3 messages a second | Same, coalesced to 1 a second | Own edge |
|---|---|---|---|
| 1,000 | about $11 | about $3.60 | about $0.60 |
| 100,000 | about $1,080 | about $360 | about $35 |
| 1,000,000 | about $10,900 | about $3,600 | about $330 |

**Recommendation: Server-Sent Events from our own edge tasks.** SSE suits one-way traffic, reconnects on its own with `Last-Event-ID`, and runs over HTTP/2. The Rep's actions (use, dismiss, end the Call) are plain POSTs. The fan-out pattern:

- An edge task holds browser connections and nothing else. On connect it records `Call → edge address` in Valkey with a short TTL that its heartbeat refreshes.
- The task running the Call's live loop looks up the edge once and posts events to it directly over the private network, re-reading the registry only when a post fails. Valkey serves lookups, not every message, so there is no pub/sub channel per Call.
- Each Call keeps a short ring buffer of recent events in Valkey, so a reconnect to any edge replays what was missed. The load balancer needs no sticky sessions.
- A heartbeat comment every 15 to 30 s keeps idle-timeout proxies from cutting the stream.

Managed options cost 30 times more at transcript rates and only make sense for a pilot below about 10,000 connections. Coalescing transcript updates (send stable text a few times a second, never every partial word) cuts messages and browser work on any option.

## 6. When the Copilot speaks

The budget is 1.5 s at p95 from the Prospect's acoustic end of turn to the first words of a Suggestion on the Rep's screen. Calling the model on every word would blow both the cost and the Rep's attention.

**Turn detection.** Silence alone is a poor signal: people pause mid-thought, and a fixed silence long enough to be safe is slow. Current practice combines silence with a model of whether the words sound finished:

- AssemblyAI ends a turn when its end-of-turn confidence passes a threshold (default 0.4) and a minimum silence has passed (default 400 ms), falling back to silence alone at a maximum (default 1,280 ms). Its documented aggressive preset is 160 ms and 400 ms [S15].
- Deepgram Flux claims about 260 ms and emits an early end-of-turn event [S2].
- Open models: Pipecat's Smart Turn v3 (BSD-2, about 8 MB, 12 ms on a modern CPU and about 60 ms on a small AWS instance by its authors' figures) [K1][K2]; LiveKit's turn detector, whose open v1-mini runs on CPU [K3]. A 2026 paper found acoustic and prosodic signals beat adding text, at 400 ms median latency and 0.93 F1 [K4].
- Humans leave about 200 to 300 ms between turns; most voice agents take 800 to 1,500 ms (secondary) [K5].

We do not need to answer the Prospect; we need to advise the Rep, who is also about to speak. A Suggestion that lands 1 s after the turn ends is useful; one that lands 3 s later is not. So the vendor's signal is enough to start with, tuned on our trial Calls, and an open turn model on CPU is the fallback if the vendor's end of turn misses its budget.

**The gate** decides, in code and in microseconds, whether a finished Prospect turn earns a model call. It has two parts, because one rule needs retrieval's answer.

Before retrieval (budget 1 ms):

1. Only the Prospect's turns trigger. The Rep's turns update context only.
2. Skip short or empty turns: fewer than about four words, or only a backchannel ("yeah", "mm-hmm", "right").
3. Cool down: no new Suggestion for about 20 s after the last one, unless the turn is a question.
4. Caps: at most about 30 Suggestions per Call-hour, and the per-Rep daily cap of ADR 0029.
5. Never suggest while the Rep is already speaking over the Prospect.

After retrieval (budget 1 ms):

6. Skip when retrieval returns the same top Moments as the last Suggestion. With no retrieval result (a miss past its deadline), this rule is skipped and the Suggestion is made without evidence.

The thresholds are configuration, tuned on the evaluation set. The expected rate is about 20 model calls a Call-hour, which section 4 prices.

**Retrieval** comes from phase 1. Moment search embeds the last few turns (at most 6 turns and 2,000 characters, `MAX_SEARCH_TURNS` in the contract), searches the Organization's namespace for up to 100 candidates tagged won, and checks each Call's state in Postgres; its real-adapter p95 target is 800 ms. Three changes make it fit a live budget:

- **Embed once, search twice.** One query embedding feeds both the Moment search and the document search, in parallel, from one internal route. Today they are two routes and two embeddings.
- **Prefetch during the turn.** Retrieval runs on the Prospect's stable partial transcript while they are still talking, each time about 8 new stable words have arrived and at most once a second, and the result is reused at end of turn when it covers at least 60% of the turn's words (a hit). Otherwise retrieval runs fresh at end of turn with a 150 ms deadline (a miss). **Assumed hit rate: 80% of the turns that pass the first gate** (estimate, unmeasured). The misses concentrate on short turns, which the first gate mostly drops, so the real rate may be higher; the load test measures it and the p95 of hits and misses separately.
- **Warm the namespace when the Call starts.** turbopuffer answers the first query of an idle namespace in about 0.9 s (vendor figure, ADR 0010); a warm query is about 14 ms.

Three limits matter at scale. turbopuffer allows 16 concurrent queries per namespace unless it is pinned [ADR 0010's report], which a large Organization with thousands of Reps on the phone can reach in bursts. Query embeddings run at the prefetch rate, about 600 an hour per Call: at 1,000,000 concurrent Calls that is about 167,000 embeddings a second in a Region, far above any default Bedrock quota (Cohere's own rate limit is 2,000 inputs a minute [ADR 0010's report]), and the query model cannot be swapped for a cheaper local one because query and index vectors must come from the same model (ADR 0010). And Moment search is open only to Owners and Admins (`SALES_HISTORY_READ_ROLES`), so a Rep's Copilot reaches it through an internal service route (ADR 0013), never with the Rep's token.

**Retrieval cost** (estimate) at the prefetch rate: the Prospect speaks about half of a Call-hour at about 150 words a minute, about 4,500 words, so a retrieval every 8 new words is about 600 an hour, which also covers the fresh retrievals on misses. Each is one embedding of about 100 tokens (Cohere Embed v4 on Bedrock; its price was not confirmed from a primary source, so I use the secondary $0.12 per million figure for Embed v5 Pro from ADR 0010's report as a stand-in: about $0.007 an hour) and two turbopuffer queries, each billed at the 1.28 GB minimum at $0.001 per TB queried plus about 10 KB returned at $0.05 a GB (about $0.003 an hour). **About $0.01 a Rep-hour**, more than the model, and still under 1% of the total.

## 6a. Laya and Jev: can they make the Copilot faster or cheaper?

The owner asked: "Is there a way we can use Laya or JEV to speed things up?" Researched on 2026-10-14.

**What they are.**

- **Laya** (`convaiinnovations/laya`, Apache-2.0) is an open, non-generative decision model on ModernBERT-large (421 million parameters; a 322-million-parameter multilingual variant on mmBERT-base). It takes a state plus typed questions (choose one, score, yes or no) and returns answers with probabilities in one pass; it never writes text. By its authors' figures: about 33 to 40 ms a question on a T4 GPU, 193 to 464 ms a request on CPU once loaded, 7 to 10 s to load; an ONNX build for CPU exists. It scores near chance before fine-tuning (0.362 on its typed-decisions benchmark, 0.766 after), ships over-confident (calibration error 0.466, 0.081 after fitting a temperature per question type), and is weak with many options (0.425 on a 77-way task) [J1].
- **"JEV" is almost certainly Jev, TypeSafe AI's hosted "System One" decision model** (`typesafe/jev-1.13`, released in early access on 2026-09-15). It answers the same kind of typed question through a hosted API, and Laya's `laya-serve` copies Jev's request shape, so Laya is in effect Jev's self-hostable open counterpart. I found no weights or licence for Jev; it is API-only. Its maker claims 70 to 500 ms end to end; Laya's model card gives Jev a p50 of 236 to 276 ms from third-party data; a secondary source reports about $0.042 per million input tokens. Everything about Jev here is secondary [J5][J6][J7][J1].
- **Other readings ruled out.** No turn-detection, speech or embedding model named JEV was found. The nearest matches are a 2017 paper on joint lexical and prosodic embeddings for turn-taking [J8] and two 2026 turn-detection papers (JAL-Turn, FastTurn) whose names do not match [J9][J10]. JEPA-style "joint embedding" models are unrelated to Laya. If the owner meant something else, the name needs checking with them.

**Where each could act in the Copilot path.**

| Stage | Laya | Jev | Why |
| --- | --- | --- | --- |
| End of turn | No | No | Both read text, not audio. The end-of-turn signal comes from the transcriber's own model, and the open fallback is an audio turn model (Smart Turn, section 6), not a text classifier |
| The gate | **Possible, as a shadow first** | Not recommended | The rule gate costs under 1 ms. Laya would add 35 to 40 ms on a GPU or 200 to 460 ms on CPU, so it cannot make a Suggestion faster. It can only make Suggestions better targeted: fewer wasted model calls, fewer Suggestions the Rep dismisses. Jev adds a network round trip of 70 to 500 ms and sends Prospect text to an early-access vendor, which our data rules (no unredacted text leaves the process) and ADR 0001 (EU text stays in the EU) would both have to clear |
| Retrieval | No | No | Neither embeds or searches. Deciding to skip retrieval for some turns is the gate again |
| The Suggestion | No | No | Neither writes text. The model call stays |

**Expected gain, cost and risk of a Laya gate.**

- **Latency: none.** In parallel with retrieval prefetch it adds nothing to the critical path when on a GPU; in series on CPU it costs up to 460 ms, a third of the budget.
- **Money: at best cents.** A gated Suggestion costs about $0.0002 in model and retrieval (section 4 and 6). Suppressing, say, a third of 20 Suggestions an hour saves about $0.001 a Rep-hour. One always-on GPU host (g6.xlarge, about $0.80 an hour on demand, about $580 a month) costs more than that saving until about 700 Reps are on the phone at once, and it is a GPU service to run on ECS outside Fargate (ADR 0008).
- **Quality: the real prize, and unproven.** If it halves the Suggestions a Rep dismisses, the Copilot is less noisy; that is worth measuring, not assuming.
- **Data: a few thousand labelled turns** (my estimate; the card gives no figure). The Rep's use and dismissal of each Suggestion are those labels, so the Copilot produces them as it runs.
- **Risk:** a young model with author-only figures, over-confident until calibrated on our data, English and multilingual checkpoints only.

**Answer.** Neither makes the Copilot faster: the time goes to end-of-turn detection and the model's first token, and neither model touches those. Laya can be tried later as a shadow gate once real Calls have produced labels, to see whether it cuts dismissed Suggestions; it does not belong on the launch path. Jev is not recommended: it is hosted, slower than our rule gate, early-access, and would send Prospect text to a new subprocessor. Effort for speed goes into the end-of-turn tuning, retrieval prefetch and the model's first token instead.

## 7. Cost model

Per Rep-hour, meaning one Call-hour with a Rep using the Copilot. List prices except where a row says otherwise. "Media compute and transfer" is the voice service's tasks plus data sent to the transcriber; sending 8 kHz mu-law (16 KB a second for both sides) instead of 16 kHz PCM (64 KB a second) cuts the transfer from about 230 MB to about 58 MB an hour, and the voice tasks must not send that audio through a NAT gateway, which adds $0.045 a GB.

| Line | 1,000 concurrent: managed path at list | 100,000 concurrent: own media layer, list rates | 1,000,000 concurrent: own media layer, negotiated rates (assumed) |
| --- | --- | --- | --- |
| Telephony | $0.93 (Telnyx; the midpoint of $0.87 to $0.99) | $0.48 (Telnyx trunk and self-hosted LiveKit) | $0.25 (assumes a carrier rate of $0.003 a minute plus $0.07 of media hosts) |
| Live transcription, two streams | $0.30 | $0.30 | $0.15 (assumes half price by agreement or self-hosting; unmeasured) |
| Suggestion model, gated | $0.0035 | $0.0035 | $0.0035 |
| Retrieval, at the prefetch rate | $0.01 | $0.01 | $0.01 |
| Transport to the portal | $0.0006 (fixed costs dominate) | $0.00035 | $0.00033 |
| Media compute and transfer | $0.02 | $0.01 | $0.01 |
| Live state (Valkey) and Call records (Postgres) | $0.005 | $0.002 | $0.002 |
| **Total per Rep-hour** | **about $1.27** | **about $0.81** | **about $0.43** |
| **Per hour across all Calls** | **about $1,270** | **about $81,000** | **about $430,000** |

How to read it:

- At list prices, a Rep on the phone 6 hours a working day for 22 working days a month (132 Rep-hours) costs about $168 a month on the managed path and about $107 on the own media layer. Pricing the Copilot is the owner's call, but it has to clear that.
- The model is not the cost. Choosing Sonnet over Haiku for every Suggestion adds about $0.06 a Rep-hour; a better telephony contract saves ten times that.
- Telephony alone on the own media layer is $0.42 to $0.54 a Rep-hour (section 2); the totals above include every line.
- The 1,000,000 column rests on two assumptions nobody has priced: a carrier contract at $0.003 a minute, and transcription at half the list price. Both need quotes before any commitment at that size.
- Capacity grows by Region deployments (ADR 0001). A million concurrent Calls is not one Region's Postgres: at an average Call of 6 minutes it is about 2,800 Call starts a second, so the plan keeps voice to six Postgres writes a Call, dedupes webhooks and Rep actions in Valkey, and keeps the live Transcript in Valkey (the plan counts the writes, consumers included).

## 8. What to do next

1. Ask Telnyx, in writing: EU processing (not only storage), concurrency and calls-per-second limits, Growth plan terms, deletion of Recordings. Ask Twilio the same about its Ireland region, as the fallback.
2. Ask AssemblyAI: an enterprise agreement for streaming concurrency well above 100 new streams a minute, the same no-training, deletion and EU terms as issue 81, and committed-use pricing.
3. Request Haiku 5.5 and Sonnet 5.5 access on Bedrock in the US and EU regions we deploy to.
4. Trial on 20 to 30 recorded two-sided sales Calls at 8 kHz: word error rate per side, and end-of-turn latency against the acoustic end (AssemblyAI at default and tuned settings, Deepgram Flux for comparison).
5. Measure Haiku 5.5 first-token time with thinking off from a task in each Region, and its Suggestion quality against Sonnet 5.5 on the evaluation set.
6. Load-test a Bun SSE edge task for connections per task; no published figure exists.

## Sources

Accessed 2026-10-14.

- [T1] Twilio US voice pricing: https://www.twilio.com/en-us/voice/pricing/us
- [T2] Telnyx Voice API, SIP and WebRTC pricing: https://telnyx.com/pricing/call-control
- [T3] Plivo US voice pricing: https://www.plivo.com/voice/pricing/us/
- [T4] Amazon Chime SDK pricing: https://aws.amazon.com/chime/chime-sdk/pricing/
- [T5] LiveKit pricing: https://livekit.com/pricing
- [T6] Telnyx media streaming: https://developers.telnyx.com/docs/voice/programmable-voice/media-streaming
- [T7] Vonage WebSocket guide: https://developer.vonage.com/en/voice/voice-api/guides/websockets
- [T8] Twilio Recording API: https://www.twilio.com/docs/voice/api/recording
- [T9] Vonage rates (secondary): https://www.vonage.com/communications-apis/voice/pricing/
- [T10] Twilio Voice JS SDK edges: https://www.twilio.com/docs/voice/sdks/javascript/edges
- [T11] Twilio Media Streams: https://www.twilio.com/docs/voice/media-streams
- [T12] Twilio calls per second and concurrency: https://support.twilio.com/hc/en-us/articles/40868960307995-Understanding-CPS-and-Concurrent-Call-Limits-in-Twilio
- [T13] Twilio Elastic SIP trunking pricing: https://www.twilio.com/en-us/sip-trunking/pricing/us
- [T14] Telnyx in Europe: https://developers.telnyx.com/docs/voice/programmable-voice/voice-api-services-in-europe and https://developers.telnyx.com/docs/account-setup/regional-endpoints
- [S1] Deepgram pricing: https://deepgram.com/pricing
- [S2] Deepgram Flux: https://developers.deepgram.com/docs/flux/quickstart
- [S3] AssemblyAI pricing: https://www.assemblyai.com/pricing
- [S4] AssemblyAI streaming: https://www.assemblyai.com/docs/streaming/universal-streaming
- [S5] AssemblyAI Universal-3.6 Pro Realtime (secondary, via search): https://www.assemblyai.com/blog/universal-3-6-pro-realtime
- [S6] Speechmatics pricing: https://www.speechmatics.com/pricing
- [S7] OpenAI pricing: https://developers.openai.com/api/docs/pricing
- [S8] Google Speech-to-Text pricing (secondary): https://cloud.google.com/speech-to-text/pricing
- [S9] Amazon Transcribe pricing: https://aws.amazon.com/transcribe/pricing/
- [S10] ElevenLabs API pricing: https://elevenlabs.io/pricing/api
- [S11] Soniox comparison (secondary, a competitor's page): https://soniox.com/compare-stt/soniox-vs-cartesia
- [S12] Gladia pricing (secondary): https://support.gladia.io/article/understanding-our-transcription-pricing-pv1atikh8y9c8sw7sudm3rcy
- [S13] Azure Speech pricing: https://azure.microsoft.com/en-us/pricing/details/cognitive-services/speech-services/
- [S14] NVIDIA streaming speech throughput: https://perspectives.nvidia.com/nemotron-speech/task/faq/open-asr-models-throughput-benchmarks/
- [S15] AssemblyAI turn detection: https://www.assemblyai.com/docs/streaming/universal-streaming/turn-detection
- [M3] Claude prompt caching: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- [M4] Artificial Analysis leaderboard: https://artificialanalysis.ai/leaderboards/models
- [M6] Claude in Amazon Bedrock: https://platform.claude.com/docs/en/build-with-claude/claude-in-amazon-bedrock
- [M7] GPT-6 Luna pricing (secondary): https://www.eesel.ai/blog/gpt-6-luna-pricing
- [M8] Gemini pricing: https://ai.google.dev/gemini-api/docs/pricing
- [M9] Groq and Cerebras prices (secondary): https://www.morphllm.com/cerebras-pricing
- [M10] Claude pricing: https://platform.claude.com/docs/en/about-claude/pricing
- [M12] Laya model card: https://huggingface.co/convaiinnovations/laya
- [W1] API Gateway pricing: https://aws.amazon.com/api-gateway/pricing/
- [W2] API Gateway WebSocket limits: https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-execution-service-websocket-limits-table.html
- [W3] AppSync pricing: https://aws.amazon.com/appsync/pricing/
- [W4] Elastic Load Balancing pricing: https://aws.amazon.com/elasticloadbalancing/pricing/
- [W5] Fargate rates (secondary): https://wring.co/blog/aws-fargate-pricing-guide
- [W6] Centrifugo FAQ and million-connection test (vendor claim): https://centrifugal.dev/docs/faq
- [W7] Ably pricing: https://ably.com/docs/pricing
- [W8] Pusher pricing (secondary): https://www.pusher.com/channels/pricing
- [K1] Smart Turn v3 announcement (vendor claim): https://www.daily.co/blog/announcing-smart-turn-v3-with-cpu-inference-in-just-12ms/
- [K2] Smart Turn repository: https://github.com/pipecat-ai/smart-turn
- [K3] LiveKit end-of-turn detection: https://livekit.com/blog/using-a-transformer-to-improve-end-of-turn-detection
- [K4] Acoustic, prosodic and semantic signals for turn detection (paper): https://papers.cool/arxiv/2609.11066
- [K5] Semantic VAD for voice agents (secondary): https://gradium.ai/content/semantic-vad-voice-agents-turn-detection-2026

- [J1] Laya model card: https://huggingface.co/convaiinnovations/laya
- [J5] System One models and Jev (secondary): https://www.datacamp.com/blog/system-one-models-jev
- [J6] Jev listing (secondary): https://zenmux.ai/typesafe/jev-1.13
- [J7] Jev release (secondary): https://infoq.com/news/2026/10/typesafe-ai-jev-released
- [J8] Liu, Ishi and Ishiguro, Interspeech 2017: https://www.isca-archive.org/interspeech_2017/liu17_interspeech.html
- [J9] JAL-Turn: arXiv 2603.26515
- [J10] FastTurn: https://arxiv.org/pdf/2604.01897

## What I could not verify

- Telnyx: EU processing terms, concurrency limits, and whether the Voice API fee applies to both legs.
- Twilio: whether a stream of both tracks bills as one stream or two.
- Vonage's official US rates and EU terms; Plivo's stream format, dual-channel recording and EU presence; the Chime SDK streaming rate.
- Any independent word error rate or end-of-turn latency on 8 kHz sales Calls, for any vendor.
- Streams per GPU for self-hosted live transcription.
- Haiku 5.5's first-token time with thinking off, on Bedrock, from our Regions.
- Haiku 5.5 availability per EU Bedrock region, and whether the EU profile routes only within the EU.
- Connections per Bun SSE task.
- Retention and training defaults of the streaming vendors.
- Anything about Jev from TypeSafe's own documentation: its schema, licence, price and data handling are from secondary sources.
- Laya's accuracy and latency on our turns, and the labelled data it needs.
- The real-adapter latency of retrieval for the Copilot (one embedding, two searches) from our Regions.
- The prefetch hit rate.
