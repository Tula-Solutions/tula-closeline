Phase: 2 · Repos: hub, contract, db, kit, voice, playbook, portal, infra · Parity rows: R26, R59 (R53 and R54 land in M14; R50 to R52 deferred)

# M12 Voice platform and softphone

## Problem Statement

A Rep today cannot place or take a Call in Closeline. There is no telephony, no Recording, no live Transcript and no place for the Copilot or an Agent to stand. Every Call a Rep makes elsewhere is invisible to the Playbook, so the Organization's best new evidence never reaches it. The law also asks for something no competitor documents (R90, R91): every Call that is recorded or AI-assisted must say so, and the system, not the Rep's memory, must enforce it (ADR 0003).

## Solution

A new service, `tula-closeline-voice`, owns Lines, Calls and Disclosures. A Rep opens the Softphone in the portal, dials a Prospect or answers a ring on an Organization Line, and every connected Call plays a Disclosure before the two sides hear each other, then is recorded on two channels (Rep and Prospect). When the Call ends, voice stores the Recording in the Region's storage, publishes `voice.call.ended`, and the Playbook ingests it through the ADR 0018 path so it becomes searchable Moments once its Deal is won. Telephony sits behind a port with a memory adapter and Twilio as the first real adapter. The Copilot (M13) and the Inbound Agent (M14) are later consumers of the same Call.

## User Stories

1. As a Rep, I want to dial a Prospect from my browser, so that I can call without a desk phone.
2. As a Rep, I want to type or paste a number and see it normalised to E.164 with the country, so that I do not misdial.
3. As a Rep, I want my microphone and speaker choices remembered, so that I join Calls ready.
4. As a Rep, I want to answer a ring on an Organization Line in my browser, so that inbound Calls reach me.
5. As a Rep, I want to mute, unmute, hold and hang up, so that I control the Call.
6. As a Rep, I want to see that the Disclosure has played before I start talking, so that I know the Call is lawful to continue.
7. As a Rep, I want a short wrap-up after the Call where I can set the Deal identifier and a note, so that the Call joins the right Deal in the Playbook.
8. As a Rep, I want my Call history with times, durations and outcomes, so that I can find a Call again.
9. As a Rep, I want to play back the Recording of my own Call, so that I can review it.
10. As a Rep, I want to read the Transcript of my own Call, so that I can quote the Prospect exactly.
11. As a Rep, I want a missed inbound Call listed with the caller number, so that I can call back.
12. As a Rep, I want a clear message when my browser cannot reach the microphone, so that I can fix it.
13. As a Prospect, I want to hear at the start that the Call is recorded and AI-assisted, so that I can decide to stay on the line.
14. As a Prospect, I want to hang up at any time with no further contact from that Call, so that I stay in control.
15. As a Manager, I want to list and play back Calls of the Reps on my Team, so that I can coach them.
16. As a Manager, I want not to see Calls of Reps outside my Team, so that visibility follows the role rules.
17. As an Admin, I want to see every Call in the Organization, so that I can audit conversations.
18. As an Admin, I want to add a Line by buying or porting a number, so that the Organization has a caller identity.
19. As an Admin, I want to assign a Line to a Team or a Rep, so that inbound Calls ring the right people.
20. As an Admin, I want to release a Line, so that we stop paying for it.
21. As an Admin, I want to delete a Recording and its Transcript, so that I can honour a deletion request.
22. As an Admin, I want to see which wording version of the Disclosure each Call played, so that I can answer a legal claim.
23. As an Owner, I want the Disclosure to be impossible to switch off, so that no setting exposes the Organization (ADR 0003).
24. As an Admin, I want the Recordings and Transcripts of my Calls to flow into the Playbook automatically, so that I do not upload them by hand.
25. As an Admin, I want the Recordings kept in my Region's storage only, so that the Region boundary holds (ADR 0001).
26. As a Rep, I want a Call to continue if the Copilot or Transcript fails, so that tooling never costs me a conversation.
27. As a Rep, I want a second Organization's Prospects never to appear in my history, so that tenancy holds even for a person in two contexts.
28. As an Admin, I want a Call dropped by the carrier to be recorded as failed with a reason, so that I can tell it from a hang-up.

