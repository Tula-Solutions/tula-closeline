Phase: 4 · Repos: hub, contract, db, kit, voice, outbound, portal · Parity rows: R22 (phone slice), R26 (Agent dialing, one Prospect at a time), R54, R57, R90, R91; R50 to R52 and R58 not in v1

# M17 Outbound Agent call

## Problem Statement

11x's Alice and Julian reach Prospects by phone as well as email, and 11x documents an outbound AI caller that qualifies and books (R22, R54). Closeline's Outbound Agent can only email (M07); its Sequence has a Rep task Step for "call" because ADR 0003 forbids an Agent to call without a Contact Consent and nothing yet checks one on a Call the Agent places. M14 built the speech loop, the Disclosure and the consent gate for the Inbound Agent, and made the callback to a form Inquiry the only Call an Agent starts. A Campaign cannot ask an Agent to ring a consented Prospect, and a Rep cannot ask for one. A call placed to a number can also reach a voicemail, and an AI that talks to an answering machine, or that rings at night, breaks the rules the platform exists to enforce.

## Solution

An **outbound Agent Call** placed by `voice` for `outbound`. The Campaign's Sequence gets a **call Step**. When it falls due, `outbound` asks `voice` to place the Call, with an idempotency key. `voice` runs a fixed gate that fails closed: Agents not paused, the Contact Check for the phone channel with purpose `agent_initiated` (consent granted, no Suppression), the calling window in the Prospect's time zone, the attempt limits and the Line's caps. A refusal is a recorded result, never a skipped step. If the gate passes, `voice` dials from an Organization Line and waits for the telephony port's answering-machine detection. A machine gets a silent hang-up. A person hears the Disclosure first, before any greeting, then the Inbound Agent's speech loop and tools run unchanged with an outbound opening and the Step's goal. The Prospect can say stop at any time and is suppressed on the phone channel at once. When the Call ends, `voice` publishes its **call result** and `outbound` records it on the Enrollment, branches on it and retries within limits. A Rep can also ask the Agent to call one Prospect now, which goes through exactly the same gate.

## User Stories

1. As an Admin, I want to add a call Step to a Sequence with a goal and a retry rule, so that the Agent phones Prospects as part of a Campaign.
2. As an Admin, I want a Campaign with a call Step to show how many of its audience have a phone Contact Consent, so that I know who the Agent can reach before I launch.
3. As an Admin, I want a Prospect without a Contact Consent for the phone channel to be refused with the reason `consent.missing` and shown in the log, so that I see the gate work.
4. As a Prospect, I want the first thing I hear to say that the caller is an AI and that the Call is recorded, so that I know who I am talking to.
5. As a Prospect, I want an answering machine not to receive an AI message from a company I never spoke to, so that my voicemail is not filled with sales calls.
6. As a Prospect, I want not to be called outside 08:00 to 21:00 where I am, so that I am not woken or disturbed.
7. As a Prospect, I want to say "stop", "don't call me again" or "take me off your list" and have it honoured at once, so that I stay in control.
8. As a Prospect, I want the Agent to stop calling after a few unanswered tries, so that I am not chased.
9. As a Prospect, I want to ask for a person and be connected, or offered a time, so that I can talk to a human.
10. As a Prospect, I want to book a time during the Call, so that I do not wait for an email.
11. As a Rep, I want to ask the Agent to call one Prospect now, and to be told why it refused if it does, so that I can use the Agent without waiting for a Step.
12. As a Rep, I want a Handoff from an outbound Call that tells the Prospect a person has joined and that the Call is recorded and AI-assisted, so that the Disclosure holds.
13. As a Rep, I want the call result and Transcript on the Prospect, so that I know what was said before I follow up.
14. As an Admin, I want a Sequence to branch on the call result (answered, voicemail, no answer, booked, opted out), so that the next Step fits what happened.
15. As an Admin, I want the Sequence to stop at once for a Prospect who opts out, replies, unsubscribes or is suppressed, so that nothing else goes out.
16. As an Admin, I want a cap on concurrent and daily Agent Calls per Line, so that a number's reputation and the bill are bounded.
17. As an Admin, I want the pause switch to stop Agent Calls at once, including those queued, so that I can halt the Agent.
18. As an Admin, I want to read the Transcript and Recording of every outbound Agent Call, so that I can audit.
19. As an Admin, I want to narrow the calling window for a Campaign but not widen it beyond the platform's, so that stricter local rules can be met.
20. As an Owner, I want the consent gate, the Disclosure and the calling window to have no setting that disables them, so that the Organization is protected (ADR 0003).
21. As an Admin, I want a Step that fires twice by retry or restart to cause one Call, so that no Prospect is rung twice.
22. As an Owner, I want one Organization's Calls, results and Lines to be invisible to every other Organization, so that tenancy holds.
23. As an Admin, I want a Prospect whose time zone cannot be worked out to be refused rather than called, so that the window is never guessed.
24. As a Manager, I want to see the call results of my Team's Campaigns, so that I can judge them.

