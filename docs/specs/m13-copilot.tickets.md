# M13 tickets: Copilot

Needs M12 (the Softphone Call) from `M12-T7`. Libraries first (T1 to T6), then voice and portal in alternating slices so each step is demoable.

### T1: Streaming speech-to-text port and memory adapter
Repo: kit
Blocked by: none

## What to build
`StreamingTranscribePort`: open a stream for one audio track, push audio, receive interim and final turns with word timings and end-of-turn marks, reconnect on drop, report an unrecoverable stream as an event. A scripted memory adapter and a behaviour suite.

## Acceptance criteria
- [ ] The suite covers interim then final order, end-of-turn, reconnect, unrecoverable failure and close.
- [ ] No audio or text is logged; the reporter receives only metadata.
- [ ] `dist/` rebuilt and tag pushed.

### T2: AssemblyAI streaming adapter
Repo: kit
Blocked by: T1

## What to build
The AssemblyAI streaming implementation of the T1 port, with the EU endpoint selectable. Blocked on credentials.

## Acceptance criteria
- [ ] The T1 suite passes against it when credentials are set and is skipped, named, otherwise.
- [ ] Timeouts, bounded jittered reconnect, and no secret in logs.
- [ ] Median final-turn delay on a sample recording is recorded in the PR, or the PR says it was not measured.

### T3: Language model port and memory adapter
Repo: kit
Blocked by: none

## What to build
`LlmPort`: structured completion against a JSON schema with a hard timeout and token budget, plus streaming; a scripted memory adapter and behaviour suite. Shared with M14.

## Acceptance criteria
- [ ] Schema-invalid model output surfaces as a typed error, not a partial value.
- [ ] A timeout aborts the underlying request.
- [ ] Prompts and completions are never logged.

### T4: Claude on Bedrock adapter
Repo: kit
Blocked by: T3

## What to build
The Bedrock implementation of `LlmPort` using a fast Claude model, in-Region. Blocked on credentials.

## Acceptance criteria
- [ ] The T3 suite passes against it with credentials, skipped and named without.
- [ ] Region is a setting; the EU Region never calls a US endpoint.

### T5: Contract `copilot` area
Repo: contract
Blocked by: none

## What to build
Card, evidence and event schemas, the SSE event shapes, list and rate routes, settings routes and error codes from the spec. Tag a release.

## Acceptance criteria
- [ ] A card schema cannot be valid without at least one cited Moment id and evidence counts with `deals <= moments`.
- [ ] Rating routes are idempotent by end state in their descriptions.
- [ ] Rebuilt `dist/` committed and tag pushed.

### T6: Copilot tables
Repo: db
Blocked by: none

## What to build
`voice.call_turns`, `voice.copilot_cards`, `voice.copilot_settings` with migration and RLS.

## Acceptance criteria
- [ ] RLS harness: Organization B reads and writes none of A's rows in any of the three.
- [ ] `call_turns` unique on call, track and sequence; cards indexed by call and shown time.
- [ ] Tag a release.

### T7: Live Transcript for a Call, gated on the Disclosure
Repo: voice
Blocked by: M12-T7, T1, T5, T6

## What to build
A Rep can dial with the Copilot on; the Disclosure uses the AI-assisted wording; after it plays, both tracks stream to speech-to-text and final turns are saved and streamed to the Rep over SSE.

## Acceptance criteria
- [ ] With the Disclosure delayed or failed, no stream opens and no turn exists.
- [ ] A scripted conversation yields ordered turns with the right speaker; a restart of the pipeline mid-Call resumes without duplicate turns.
- [ ] A speech-to-text failure leaves the Call live and emits a `transcript.unavailable` event.
- [ ] Organization B cannot open A's stream or read A's turns.

### T8: Live Transcript panel
Repo: portal
Blocked by: T7, M12-T12

## What to build
The Softphone shows the live Transcript, a Copilot on/off choice before dialing, and the state ("waiting for Disclosure", "live", "unavailable").

