# M17 tickets: Outbound Agent call

Needs M07 (`M07-T1` contract, `M07-T2` schema, `M07-T5` Sequence engine, `M07-T8` launch checks), M14 (`M14-T3` contract, `M14-T4` tables, `M14-T5` settings, `M14-T9` speech loop, `M14-T12` booking tools, `M14-T13` Handoff), M12 (`M12-T5` telephony adapter, `M12-T7` Disclosure state machine) and M03 (`M03-T4` Contact Check, `M03-T6` ContactGuard, `M03-T7` STOP). `M16-T7` holds the pause switch and send windows, and `M02-T4` is the Prospect API. Order: the decision record (T1), libraries (T2 to T6), voice (T7 to T10), outbound (T11 to T13), portal (T14, T15), then the stack (T16).

### T1: Hub: ADR for calling window, voicemail and attempt limits
Repo: hub
Blocked by: none

## What to build
An ADR "Outbound Agent calls: calling window, voicemail and attempt limits" in `docs/adr/`: the 08:00 to 21:00 window in the Prospect's time zone (narrow only), hang up on answering machines and leave no message, at most one dial a day and three in seven days per Prospect number, and the rule that none of it has a setting. Also covers the Inbound Agent callback (M14).

## Acceptance criteria
- [ ] Records the options considered (leave a message, drop a message behind a setting) and why they were not chosen.
- [ ] Says a lawyer must review hours and state variations before real customers.
- [ ] `bun run verify` is green; the ADR index lists it.

### T2: Contract: the call Step and `agent_call` routes
Repo: contract
Blocked by: M07-T1, M14-T3

## What to build
The `call` Step kind in the Sequence union (goal, Line, `max_attempts`, `retry_after`), branch conditions on call result, the Enrollment stop reason `call.opted_out`, the `agent_call` area (internal request with required idempotency key, Rep request, get and list), the result and end-reason enums, the error codes and event fields from the spec.

## Acceptance criteria
- [ ] `max_attempts` above 3 or `retry_after` under 4 hours is invalid.
- [ ] A `call` Step is additive: existing Sequences still parse; a branch on a result not in the enum is rejected.
- [ ] The internal request is invalid without an idempotency key; lists use cursors with a maximum page size of 100; every route lists its roles.
- [ ] Rebuilt `dist/` committed and tag pushed.

### T3: Db: Agent Call records and Line caps
Repo: db
Blocked by: T2, M07-T2, M14-T4

## What to build
`voice.agent_calls` with the idempotency key, source, attempt, state, result, end reason and gate code; two cap columns on `voice.lines`; the `call.result` event type for outbound enrollment events; indexes for the per-Prospect-per-day and seven-day counts.

## Acceptance criteria
- [ ] RLS harness: Organization B reads and writes none of A's rows in any table.
- [ ] Unique on Organization and idempotency key; EXPLAIN-based test shows the attempt counts use their index.
- [ ] No column holds a raw phone number outside the Prospect reference and the hash.
- [ ] Tag a release.

### T4: Telephony port: Agent-leg call and answering-machine detection
Repo: kit
Blocked by: none

## What to build
A `TelephonyPort` operation to place a Call from a Line to a number with the media stream and no browser leg, an answering-machine detection event (`human`, `machine`, `unknown`, within a stated window) and a silent hang-up; memory adapter scripting human, machine, unknown, busy and no answer; the behaviour suite.

## Acceptance criteria
- [ ] Suite covers each detection result, busy, no answer, cancel before answer, and vendor failure.
- [ ] The detection event never arrives after hang-up; no number or audio is logged.
- [ ] A dial with the same command id twice places one Call.
- [ ] `dist/` rebuilt and tag pushed.

### T5: Calling window and time zone from a number
Repo: kit
Blocked by: none

## What to build
A pure function that returns the Prospect's time zone from an E.164 number (NANP area codes, one-zone countries, an optional override) and whether a given instant is inside a window narrowed from the platform's 08:00 to 21:00, with the next opening time.