## Implementation Decisions

**Ownership.** `voice` places and runs the Call and owns the `agent_calls` record; it is the only writer of its schema. `outbound` owns the call Step, the Enrollment and the retry decision, and never dials. `outbound` calls `voice` over the internal client (ADR 0013), and `voice` calls core for the Prospect, the Contact Check and consent withdrawal, never for its tables. `contract` gets the call Step kind and an `agent_call` area; `db` gets the voice and outbound tables; `kit` gets a telephony port operation, a calling-window function and the real adapter change; `portal` gets the builder Step and the Prospect view.

**Reuse of the Inbound Agent (M14).** The Call goes through the same `agent` module: the conversation engine, grounded answers with sources, closed tool set, speech loop with barge-in, caps, Qualification and booking tools, Handoff, `disclosure.played` state machine and Transcript. The new parts are the outbound dial path, answering-machine detection, the outbound opening, the stop-phrase matcher and the result record. No second engine and no second Disclosure.

**The gate (fail closed, in this order).** One function in `voice`, called on the request and again immediately before dialing (a queued request may wait):

1. `agents_paused` (M16-T7) or the Agent paused (`agent.paused`).
2. Idempotency: a request with a known key returns the existing `agent_calls` row; it never dials twice.
3. Contact Check through kit's ContactGuard: channel `phone`, purpose `agent_initiated`. Anything but "allowed" refuses with the check's code (`consent.missing`, `consent.withdrawn`, `consent.suppressed`, `consent.unavailable`). A Rep's request does not waive it: the Agent places the Call, so the Agent rule applies (ADR 0003).
4. Calling window (below). Unknown zone refuses `agent.timezone_unknown`; outside the window `agent.outside_hours`, with the next opening time.
5. Attempt limits (below), `agent_call.attempts_exhausted`.
6. Line caps (below), `agent_call.line_cap_reached`, a deferral that does not use an attempt.

Each refusal stores a `blocked` result with its code. A gate refusal for `consent.*` is final for the Step; the others defer or end by the rules in Retries.

**Calling window.** 08:00 to 21:00 in the Prospect's time zone, every day (the proposal M14 flagged; ADR needed). An Organization or Campaign setting (M16-T7) may narrow it, never widen it. The zone comes from the Prospect's phone number: a NANP area-code table and one-zone countries; a number whose zone cannot be fixed is refused. A Prospect-level time zone field is not part of M02 and is left to a later change; the function takes an optional override so it can be added without touching callers. A lawyer must check the hours and the state-by-state variations before real customers.

**Answering-machine detection and voicemail: hang up, leave nothing.** The telephony port reports `human`, `machine` or `unknown` after answer, within a detection window of at most 4 seconds in which the Agent plays and says nothing. `machine` ends the Call silently with result `voicemail`. `human` and `unknown` start the Disclosure. Reasons for no message:

- A message on a machine is an AI-voiced, recorded message that no one could decline or answer, and the Disclosure rule (ADR 0003) is built around a person who can hang up.
- A voicemail script is a second thing to word, review, version and defend; hanging up adds none.
- It matches M14, which leaves no voicemail in v1, and the phrase "leave a short compliant message" is the first thing a lawyer would remove.
- Cost: the Call ends within about 5 seconds, so a retry is cheap.

A person who `unknown` turns out to be a machine (a beep or a long monologue after the Disclosure) is detected again for the first 10 seconds of the loop, and the Call ends with result `voicemail` and no further speech; the Disclosure, which names AI and recording only, may already be on the machine, and this is the accepted edge and is recorded. A later change may add a message behind a setting that is off for an Organization until its wording is reviewed; v1 has no such setting.

**Opening.** After the Disclosure the Agent states who it is calling for, the reason for the call from the Step's goal (one line) and asks if it is a good time. "Not now" ends the Call politely with end reason `not_now` and lets the Sequence decide. Speech, Documents and web text remain untrusted, delimited data.

