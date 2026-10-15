# ADR 0020 — Telephony: Telnyx behind a call port, with our own media layer as the way out

**Status:** Proposed (needs the owner: vendor account, money, and EU terms)
**Date:** 2026-10-14
**Builds on:** ADR 0001, ADR 0003, ADR 0006, ADR 0008

## Context

Phase 2 gives a Rep a softphone in the portal. Each Call has a browser leg (WebRTC) and a phone
leg (PSTN), and the audio of both sides has to reach the voice service live, one channel per side,
so the Copilot can transcribe it and the Call can be recorded. Phase 3's Inbound Agent will need the
same path to send audio back. The owner wants the lowest cost and a design that grows to very large
numbers of concurrent Calls. ADR 0001 requires a vendor to work in both Regions, or to be swapped
per Region.

The comparison, prices and sources are in `docs/research/2026-10-copilot-vendors.md` (section 2).
Prices are list prices read on 2026-10-14.

## Decision

- **Telnyx programmable voice** for Phase 2: its WebRTC SDK in the portal for the Rep's leg, Call
  Control for placing and receiving PSTN calls, and its media stream to the voice service with both
  tracks as 16 kHz linear PCM. About $0.015 a Call-minute ($0.87 to $0.99 a Rep-hour) for the browser
  leg, a US outbound phone leg, the stream and recording, against $0.025 ($1.49) for Twilio.
- **Everything goes through a call port in the voice service** (place, answer, hang up, play the
  Disclosure, start and stop the media stream, fetch and delete the Recording, verify webhooks), with a
  memory adapter for tests and a fake vendor for local development. The port is shaped around "a
  call with two audio channels", not around Telnyx's API.
- **The Recording is made by Telnyx** as a dual-channel file and copied into the Organization's
  Region storage when the Call ends, after which the vendor copy is deleted. Building the Recording
  ourselves from the stream is the step taken with the move below.
- **The way out at volume is our own media layer**: a SIP trunk (Telnyx first, about $0.005 a minute)
  into self-hosted LiveKit with its SIP bridge, on EC2 hosts rather than Fargate (ADR 0008 lists GPUs,
  not RTP, as its EKS trigger; this is a second reason to leave Fargate for this one component).
  Estimated $0.42 to $0.54 a Rep-hour.
- **Runner-up for the managed path: Twilio**, at about 1.7 times the price, if Telnyx cannot meet the
  EU terms below.

Switch to the own media layer when any of these holds: managed telephony spend passes about $25,000
a month; Telnyx will not commit to the concurrency or calls per second we need; or an enterprise
customer needs the EU media path under our control.

## Considered options

- **Twilio.** The widest compliance tooling and a documented Ireland region for media streams, but
  about $1.49 a Rep-hour, a default of one call per second, and no Frankfurt stream endpoint.
- **Plivo.** About the same price as Telnyx with streaming and recording included, but its stream
  format, dual-channel recording and EU presence could not be confirmed.
- **Vonage.** Its official rates could not be read; secondary figures put it at Twilio's price.
- **Amazon Chime SDK.** No new subprocessor and AWS regions, but its pricing is spread across pages
  that did not give the streaming rate, and the browser leg needs Chime meetings.
- **Own media layer from day one.** Cheapest per minute, but it means running RTP, TURN, SIP and
  recording before there is a single customer.

## Consequences

- **EU residency is not settled.** Telnyx's Data Locality setting keeps stored data (Recordings) in
  the EU, but the docs describe processing in the EU as best-effort, not contractual. Before an EU
  Organization places a Call, the owner must get written terms from Telnyx, or the EU Region uses a
  second adapter (Twilio's Ireland region is the candidate) behind the same port. This is the open
  point that keeps the ADR at Proposed.
- Telnyx is a new subprocessor that carries live Call audio and stores Recordings briefly.
- At about $0.015 a minute, telephony is the largest line in the Copilot's cost (see the research
  report's cost model), so the move to the own media layer is the main cost lever at scale, and the
  port must not leak Telnyx concepts into the rest of the service.
- US outbound calling needs number registration for STIR/SHAKEN attestation and branded caller ID.
  The owner must set up the business profile with the vendor.
- Every Copilot Call plays the Disclosure before the media stream starts (ADR 0003); the port has a
  "play and confirm" operation for that, and the stream is started only after the vendor confirms
  playback finished.
- Voice Profiles (Agents, a later phase) plug in on the same media path in the other direction: the
  Agent's synthesized audio is sent back down the bidirectional stream. Phase 2 only listens.