## Implementation Decisions

**Repos and ownership.** `voice` is created from `templates/service` (hub ticket, `scripts/new-repo.sh`). It is the only writer of the `voice` Postgres schema (tables for Lines, Calls, Call events, Disclosure plays, Recording references) and owns the modules `line`, `call`, `softphone`, `disclosure` and `recording`. `db` owns the migrations. `contract` gets a `voice` area. `kit` gets the telephony port and adapters. `playbook` gains one consumer. `portal` gets the Softphone, Call history and Lines pages.

**Telephony port (kit).** `TelephonyPort`: place a Call between a browser leg and a number, answer an inbound Call and ring a set of browser legs, play a Disclosure into a connected Call before bridging, start dual-channel recording, fork both audio tracks to a socket (used from M13), bridge or move a leg (used from M14), hang up, fetch and delete a provider-side Recording, verify a webhook signature, and mint a short-lived browser access token. A memory adapter runs scripted Calls in tests and in `bun run dev`. First real adapter: **Twilio** (Programmable Voice, Voice SDK for the browser, Media Streams), chosen because it is what 11x uses (R26, R60 inferred) and it has an Ireland region for the EU Region. No ADR covers this: a new ADR, "Voice stack vendors", records Twilio for telephony alongside the streaming STT, TTS and LLM choices of M13 and M14.

**The Disclosure is a state machine, not a convention.** A Call moves `ringing → connecting → disclosing → live → ended` (or `failed`, `missed`). Two audio legs are bridged only after the `disclosure.played` event for the current wording version is stored. Recording starts after the Disclosure. Wording is versioned like the rights wording (ADR 0018); the Call stores the version it played. All softphone Calls are recorded (decision for the lead: a Rep cold-calling is allowed by ADR 0003, and always recording keeps the all-party-consent states simple). The Disclosure names recording and, from M13 on, AI assistance; for Calls without the Copilot it says recording only; an Agent Call (M14) always says AI and recording. No code path or setting skips it.

**Contact Consent is not checked for a Rep.** A Rep may call any Prospect (ADR 0003). The softphone still checks the global suppression list owned by core (`M03-T4`, the Contact Check) and warns the Rep; the warning is not a block for a Rep, but a block for any Agent (M14).

**Contract (`voice` area).** Routes: list and add Lines; place a Call (idempotency key required); get and list Calls (cursor, page size at most 100, role-scoped: Rep own, Manager Team, Admin and Owner all); get a Call's Transcript; get a signed Recording playback URL; delete a Recording (Admin); set wrap-up (Deal identifier, note); mint a softphone token. Webhooks from Twilio are internal routes outside the public contract. Error codes use `area.reason`, for example `call.consent_required`, `call.number_invalid`, `call.disclosure_failed`, `line.not_found`. Events: `voice.call.started`, `voice.call.ended` (carries Call id, Organization, Rep, Prospect phone hash, direction, times, Recording key, Deal identifier if set). Every event carries the event envelope from the contract.

**Schema (db).** `voice.lines`, `voice.calls` (direction, state, rep, prospect number, line, disclosure version and time, started, answered, ended, failure reason, deal identifier), `voice.call_events` (append-only state log, also the idempotency record for webhooks), `voice.recordings` (storage key, size, channels, state, purge time). Every table has `organization_id` with fail-closed row-level security through the tenant helper. Prospect phone numbers are tenant data and are never logged.

**Recording and Transcript.** Twilio records two channels. A queue job copies the file into Region storage with the storage port, deletes the provider copy, and publishes `voice.call.ended`. The Playbook consumer fetches the Recording from voice over the internal-call mechanism of ADR 0013 (never from voice's bucket directly), declares channel 1 as the Rep (so ADR 0018's `awaiting_rep` state is skipped), transcribes with its existing transcribe port, and creates a Call tagged `source=live`. Its Moments become searchable once the Deal is won (ADR 0018 choice 6). The Recording confirmation of rights (ADR 0018 choice 12) does not apply to Calls the platform made itself.

