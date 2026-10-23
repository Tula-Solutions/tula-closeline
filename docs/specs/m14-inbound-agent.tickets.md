# M14 tickets: Inbound Agent

Needs M12 (inbound Calls from `M12-T8`), M13 (`M13-T1` streaming speech-to-text, `M13-T3` LLM port) and M10 (`M10-T10` route, `M10-T12` book). `M02-T4` is the Prospect API (upsert); `M03-T5` records Contact Consent, `M03-T6` is the kit's ContactGuard check and `M03-T7` handles unsubscribe and STOP. Libraries first, then voice and portal slices.

### T1: Text-to-speech port and memory adapter
Repo: kit
Blocked by: none

## What to build
`TtsPort`: stream text in, receive audio chunks, cancel mid-stream; a scripted memory adapter and a behaviour suite.

## Acceptance criteria
- [ ] Suite covers streaming order, cancel, vendor failure and close.
- [ ] No text or audio is logged.
- [ ] `dist/` rebuilt and tag pushed.

### T2: Cartesia adapter
Repo: kit
Blocked by: T1

## What to build
Cartesia Sonic implementation of `TtsPort` with stock voice styles. Blocked on credentials.

## Acceptance criteria
- [ ] T1 suite passes with credentials, skipped and named without.
- [ ] Timeouts and bounded jittered reconnect; no secret in logs.
- [ ] Time to first audio on a sample is recorded in the PR, or the PR says it was not measured.

### T3: Contract: Inquiry, Agent and Chat routes
Repo: contract
Blocked by: none

## What to build
The routes, schemas, error codes and events from the spec, including the public Inquiry and Chat routes with their key and origin rules.

## Acceptance criteria
- [ ] The Inquiry schema is invalid without the consent wording version and source URL.
- [ ] Lists use cursors with a maximum page size; every route lists its roles.
- [ ] Rebuilt `dist/` committed and tag pushed.

### T4: Agent tables
Repo: db
Blocked by: none

## What to build
`voice` tables for Inquiries, Agent settings, Qualification questions and answers, Agent turns with their sources, Handoffs and Chats, with RLS.

## Acceptance criteria
- [ ] RLS harness: Organization B reads and writes none of A's rows in any table.
- [ ] Inquiry unique on Organization and idempotency key.
- [ ] Tag a release.

### T5: Agent settings and Qualification questions
Repo: voice
Blocked by: T3, T4

## What to build
Admin routes for greeting, voice style, hours, pause switch, caps, and Qualification questions with skip logic.

## Acceptance criteria
- [ ] Invalid skip logic (a cycle, an unknown question) answers a typed error.
- [ ] The pause switch makes later callbacks answer `agent.paused`.
- [ ] Only Admin and Owner may write; Organization isolation holds.
- [ ] No setting exists that disables the Disclosure or the consent gate.

### T6: Agent settings in the portal
Repo: portal
Blocked by: T5

## What to build
An Admin page for the settings and a drag-to-order question editor.

## Acceptance criteria
- [ ] Create, reorder and delete questions; errors show their code text.
- [ ] Follows the portal's editorial direction; checked with `agent-browser`.

### T7: Conversation engine in text mode
Repo: voice
Blocked by: T3, T4, M13-T3

## What to build
The engine: retrieve Documents and Moments, ask `LlmPort` for a structured reply with sources and at most one tool call from the closed set, store each turn with its sources.

## Acceptance criteria
- [ ] Below the evidence minimum the Agent defers to a Rep; every answer lists sources.
- [ ] A Document containing an instruction does not change tool use; a tool outside the closed set is rejected.
- [ ] Organization B never retrieves A's Documents.
- [ ] A retried turn does not duplicate stored turns.

### T8: Try your Agent
Repo: portal
Blocked by: T7, T6

## What to build
A text window where an Admin talks to the Agent and sees sources and tool calls beside each answer.

## Acceptance criteria
- [ ] A scripted answer shows its source Documents; an unknown question shows the deferral.
- [ ] Checked with `agent-browser`.

### T9: Speech loop with Disclosure first
Repo: voice
Blocked by: T7, T1, M12-T8, M13-T1

## What to build
Answer an inbound Call on a Line: play the Disclosure, then greet, then the loop of speech-to-text, engine and streaming TTS with barge-in, caps and an end tool.

## Acceptance criteria
- [ ] With the Disclosure delayed or failed, the Call never reaches `live` and no greeting or model call occurs.
- [ ] Barge-in cancels TTS; the unspoken reply is not stored as said.
- [ ] Duration and cost caps end the Call with a stated reason.
- [ ] `bench/agent-turn.bench.test.ts` holds orchestration to its budget with the measured number in a comment.
- [ ] A restart mid-Call resumes without duplicate turns; Organization B cannot reach A's Calls.

