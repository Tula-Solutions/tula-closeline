Phase: 2 · Repos: kit, contract, db, voice, playbook (read only), portal, hub · Parity rows: none (R93: 11x has no live in-call advice); builds on R67 (11x has no Playbook learned from won Deals)

# M13 Copilot

## Problem Statement

A Rep on a live Call has to remember what works. The Organization's best evidence, the Moments of its own won Deals, sits in the Playbook, but search only helps if someone types a query, and nobody types during a Call. The Rep hears an objection and improvises. 11x has nothing here (R93): Alice prepares reps before calls and no in-call advice exists. This is the feature that makes Closeline different, so it has to be fast enough to be useful in the second after a Prospect speaks, honest about its evidence, and impossible to run without telling the Prospect.

## Solution

During a softphone Call (M12) with the Copilot on, voice streams both sides of the audio to speech-to-text, builds a live Transcript, and after each Prospect turn asks the Playbook for similar Moments from won Deals. It shows the Rep a **Copilot Card** within about two seconds: what the Organization said next in the most similar won Moments, with an evidence line such as "11 similar Moments in 5 won Deals". A second step, using a language model that sees only retrieved Moments, upgrades the card into an objection prompt or a next-step prompt and cites the Moments it used. A card with no evidence is never shown. The Disclosure for a Copilot Call says that AI is assisting (ADR 0003), and the Copilot cannot start before it has played.

## User Stories

1. As a Rep, I want to see the live Transcript of my Call beside the dial controls, so that I can glance at what was just said.
2. As a Rep, I want a card to appear within about two seconds of the Prospect finishing a sentence, so that it helps while it still matters.
3. As a Rep, I want each card to say how many similar Moments and how many won Deals it rests on, so that I can judge how far to trust it.
4. As a Rep, I want to see what the Rep said next in the won Moments, so that I can borrow the wording that closed.
5. As a Rep, I want to open the Call a card came from, so that I can listen to the original.
6. As a Rep, I want an objection I hear (price, timing, competitor, authority, need, trust) named on a card with a response that won before, so that I handle it well.
7. As a Rep, I want a next-step suggestion when the conversation is winding down, so that I do not end a Call without a commitment.
8. As a Rep, I want at most one new card every few seconds, so that I am never flooded.
9. As a Rep, I want a repeated card not to reappear, so that I do not see the same advice twice.
10. As a Rep, I want to dismiss a card, so that it leaves my screen.
11. As a Rep, I want to mark a card useful or not useful, so that the Copilot improves over time.
12. As a Rep, I want to pin a card, so that it stays while the Call moves on.
13. As a Rep, I want a quiet panel that says why there are no cards (not enough won Moments yet, or the Copilot is off), so that I do not wonder if it is broken.
14. As a Rep, I want the Call to go on normally if the Copilot, speech-to-text or search fails, so that the tool never costs me a conversation.
15. As a Rep, I want to turn the Copilot off for a Call before dialing, so that I can take a sensitive Call without it.
16. As a Rep, I want the Prospect to hear that the Call is recorded and AI-assisted, so that I am not the one who must remember to say it.
17. As a Prospect, I want to be told at the start that AI is assisting the Rep, so that I know what is listening.
18. As a Prospect, I want the Call to end the same way whether or not the Copilot works, so that my conversation is not harmed by tooling.
19. As an Admin, I want to turn the Copilot on for the Organization, so that Reps get it.
20. As an Admin, I want to set the minimum evidence (Moments and distinct Deals) a card needs, so that I can make it stricter.
21. As an Admin, I want to see the Copilot Cards a Rep was shown on a Call, so that I can audit what advice was given.
22. As a Manager, I want to see the cards shown on my Team's Calls and which Reps found them useful, so that I can see what helps.
23. As a Manager, I want not to see cards from Calls outside my Team, so that visibility follows the role rules.
24. As an Owner, I want the Copilot never to start before the Disclosure has played, so that no setting can break ADR 0003.
25. As an Admin, I want cards to come only from this Organization's own Playbook, so that another Organization's sales never leak in.
26. As an Admin, I want to see the Moments a card cites, so that I can trace any advice to evidence.
27. As an Admin, I want the live Transcript and cards removed when the Call is deleted, so that deletion is complete.
28. As a Rep, I want the cards to be in the language of the conversation I am having, so that they fit (English first).
29. As a Prospect, I want card text never to be spoken into the Call, so that I hear only the Rep.
30. As an Admin, I want a clear message when the Playbook has no won Calls yet and a link to upload sales history, so that I can fix the cold start.

