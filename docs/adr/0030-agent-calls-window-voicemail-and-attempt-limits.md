# ADR 0030 — Agent calls: calling window, voicemail and attempt limits

**Status:** Accepted
**Date:** 2026-10-28
**Builds on:** ADR 0003, ADR 0013, ADR 0027

## Context

ADR 0003 says an Agent may call only with a Contact Consent and must disclose AI and recording. It
says nothing about when a Call may be placed, what happens when an answering machine picks up, or how
often one number may be rung. M14 (Inbound Agent callback to a form Inquiry) listed "Agent call hours"
as a needed record, and M17 (Outbound Agent call) adds Calls started by a Campaign or a Rep's request.
Both are Calls an Agent places, so one rule set covers them. The lead decided the points below on
2026-10-28; the spec is `docs/specs/m17-outbound-agent-call.md`.

## Decision

1. **Calling window: 08:00 to 21:00 in the Prospect's time zone, every day.** An Organization or
   Campaign setting may narrow it and never widen it. The zone is derived from the Prospect's phone
   number (NANP area codes, one-zone countries); a number whose zone cannot be fixed is refused with
   `agent.timezone_unknown`, never guessed. Outside the window the request is refused with
   `agent.outside_hours` and the next opening time.
2. **Voicemail: hang up, leave nothing.** The telephony port reports `human`, `machine` or `unknown`
   within at most 4 seconds of answer while the Agent says nothing. `machine` ends the Call silently
   with result `voicemail`. `unknown` is treated as a person and starts with the Disclosure. A late
   machine caught in the first 10 seconds of the conversation ends the Call as `voicemail` too; a
   Disclosure that reached it is the accepted edge and is recorded. v1 has no voicemail message and
   no setting for one.
3. **Attempt limits.** At most 3 attempts per call Step, at least 4 hours apart, retried only inside a
   calling window. `voice` enforces, whatever `outbound` or a Rep asks: at most 1 dial per Prospect
   number per calendar day in the Prospect's zone, and at most 3 per rolling 7 days across all
   Campaigns and Rep requests. Counts come from `agent_calls`, never memory. `answered` and
   `consent.*` refusals are never retried.
4. **Line caps.** Each Line allows 3 concurrent Agent Calls and 150 dials per rolling 24 hours by
   default. A cap hit defers the request and does not use an attempt.
5. **"Call now" does not waive consent.** A Rep who asks the Agent to call a Prospect goes through the
   same gate; the Agent places the Call, so ADR 0003 rule 1 applies in full.
6. **Spoken opt-out is deterministic.** A matcher on each final speech-to-text turn recognises stop
   phrases (stop, do not call, don't call me, remove me, take me off, unsubscribe) before the model
   runs. A match withdraws the phone Contact Consent and suppresses the number, then the Agent says one
   fixed line and ends. "Not interested" is not a stop phrase and does not suppress. The model's
   revoke tool covers phrasings the matcher misses; the matcher never depends on the model.
7. **The gate fails closed**, in this order: Agents paused, idempotency, Contact Check (phone,
   `agent_initiated`), calling window, attempt limits, Line caps. It runs on the request and again
   immediately before dialing. None of consent, Disclosure or the window has a setting that disables it.
8. **A lawyer must review state-by-state variations before real customers.** The hours, the
   per-number frequency limits and the recording and opt-out rules differ by US state and country; the
   values above are a platform floor chosen by the lead, not legal advice.

## Considered options

- **Leave a short compliant voicemail message.** An AI-voiced recorded message that no one can decline
  or answer; a script to word, review and defend; against M14. Rejected for v1.
- **Per-Organization hours, widenable.** Lets an Organization breach the floor. Rejected; narrowing only.
- **Guess the zone when unknown, or use the Rep's.** Wrong calls at night. Rejected; refuse instead.
- **Disclose by location only** (as ADR 0003 already rejected) applies here too.

## Consequences

- Unknown-zone numbers cannot be called until a Prospect-level time zone exists (a later change).
- A false `machine` reading drops a real person; the cost is one cheap retry. Detection accuracy on
  real carriers is not yet verified.
- Stop-phrase recognition on phone audio is not yet verified; the model tool is the second line.
- `voice` needs `agent_calls` and Line cap columns in `db`; `kit`'s telephony port gains an Agent-leg
  dial and a machine-detection event; the real adapter is Twilio today (ADR 0027 chose Telnyx).
- M14 "Agent call hours" is closed by this record for the Inbound Agent callback as well.