### T10: Inquiry intake and callback
Repo: voice
Blocked by: T9, M02-T4, M03-T5, M03-T6

## What to build
The public Inquiry route (key, origin allowlist, rate limit), Prospect upsert, Contact Consent record, a queued callback with dial-time consent check, suppression, hours window and at most two retries.

## Acceptance criteria
- [ ] No consent, wrong channel, revoked, core unreachable, suppressed and outside hours each prevent the call and record a reason.
- [ ] The same Inquiry twice gives one callback.
- [ ] An origin not on the list answers `inquiry.origin_not_allowed`; a request without wording is rejected.
- [ ] A stop request during a Call revokes consent through core and ends the Call.
- [ ] Organization B cannot submit with A's key or read A's Inquiries.

### T11: Inquiry embed and list
Repo: portal
Blocked by: T10

## What to build
An embeddable Inquiry form with the consent wording, an Admin page for key and origins, and an Inquiries list with Qualification by role.

## Acceptance criteria
- [ ] The embed on a test page submits and shows a confirmation; a bad origin shows a clear message.
- [ ] Rep sees own, Manager Team, Admin all; paged by cursor.
- [ ] Checked with `agent-browser`.

### T12: Qualification and booking tools
Repo: voice
Blocked by: T9, M10-T12

## What to build
Record answers with skip logic, a stored summary, and the find-slots and book tools through core.

## Acceptance criteria
- [ ] A scripted Call records answers in order and skips as configured; a booked time appears in the memory calendar.
- [ ] A failed booking is told to the Prospect and offers another time.
- [ ] Organization B cannot book into A's Reps.

### T13: Warm Handoff
Repo: voice
Blocked by: T9, M10-T10, M12-T7

## What to build
On request or deferral: route, ring the first online Rep, bridge after the Disclosure line, attach the Copilot with earlier turns, fall back to the next Rep then a Booking.

## Acceptance criteria
- [ ] The Disclosure line precedes the bridge; the Copilot starts with the prior turns.
- [ ] First Rep unavailable, next Rep answers; none answer, a Booking is offered.
- [ ] Handoff timing is stored.

### T14: Handoff screen
Repo: portal
Blocked by: T13

## What to build
The Rep's incoming Handoff card with context and Transcript so far, accept and decline.

## Acceptance criteria
- [ ] A scripted Handoff shows the context and bridges on accept.
- [ ] Checked with `agent-browser`.

### T15: Website Chat
Repo: voice
Blocked by: T7, T10

## What to build
Chat sessions and messages on the engine in text mode, with the AI first message and callback consent capture.

## Acceptance criteria
- [ ] The first message states it is an AI; consent captured in chat records the wording version.
- [ ] A Chat is idempotent per message id; Organization B cannot read A's Chats.

### T16: Chat widget
Repo: portal
Blocked by: T15

## What to build
A widget bundle served from the portal origin that embeds on a site with a key.

## Acceptance criteria
- [ ] Works on a test page, honours the origin list, shows the AI note.
- [ ] Checked with `agent-browser`.

### T17: Messaging port and Twilio adapter
Repo: kit
Blocked by: none

## What to build
A messaging port for SMS and WhatsApp with a memory adapter and Twilio first adapter. Later slice; blocked on 10DLC and WhatsApp template approval.

## Acceptance criteria
- [ ] Suite covers send, inbound, STOP and a failing provider; no body is logged.

### T18: SMS and WhatsApp conversations
Repo: voice
Blocked by: T17, T15, M03-T6, M03-T7

## What to build
Conversation channel for texts: consent check per channel, STOP revokes consent, templates for WhatsApp.

## Acceptance criteria
- [ ] No consent for the channel means no text; STOP ends contact on every channel.
- [ ] Organization isolation holds.

### T19: Inbound Agent in `dev:smoke`
Repo: hub
Blocked by: T13, T15

## What to build
A smoke step that submits an Inquiry, runs the callback on memory adapters, answers a question with a source, books and hands off, with an isolation check.

## Acceptance criteria
- [ ] `bun run dev:smoke --strict` passes; asserts Disclosure order and consent gate.

### T20: Phase 3 Agent load test
Repo: hub
Blocked by: T13, M12-T16

## What to build
A load test of concurrent scripted Agent Calls recording turn-latency p50 and p95, callback dial time and the effect of killing an instance.

## Acceptance criteria
- [ ] Results recorded against the targets (p50 700 ms, p95 1000 ms, callback within 60 s).
- [ ] Calls continue on another instance after one is stopped.