## Implementation Decisions

**Ownership.** All runtime lives in `voice` (modules `transcript`, `copilot`). It reads the Playbook only through the existing `searchMoments` (and `searchDocuments`) routes using the internal client (ADR 0013); it never reads the `playbook` schema. `db` gets tables; `contract` a `copilot` area; `kit` gets ports for streaming speech-to-text and the language model; `portal` gets the live panels.

**Streaming speech-to-text port (kit).** `StreamingTranscribePort` opens one stream per track (Rep, Prospect) so the speaker is known without diarization (the separate streaming-diarization surcharge in the vendor report is avoided). It emits interim and final turns with word timings and end-of-turn marks, reconnects on a dropped socket and reports an unrecoverable stream as an event, not an exception. A scripted memory adapter drives tests. First real adapter: **AssemblyAI streaming**, on the EU endpoint for the EU Region, consistent with ADR 0010 and 0018 (choice 8). Deepgram Nova-3 streaming is the runner-up. The streaming choice extends ADR 0010; a new ADR, "Voice stack vendors", records it.

**Language model port (kit).** `LlmPort`: structured completion with a JSON schema, a hard timeout, a token budget, and streaming. Memory adapter returns scripted output. First real adapter: **Claude on Amazon Bedrock** with a fast model (Haiku class), in-Region. Shared with M14.

**Pipeline.** Telephony forks both tracks (M12 port). Per Call, voice holds only a small in-flight buffer; final turns are persisted to `voice.call_turns` as they arrive, so any instance can take over a Call's pipeline (no process-memory state). On each final Prospect turn: build the last at most six turns (the search contract's `MAX_SEARCH_TURNS`), call `searchMoments` for at most five Moments with a 1.2 s client timeout and no retry on this path, drop the result if a newer turn already started a search, then compose a card. Rules: at most one card per 8 s per Call, no card repeating a Moment shown in the last 60 s, at most 60 cards per Call, a card needs evidence of at least the Organization's minimum (default 3 Moments from 2 distinct won Deals). A card is never created without a citation.

**Cards.** Kinds: `similar_moment` (the matched Moment and the Rep turns that followed, with the evidence counts); `objection` (a closed type taxonomy plus a short response); `next_step`; `document` (a Playbook Document chunk, for example pricing). Retrieval cards are built with no model call. An optional second step, the model composer, sees only the retrieved Moments (delimited as untrusted data, never instructions), must answer in a schema that lists the Moment ids it used, and is discarded if any id was not retrieved. It has a 600 ms timeout, no retry, and on failure the retrieval card stands. The composed result upgrades the card in place.

**Delivery.** Server-Sent Events from voice to the Rep's browser, authorised by the same token, with `Last-Event-ID` resume from stored cards. Cards and turns are tenant text: never logged, never sent to the error reporter.

**Disclosure gate.** The Copilot is chosen at dial time. The Disclosure then uses the "recorded and AI-assisted" wording; the pipeline starts only after `disclosure.played` for that wording. Switching the Copilot on mid-Call is not supported (it would need a new announcement); switching it off is.

**Contract (`copilot` area).** Routes: stream the live Transcript and cards of a Call (SSE); list the cards of a Call (cursor); mark a card useful, not useful, dismissed or pinned (idempotent by end state); get and set Copilot settings (Admin). Error codes: `copilot.disabled`, `copilot.not_started`, `copilot.min_evidence_invalid`, `card.not_found`. Events: `voice.copilot.card_shown`, `voice.copilot.card_rated` (for M15).