## Acceptance criteria
- [ ] With the memory adapters a scripted conversation scrolls into view; reconnect resumes from the last event.
- [ ] Turning the Copilot off before dialing dials with the recorded-only wording.
- [ ] Checked with `agent-browser`.

### T9: Retrieval cards
Repo: voice
Blocked by: T7

## What to build
After each Prospect turn, one bounded `searchMoments`, and a `similar_moment` card with evidence counts and the Rep turns that followed, throttled and deduped, delivered over SSE and saved.

## Acceptance criteria
- [ ] A scripted objection yields a card whose evidence equals the Playbook double's; below the minimum evidence no card.
- [ ] A failed or slow search yields no card and the Call is unaffected; a stale result is dropped.
- [ ] At most one card per 8 s, no repeat of a Moment within 60 s, at most 60 per Call.
- [ ] `bench/copilot-card.bench.test.ts` holds voice's own work to the budget, with the measured number in a comment.
- [ ] Organization B never receives a card citing A's Moment ids.

### T10: Cards in the Softphone
Repo: portal
Blocked by: T9, T8

## What to build
A card panel: quote, "what the Rep said next", an evidence line, a link to the source Call, and dismiss, pin, useful and not useful.

## Acceptance criteria
- [ ] Ratings and dismissals persist and are idempotent; a pinned card stays when new ones arrive.
- [ ] An empty state explains why there are no cards (off, no won Moments yet, below minimum).
- [ ] No generic template look: follows the portal's editorial direction; checked with `agent-browser`.

### T11: Copilot settings
Repo: voice
Blocked by: T5, T6

## What to build
An Admin turns the Copilot on and sets the minimum evidence; the setting is read at dial time.

## Acceptance criteria
- [ ] Default is off; with it off, dialing with the Copilot answers `copilot.disabled`.
- [ ] A minimum below 1 Moment or 1 Deal is `copilot.min_evidence_invalid`.
- [ ] Only Admin and Owner may set it; Organization isolation holds.

### T12: Copilot settings page and audit view
Repo: portal
Blocked by: T11, T9

## What to build
An Admin page for the settings and a Call detail tab listing the cards shown on a Call with their cited Moments and ratings, by role.

## Acceptance criteria
- [ ] Manager sees Team Calls' cards only; Rep sees own.
- [ ] Each card links to its cited Moments.

### T13: Objection and next-step cards
Repo: voice
Blocked by: T9, T3

## What to build
The model composer upgrades a retrieval card in place into an `objection` or `next_step` card, using only retrieved Moments, with a 600 ms timeout.

## Acceptance criteria
- [ ] An answer citing an unretrieved Moment id is discarded and the retrieval card stands.
- [ ] A Transcript containing an instruction to the model does not change the output schema or add uncited content.
- [ ] A model timeout leaves the retrieval card unchanged.
- [ ] Upgrade p95 within the budget in the bench.

### T14: Document cards
Repo: voice
Blocked by: T9

## What to build
When the Prospect asks about price, terms or a product detail, a `document` card shows the best Playbook Document chunk with its Document name.

## Acceptance criteria
- [ ] Uses `searchDocuments` with the same timeout and no retry; no card without a result.
- [ ] Organization B never gets A's Documents.

### T15: Copilot in `dev:smoke`
Repo: hub
Blocked by: T10, T13

## What to build
A smoke step that loads a won Call, runs a scripted Call and asserts a card within budget and the Disclosure order.

## Acceptance criteria
- [ ] `bun run dev:smoke --strict` passes; includes an isolation check across two Organizations.

### T16: Phase 2 Copilot load test
Repo: hub
Blocked by: T13, M12-T16

## What to build
A load test of concurrent scripted Calls recording p95 from final turn to card, and the Playbook search p95 under that load.

## Acceptance criteria
- [ ] Results recorded in the phase plan with the target (2.0 s p95, 100 ms voice overhead).
- [ ] Instances are stopped mid-run and Calls continue on another instance.