**Webhooks.** Verified by signature with constant-time comparison, idempotent by provider event id, O(1) per request, answered under 50 ms p95; slow work goes to the queue. Provider calls have timeouts and bounded jittered retry.

**Budgets.** Place-a-Call API to the first ring on the Prospect's phone: p95 at most 2 s excluding the carrier. Webhook handler: p95 at most 50 ms (benchmark in `voice/bench`, budget about 5x the measured fastest batch). Concurrent Calls per Organization capped by a setting (default 20) to bound cost.

**Presence** (which Reps are online in the Softphone) is kept in voice and exposed to M14 for transfer.

**Portal.** Softphone as a persistent panel with dial pad, in-call controls and a Disclosure indicator; Call history and detail with Transcript and playback; Lines admin. Direction: the editorial ink-and-paper system; no generic dialer template.

## Testing Decisions

- Highest seam: HTTP routes of voice on the memory telephony adapter, driven by scripted provider webhooks. Assert externally: the Disclosure event precedes the bridge and the Recording start; a Call with a failed Disclosure ends `failed` and never reaches `live`; a duplicate webhook changes nothing.
- A property-style test enumerates every state transition and fails if `live` is reachable without `disclosure.played`.
- Second-Organization test in voice: Organization B cannot list, read, play, or delete Organization A's Calls, Lines or Recordings, and cannot see them through the Playbook search either. Role tests: Rep own, Manager Team, Admin all.
- A behaviour suite for `TelephonyPort` shared by the memory and Twilio adapters (Twilio run only where credentials exist, the same way kit's AWS adapters are).
- Benchmark `bench/webhook.bench.test.ts` with the budget above.
- Playbook consumer: an ended Call becomes a Call with Moments, absent from search until its Deal is won, using the ADR 0018 test fixtures.
- Portal: component tests for the Softphone state display; `/run-check` with `agent-browser` against the memory adapter (the real microphone path cannot be checked in CI and is listed under not verified).
- Prior art: kit's queue behaviour suite, playbook's call-upload tests, `dev:smoke` in the hub.

## Out of Scope

- The Copilot (M13) and every Agent (M14); this module only exposes the Call they attach to.
- Number health, spam-flag detection, local-presence dialing, branded caller ID, rotation (R50 to R52): later, with Outbound.
- Power or parallel dialing, voicemail drop, call queues and IVR menus, conferencing, call transfer between Reps.
- Mobile apps and desk-phone (SIP) endpoints.
- Voice Profile cloning.
- Post-call AI summary and sentiment (R60): M15.
- Manager live listen or whisper.

## Further Notes

- **Proposed GLOSSARY terms.** **Softphone**: the in-browser phone a Rep uses to place and take Calls. _Avoid_: dialer, web phone, power dialer. **Line**: a phone number an Organization uses to place and receive Calls. _Avoid_: DID, number, trunk. **Disclosure**: the announcement at the start of a Call that it is recorded and, where an Agent or the Copilot takes part, that AI is involved; not the Recording. _Avoid_: warning, notice, banner, consent message.
- **ADRs needed.** "Voice stack vendors" (Twilio, plus M13 and M14 choices). "Call recording: all softphone Calls recorded, Disclosure wording versioned, retention and deletion". Neither exists.
- **Open points for the lead.** Time-of-day and DNC rules for Rep Calls are not in ADR 0003 and are left to the Rep. A lawyer should review the Disclosure wording before real customers (as ADR 0018 already says for rights wording).
- **11x rows.** Parity on R26 (human dialer, without the power-dialer part) and R59 (recording and transcript). Ahead on R91 (disclosure) and R92 only in that Recordings can be deleted by the Organization.
- **Not verified yet.** Twilio Media Streams two-track behaviour on a Voice SDK leg and the Ireland region's media-stream support; verify in T5 of the tickets before M13 depends on it.