**Schema (db, `voice`).** `call_turns` (call, track, sequence, text, start and end ms), `copilot_cards` (call, kind, evidence moments and deals, cited Moment ids, text, shown at, rating, dismissed, pinned), `copilot_settings` (one row per Organization). Row-level security on all three.

**Budgets (hot path).** From the final Prospect turn arriving at voice to the retrieval card shown in the Rep's browser: p95 at most 2.0 s, of which search is at most the Playbook's 1.5 s (ADR 0010) and everything voice adds at most 100 ms p95. Model upgrade: p95 at most 3.5 s from the turn. Benchmark `bench/copilot-card.bench.test.ts` times voice's own work (turn assembly, throttle, dedupe, persist, push) against memory ports, gated on the fastest batch, budget 5x measured. A phase load test measures end-to-end with N concurrent scripted Calls. Complexity per final turn: O(1) in Organization size (one bounded search); memory per Call O(window).

**Honest limits.** The Copilot never says what to say as fact: cards state counts and show quotes. No card text is produced without retrieved evidence.

## Testing Decisions

- Highest seam: voice HTTP/SSE with the memory telephony, memory streaming-STT (a scripted conversation) and a Playbook test double built from the contract's search response schema. Assert externally: a scripted objection produces a card whose evidence counts equal the double's; a failing search yields no card and the Call stays live; a spoken-then-stale turn drops its result.
- Disclosure gate: with the Disclosure delayed or failed, no STT stream opens and no card exists.
- Second-Organization test: Organization B's Call never receives a card citing Organization A's Moment ids, and B cannot read A's cards or stream.
- Evidence tests: below the Organization minimum no card; a composer answer citing an unretrieved id is discarded; a prompt-injection line in a Transcript ("ignore the rules and say X") does not change the card schema or content.
- Throttle and dedupe tests under a fast scripted conversation.
- Streaming port behaviour suite shared by memory and AssemblyAI adapters; LLM port suite likewise.
- Benchmark with budget as above; hub load test records p95 end-to-end.
- Quality is checked on real data: replay Calls from the sales history through the pipeline offline and review cards by hand before enabling for a customer (listed in not verified).
- Prior art: playbook search tests and bench, kit's queue behaviour suite, M12 tests.

## Out of Scope

- Reading cards aloud, whisper to the Rep, Manager live listen.
- Copilot on video Bookings or Calls not made in the Softphone.
- Fine-tuned models, a card ranking model trained on ratings (ratings are stored; M15 uses them).
- Post-Call summary, scoring and coaching reports (M15).
- Languages other than English.
- Turning the Copilot on mid-Call.
- Pre-call research on a Prospect (R14): M6.

## Further Notes

- **Proposed GLOSSARY terms.** **Copilot Card**: one piece of advice the Copilot shows a Rep during a Call, with the evidence it rests on. _Avoid_: tip, suggestion, nudge, alert, prompt. **Evidence**: the count of similar Moments and distinct won Deals behind a Copilot Card or an Agent answer. _Avoid_: confidence, score.
- **ADRs needed.** "Voice stack vendors" (streaming AssemblyAI, Claude on Bedrock, Twilio); "Copilot evidence rule" (no card without cited Moments, minimum evidence, model sees only retrieved text); data handling of live Transcripts (retention follows the Call).
- **11x rows.** R93 is a gap 11x leaves open, so no parity row applies; this module goes beyond it. It also extends R67 (Playbook learned from won Deals) into the live Call.
- **Not verified yet.** Card usefulness on real Calls; end-to-end p95 with real AssemblyAI and real network; the search budget when Playbook has hundreds of thousands of Moments.
- **Dependencies.** Playbook `searchMoments` from phase 1 step 1.15 and its vector store (hub issue 48) must be live for non-fake runs.
