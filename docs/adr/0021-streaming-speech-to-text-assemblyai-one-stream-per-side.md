# ADR 0021 — Live transcription: AssemblyAI Universal-Streaming, one stream per side

**Status:** Proposed (needs the owner: the live trial, concurrency terms and money)
**Date:** 2026-10-14
**Builds on:** ADR 0001, ADR 0003, ADR 0010, ADR 0018, ADR 0020

## Context

The Copilot needs a live Transcript of each Call and a reliable signal that the Prospect has
finished a turn, because the Suggestion target is 1.5 s from the end of the Prospect's turn at p95.
ADR 0010 and ADR 0018 chose AssemblyAI for batch transcription of past Calls. The telephony path
(ADR 0020) delivers each side of a live Call as its own audio channel, so the system already knows
who is speaking.

The comparison, prices and sources are in `docs/research/2026-10-copilot-vendors.md` (section 3).
Prices are list prices read on 2026-10-14.

## Decision

- **AssemblyAI Universal-Streaming**, English first, on the EU endpoint for the EU Region, at $0.15
  per stream-hour.
- **One mono stream per side**, the Rep's and the Prospect's, and **no diarization**. Speaker
  attribution comes from the channel, which is exact, and the diarization add-on ($0.12 an hour) is
  not bought. A Rep-hour costs two streams, $0.30.
- **The vendor's confidence-based end-of-turn signal on the Prospect's stream** is the trigger for a
  Suggestion, tuned below its defaults (a 400 ms minimum and a 1,280 ms maximum of silence) once the
  trial gives data. The Copilot's own gate decides whether to speak (see the phase 2 plan); the
  vendor only says the turn ended.
- **Behind a streaming transcriber port in `tula-closeline-kit`**, with a memory adapter that replays
  a scripted Transcript with timings, so every test and the local stack run without the vendor.
- **Runner-up: Deepgram Flux**, at $0.342 to $0.39 per stream-hour, which reports about 260 ms
  end-of-turn detection (vendor claim) and an early end-of-turn event for speculative work.

Switch to Flux if the trial shows AssemblyAI's end of turn at p95 leaves less than 700 ms of the
1.5 s budget for retrieval, the model and delivery. Switch to Soniox or ElevenLabs if an
independent test shows equal accuracy on 8 kHz calls and EU processing is confirmed in writing,
since Soniox is about $0.10 to $0.12 per stream-hour. Price a self-hosted streaming model when
sustained concurrency is high enough that the bill passes the cost of a GPU fleet and the people to
run it; the research could not find a streams-per-GPU figure to set that line.

## Considered options

- **Universal-3.6 Pro Realtime** at $0.45 per stream-hour: better accuracy by AssemblyAI's own
  numbers, but three times the price and a 537 ms median end-of-turn latency (vendor claim).
- **Deepgram Nova-3** at $0.252 to $0.288: cheaper than Flux, without its turn detection, and with
  default concurrency caps of 150 to 225 streams.
- **One stereo or diarized stream.** Half the stream count on some vendors, but speaker attribution
  becomes a guess, and a Prospect's words in the Rep's column corrupts both the Suggestion and the
  Moments built later (ADR 0018 rejected guessing the Rep for the same reason).
- **OpenAI, Google, Azure, Speechmatics, Gladia.** Dearer, EU residency unconfirmed, or the price
  could not be read.

## Consequences

- One vendor for batch and live transcription keeps one contract, one set of terms and one
  subprocessor entry. It also concentrates the risk, which the port bounds.
- Streaming is billed by session time, silence included, so a stream opens when the Disclosure has
  finished and closes at hang-up, never before or after.
- The published pricing shows no volume tier, and the pay-as-you-go plan opens at most 100 new
  streams a minute. Concurrency far above that needs an enterprise agreement before launch; the
  owner must ask for it.
- The same written terms as ADR 0018 apply before real audio: no training on customer audio, deletion
  timing and EU processing. Live Calls carry the Prospect's voice from the first second.
- The live Transcript of a Call is reused when the Call enters the Playbook (ADR 0018's sales history
  path), so a live Call is never sent for batch transcription.
- Accuracy on our own telephony audio is unmeasured. The trial in the phase 2 plan measures word
  error rate and end-of-turn latency on recorded 8 kHz Calls before the account is committed.