## Acceptance criteria
- [ ] Table tests: both edges of the window, daylight-saving changes, a zone at a different date line, a narrowed window, and a window that tries to widen (ignored).
- [ ] A number whose zone cannot be fixed returns unknown, never a default.
- [ ] `dist/` rebuilt and tag pushed.

### T6: Answering-machine detection on the real adapter
Repo: kit
Blocked by: T4, M12-T5

## What to build
Implement T4's Agent-leg call and detection on the provider M12 shipped. Blocked on credentials.

## Acceptance criteria
- [ ] T4's suite passes with credentials, skipped and named without.
- [ ] Timeouts and bounded jittered retry; no secret in logs.
- [ ] Time to a detection result on a sample is recorded in the PR, or the PR says it was not measured.

### T7: Voice: Agent Call request and the gate
Repo: voice
Blocked by: T2, T3, T5, M14-T5, M03-T6

## What to build
The internal and Rep request routes, idempotency, and the six-step gate (pause, idempotency, Contact Check, calling window, attempt limits, Line caps), run on request and again before dialing; each refusal stored as a `blocked` result with its code. No dial yet.

## Acceptance criteria
- [ ] Table-driven tests: paused, no consent, wrong channel, withdrawn, suppressed, core unreachable, outside hours, unknown zone, attempts exhausted and Line cap each refuse with their code and record a reason.
- [ ] A cap hit defers and returns a retry time without using an attempt.
- [ ] The same key twice returns one row; a Rep may request only for a Prospect they can see; the Rep's request does not waive the Contact Check.
- [ ] No setting disables the consent gate or the window; Organization B cannot read A's rows or count against A's caps.
- [ ] A benchmark in `bench/` holds the gate's orchestration to its budget with the measured number in a comment.

### T8: Voice: place the Call, detect, Disclose, talk
Repo: voice
Blocked by: T4, T7, M14-T9, M12-T7

## What to build
After the gate passes: store `dialing`, dial, wait for detection with the silent window, end silently on `machine` (result `voicemail`), play the Disclosure first on `human` or `unknown`, then the M14 speech loop with the outbound opening and the Step's goal; late machine detection in the first 10 seconds; store the result and publish `voice.agent_call.ended`.

## Acceptance criteria
- [ ] On `machine`: no audio, no model call, result `voicemail`.
- [ ] With the Disclosure delayed or failed the Call never reaches `live`, and no greeting or model call occurs.
- [ ] A crash between the `dialing` row and the provider answer, then a retry, dials once; a webhook replay changes nothing.
- [ ] `no_answer`, `busy` and `failed` each store their result; a restart mid-Call resumes without duplicate turns.
- [ ] Organization B cannot reach A's Calls.

### T9: Voice: opt-out by speech
Repo: voice
Blocked by: T8, M03-T7

## What to build
The deterministic stop-phrase matcher on each final turn before the model, `record-withdrawal` through core for the phone channel, one fixed confirmation line and hang-up, and the model's revoke tool using the same path.

## Acceptance criteria
- [ ] Each stop phrase, including inside a longer sentence, withdraws consent and suppresses the number before any model call; the Call ends with `opted_out`.
- [ ] "Not interested" ends the Call as `not_interested` and does not suppress.
- [ ] If core is unreachable the Call still ends and the withdrawal is retried until it lands, with the number blocked locally meanwhile.
- [ ] `consent.withdrawn` and `suppression.added` are visible to `outbound` (T12).

### T10: Voice: Handoff and booking on an outbound Call
Repo: voice
Blocked by: T8, M14-T12, M14-T13

## What to build
Wire the existing booking tools and Handoff into the outbound Call: a Prospect who asks for a person is routed, or offered a Booking when no Rep is online; the Handoff line precedes the bridge; the result and end reason say `handed_off` or `booked`.