**What the Prospect can say to opt out.** A deterministic matcher on each final speech-to-text turn, running before the model, recognises stop phrases (stop, do not call, don't call me, remove me, take me off, unsubscribe). "Not interested" is not a stop phrase: it ends the Call as `not_interested` without suppression. A match calls core's `record-withdrawal` (M03-T7) for the phone channel, which withdraws the Contact Consent and adds a Suppression for the number in the Organization, then the Agent says one fixed confirmation line and ends. The model's `revoke consent` tool does the same for phrasings the matcher misses; the matcher never depends on the model. The Call result is `answered` with end reason `opted_out`; `outbound` ends the Enrollment with stop reason `call.opted_out`, and `suppression.added` / `consent.withdrawn` cancel every other scheduled Step for that number. Pressing a key is out of scope (no DTMF).

**Call result.** Stored on `agent_calls` and published with `voice.agent_call.ended`: result `answered`, `voicemail`, `no_answer`, `busy`, `failed` or `blocked`; for `answered` an end reason (`booked`, `handed_off`, `not_interested`, `not_now`, `opted_out`, `prospect_hung_up`, `cap_reached`, `agent_ended`); for `blocked` the gate code; duration; the Call id (so the Transcript and Recording link through). Sequence branches use these values.

**Retries and attempt limits.** `outbound` owns retry: a call Step has `max_attempts` (default 3, hard maximum 3) and `retry_after` (default 4 hours, minimum 4 hours). `no_answer`, `busy`, `voicemail` and `failed` retry; `answered` and `blocked` by `consent.*` never do. A retry is due only inside the next calling window. `voice` enforces the ceilings regardless of what `outbound` asks: at most one dial per Prospect number per calendar day in the Prospect's zone, and at most three per rolling seven days across all Campaigns and Rep requests. Attempt counts come from `agent_calls`, never from memory.

**Line caps.** Each Line has `max_concurrent_agent_calls` (default 3) and `daily_agent_dial_cap` (default 150, rolling 24 hours). An Organization's concurrency cap (M12, default 20) still applies. A cap hit defers the request and returns a retry time; it does not use an attempt. Which Line: the Step or Campaign names one, else the Organization's default outbound Line; no rotation (R50 to R52 are not in v1).

**Idempotency.** The key for a Step is `<enrollment id>:<step id>:<attempt>`; for a Rep request it is a client key. `agent_calls` is unique on Organization and key. The row is stored in state `dialing` with the key passed to the provider as its command id before the dial, so a crash between dial and store cannot dial again. The provider's webhooks are idempotent by event id (M12). A restart mid-Call resumes (M14-T9).

**Rep request ("call now").** `POST` from the portal, role Rep, Manager, Admin or Owner, for a Prospect the user can see (M02 visibility), with a goal from a short list or free text and no Enrollment. It runs the same gate, records `source=rep_request` and the requesting Rep, and counts toward the same limits. A refusal is shown to the Rep in words.

**Handoff and booking.** Reused from M14. If no Rep is online or none answers, the Agent offers a Booking through core (M10); the Handoff line "a person has joined, the Call is recorded and AI-assisted" plays before the bridge.

**Telephony.** Add to kit's `TelephonyPort` an operation to place an Agent-leg Call from a Line to a number (no browser leg) with the media stream attached, and an answering-machine detection event. Memory adapter scripts every case (human, machine, unknown, busy, no answer). The real adapter is the one M12 shipped (ADR 0027 chose Telnyx; M12 names Twilio, the ticket states which landed).

**Data (`db`).** `voice.agent_calls` (Organization, key, source, enrollment id and step id as opaque ids, Prospect id, number hash, Line, attempt, state, result, end reason, gate code, timestamps, Call id), `voice.lines` gains the two cap columns, `outbound.enrollment_events` gains no new table (a `call.result` event type), the Step carries `max_attempts` and `retry_after` in the Sequence JSON. All tenant tables have fail-closed RLS. Phone numbers are never logged.

**Contract.** `contract` adds to M07's Sequence union a `call` Step (goal, Line, `max_attempts`, `retry_after`) and branch conditions on call result; an `agent_call` area with the internal request route (idempotency key required), the Rep request route, get and list (cursor, page size at most 100, role-scoped); events `voice.agent_call.ended` (extended with result and end reason; M14 owns the name) and `voice.consent.revoked`. Errors: `agent.timezone_unknown`, `agent_call.attempts_exhausted`, `agent_call.line_cap_reached`, `agent_call.duplicate` (returns the existing row), plus the existing `agent.paused`, `agent.consent_required`, `agent.outside_hours`, `consent.*`.

**Expected complexity.** The gate is O(1) queries per request (one check, a few indexed counts). The call Step handler is O(1) per Enrollment-Step like the email Step. Nothing is proportional to an Organization's size on a request path.

## Testing Decisions

- Highest seam: the voice internal route on memory telephony, scripted memory speech-to-text, memory TTS, memory LLM and a core double built from the contract schemas; for `outbound`, the sweep with an injected clock and a voice double.
- Gate: table-driven cases for paused, no consent, wrong channel, withdrawn, suppressed, core unreachable, outside hours, unknown zone, attempts exhausted and Line cap; each prevents the dial, stores a result with its code and plays no audio. Property: a Prospect without a current phone consent is never dialed by any path (Step, Rep request, retry, restart).
- Disclosure first: with a delayed or failed Disclosure the Call never reaches `live` and no greeting or model call occurs; the first audio on a `human` answer is the Disclosure.
- Voicemail: `machine` ends silently, no audio sent, no model call, result `voicemail`; `unknown` plays the Disclosure; a late machine is caught inside 10 seconds.
- Opt-out: each stop phrase (and a transcript with the phrase inside a longer sentence) withdraws consent and suppresses the number before the model is called; "not interested" does not suppress; after opt-out, every scheduled Step for that number is cancelled.
- Idempotency: the same key twice dials once; a crash after the `dialing` row and before the provider answer does not dial twice; a webhook replay changes nothing.
- Retries: spacing, windows, hard ceilings (one a day, three in seven days) and that `answered` is never retried.
- Second-Organization test: B cannot read A's `agent_calls`, results or Lines, cannot request a Call for A's Prospect, and its Calls never count against A's caps.
- Portal: component tests and `agent-browser` runs of the Step editor, launch check refusal text and the Rep "Call now" refusal.
- Prior art: M14 voice suite, M03 Contact Check matrix, M07 sweep tests.

## Out of Scope

- A voicemail message, or a voicemail drop by a Rep; DTMF menus and "press 9" opt-out.
- Number health, local presence, caller-ID branding and rotation (R50 to R52); parallel or power dialing.
- A Prospect-level time zone field (M02 change) and Rep Calls (M12 already covers them).
- Languages other than English, voice cloning, SMS and WhatsApp Steps (M14 slices).
- Calling a Prospect with no Contact Consent, for any reason or by any setting (ADR 0003).
- Attempts and results analytics (M15).

## Further Notes

- **Proposed GLOSSARY terms.** **Voicemail**: an answering machine or recorded greeting that picks up a Call in place of the Prospect. _Avoid_: answering service, mailbox (Mailpit is a mailbox), message bank. **Call result**: what became of one placed Call: answered, voicemail, no answer, busy, failed or blocked. _Avoid_: Outcome (that is a Deal's), disposition, status. **Calling window**: the hours in the Prospect's time zone inside which an Agent may place a Call. _Avoid_: quiet hours, business hours, send window (that is for email). M14 proposes **Handoff** (_Avoid_: warm transfer); this spec uses Handoff, not "Warm Handoff".
- **ADR needed.** "Outbound Agent calls: calling window, voicemail and attempt limits" (T1). M14 listed "Agent call hours" as needed; this ADR covers it for both directions.
- **Dependencies.** M07-T1, M07-T2 and M07-T5 (Sequence, Enrollment, engine); M14-T3, T4, T5, T9, T12 and T13 (Agent contract, tables, settings, speech loop, tools, Handoff); M12-T5 and T7 (telephony adapter, Disclosure state machine); M03-T4 to T7 (Contact Check, consent, ContactGuard, STOP); M16-T7 (windows and pause); M02-T4 (Prospect); M10-T12 (book).
- **11x rows.** R22 and R54 at parity on the phone, with the consent gate; R90 and R91 enforced by design; ahead on the voicemail rule and the hard attempt ceilings. 11x publishes no voicemail, hours or opt-out behaviour, so the comparison there is unverified.
- **Not verified yet.** Answering-machine detection accuracy and time on the real adapter, and false `machine` rates on real carriers; the calling-window rules per US state; whether a Disclosure lands on a machine in the `unknown` case; the STT recognition of stop phrases on phone audio.