## Acceptance criteria
- [ ] First Rep unavailable, next answers; none answer, a Booking is offered and booked in the memory calendar.
- [ ] The Handoff line precedes the bridge and the Copilot starts with the prior turns.
- [ ] A failed booking is told to the Prospect and another time is offered.

### T11: Outbound: the call Step
Repo: outbound
Blocked by: T2, T3, T7, M07-T5

## What to build
Execute a due call Step: ask voice for the Call with key `<enrollment>:<step>:<attempt>`, wait for `voice.agent_call.ended`, append a `call.result` event, branch on the result, and end the Enrollment with `call.opted_out` on an opt-out. A `blocked` result for `consent.*` ends the Enrollment with its reason.

## Acceptance criteria
- [ ] With an injected clock and a voice double, a due Step requests once; a retried message does not request twice.
- [ ] Each result branches as configured; a result that never arrives is timed out and recorded, not waited on forever.
- [ ] Reply, unsubscribe, suppression or pause before the Step stops the Enrollment without a request.
- [ ] Organization B's sweep never touches A's rows.

### T12: Outbound: retries and cancellation
Repo: outbound
Blocked by: T11

## What to build
Retry on `no_answer`, `busy`, `voicemail` and `failed` up to `max_attempts` with at least `retry_after` between, due only inside the next calling window; defer a cap result without using an attempt; cancel scheduled call Steps when `consent.withdrawn` or `suppression.added` arrives for the number.

## Acceptance criteria
- [ ] Attempts stop at the Step's maximum and never exceed the hard ceiling of 3.
- [ ] `answered` is never retried; a cap deferral reschedules without an attempt used.
- [ ] After `suppression.added`, a call due in the same minute does not dial.
- [ ] Idempotent under redelivery of events.

### T13: Outbound: launch and audience checks for call Steps
Repo: outbound
Blocked by: T11, M07-T8

## What to build
For a Campaign with a call Step: the audience check counts Prospects with a current phone Contact Consent, with a phone number and with a determinable calling window; the launch check requires a Line with capacity.

## Acceptance criteria
- [ ] Launch refused with a named reason when no Line has capacity or the audience has no consented number.
- [ ] Counts come from core's decision, not a stale copy; fail closed when core is unreachable.
- [ ] Second-Organization test passes.

### T14: Portal: the call Step in the builder
Repo: portal
Blocked by: T13

## What to build
A call Step in the Sequence builder (goal, Line, attempts, retry spacing), result branches, and the audience's consented count and the launch refusal in words.

## Acceptance criteria
- [ ] A Campaign with a call Step is built, previewed and launched with `agent-browser` against the local stack.
- [ ] Attempt and spacing limits show in the form as text; the consented count is shown beside the audience.
- [ ] No control exists that skips consent, the Disclosure or the window.
- [ ] Follows the portal's editorial direction; keyboard operable.

### T15: Portal: call results and "Call now"
Repo: portal
Blocked by: T7, T10, T11

## What to build
The Prospect's activity shows each Agent Call with its result, end reason, Transcript and Recording link by role; a "Call now" action for a Rep with the refusal reason in words.

## Acceptance criteria
- [ ] A scripted answered Call, a voicemail and a refusal for no consent each show correctly; checked with `agent-browser`.
- [ ] Rep sees own, Manager Team, Admin all.
- [ ] The action explains `consent.missing` and `agent.outside_hours` with the next opening time.

### T16: Outbound Agent Call in `dev:smoke`
Repo: hub
Blocked by: T9, T12

## What to build
A smoke step that runs a call Step on memory adapters: a consented Prospect answered by a person (Disclosure first, an answer with a source, a booking), a voicemail hang-up with no audio, a Prospect with no consent refused, and a spoken STOP that suppresses the number, with an isolation check.

## Acceptance criteria
- [ ] `bun run dev:smoke --strict` passes; asserts Disclosure order, the voicemail silence, the consent gate and the STOP result.
- [ ] A second Organization's Prospect is never called.
