Phase: 3 · Repos: contract, db, kit, core, portal, hub · Parity rows: R38, R39, R41 (routing target), R78 (Google Calendar; Outlook later); R40 met by function, not by Chili Piper

# M10 Meetings and routing

## Problem Statement

An Agent that qualifies a Prospect, or a Prospect who clicks a link, needs one answer: who should talk to them, and when. Closeline has no calendars, no rule for choosing a Rep, and no way to reserve time. Without them the Inbound Agent (M14) can qualify but cannot finish, and every Handoff is a guess. 11x books "with the right rep" using territory, round-robin and named-account rules, and works beside Chili Piper (R38 to R41). Reps also have to trust that a booked time is real: no double bookings and no booking into a busy hour.

## Solution

`core` gains Calendar Connections, Booking Types, Routing Rules and Bookings. A Rep connects Google Calendar once. An Admin defines Booking Types (a name, length, buffers, minimum notice, phone or video) and ordered Routing Rules that pick a Rep or a Team from a Prospect's attributes. Two callers use the same API: the Inbound Agent in conversation (M14) and a public booking page a Prospect opens. Both ask for slots, choose one and book; core re-checks the calendar, reserves the time so it cannot be taken twice, writes the event to the Rep's calendar, and records which rule picked the Rep and why. The same routing answers "who should take this live Call?" for a Handoff. Calendar vendors sit behind a port with a memory adapter; Google Calendar is the first adapter and Outlook follows.

## User Stories

1. As a Rep, I want to connect my Google Calendar, so that Closeline sees when I am busy.
2. As a Rep, I want to disconnect my calendar and have my tokens removed, so that I stay in control of my data.
3. As a Rep, I want to see that my connection is healthy or needs reconnecting, so that Bookings do not silently fail.
4. As a Rep, I want to set my working hours and time zone, so that nobody books me at night.
5. As a Rep, I want Bookings to appear on my calendar with the Prospect's name and a join link or phone number, so that I know what to do.
6. As a Rep, I want a buffer between Bookings and a daily cap, so that I can breathe.
7. As a Rep, I want to see my upcoming Bookings, so that I can prepare.
8. As a Rep, I want to cancel or move a Booking, so that real life fits.
9. As a Prospect, I want to pick a time on a simple page, so that I book without waiting for an email.
10. As a Prospect, I want to see times in my own time zone, so that I do not miscount.
11. As a Prospect, I want a confirmation with the time and how to join, so that I can plan.
12. As a Prospect, I want to cancel or reschedule from the confirmation, so that I do not have to write to anyone.
13. As a Prospect, I want a clear message when a time was just taken, so that I can pick another.
14. As an Admin, I want to define Booking Types with length, buffers, minimum notice and mode, so that each conversation has the right shape.
15. As an Admin, I want to write ordered Routing Rules on a Prospect's country, company size, named account owner and source, so that the right Rep gets the right Prospect.
16. As an Admin, I want a rule to target one Rep, a Team in round-robin, or a pool of Reps, so that load is shared.
17. As an Admin, I want a default rule when nothing matches, so that no Prospect is dropped.
18. As an Admin, I want to test a rule set with a sample Prospect and see which rule wins and which Rep comes out, so that I can trust it before use.
19. As an Admin, I want to see why a Prospect was routed to a Rep (rule, reason, who was skipped and why), so that I can explain it.
20. As a Manager, I want to manage rules that target only my Team, so that I can run my Team's flow.
21. As a Manager, I want to see my Team's Bookings, so that I know the pipeline of conversations.
22. As a Manager, I want Reps who are away or at their daily cap skipped by round-robin, so that load is fair.
23. As an Admin, I want to see every Booking in the Organization, so that I can audit them.
24. As an Owner, I want one Organization's calendars and Bookings to be invisible to every other Organization, so that tenancy holds.
25. As the Inbound Agent's operator (an Admin), I want the Agent to book through these same rules, so that it behaves like the booking page.
26. As an Admin, I want the live-transfer candidates for a Prospect in order, so that a Handoff rings the right Rep first.
27. As a Rep, I want a double booking to be impossible even if two Prospects click at once, so that I never have to apologise.
28. As an Admin, I want a Booking to say whether it is a phone Call or video, so that Reps know where to be.
29. As a Rep, I want a video Booking to include a Google Meet link, so that I do not paste one.
30. As an Admin, I want the Booking to fail cleanly, with nothing half-written, if the calendar is down, so that I never have a ghost entry.

## Implementation Decisions

**Ownership.** `core` owns the module set `calendar`, `booking`, `routing` in its Postgres schema (`db` migrations). `contract` gets Booking and routing routes and events in the `core` area. `kit` gets `CalendarPort`. `portal` gets the Rep calendar settings, the Admin pages, the Bookings list and the public booking page. M14 (voice) calls core over the internal client; voice never reads core tables.

**Calendar port (kit).** `CalendarPort`: begin and complete the OAuth connection, read busy intervals for a time range, create, update and delete an event (idempotent by request id), list the calendar's free/busy for one Rep, revoke. Memory adapter plus behaviour suite. First real adapter: **Google Calendar** (free/busy and events with Meet conference data), least scopes. Outlook (Microsoft Graph) follows as a second adapter. No ADR covers calendars: a new ADR, "Calendar and routing", records the vendor, the stored-token handling and the double-booking rule.

**Credentials.** OAuth refresh tokens are stored encrypted and never returned or logged; the pattern is the HubSpot connection's (phase 1 step 1.16). If that ticket ships a different shape, T5 adapts to it and says so.

**Availability.** A queue job refreshes each connected Rep's busy blocks for the next 14 days into `busy_blocks` every few minutes and on a Booking change. Slot requests read `busy_blocks`, working hours and existing Bookings; they never call Google on the request path. The booking step is the only place that reads the live calendar, for one Rep, with a 3 s timeout and a bounded, jittered retry.

**Routing.** A Routing Rule is ordered and has conditions (country, region, company size band, named-account owner, source, Booking Type) and a target (one Rep, one Team round-robin, or a named pool). `route` takes a Prospect (attributes from M02) and returns an ordered candidate list with a reason per candidate; Reps off shift, disconnected, on leave or at their daily cap are listed as skipped with the reason. Round-robin state is a row per target, advanced under a row lock, so concurrent bookings do not pick the same Rep twice. Every decision is stored (`routing_decisions`) with the matched rule and the skipped Reps.

**Booking.** Slots: across the eligible candidates, at most 20 Reps and 14 days considered, returns merged times and, per time, the Rep who would take it. Book: requires an idempotency key; locks the chosen Rep's slot, re-checks live free/busy, stores the Booking (`pending`), writes the event with a request id, marks it `confirmed`, publishes `core.booking.created`. If the calendar write fails the Booking is removed and the error is `booking.calendar_unavailable`; a retry with the same key is safe. An exclusion constraint on each Rep's time ranges (including buffers) makes overlapping confirmed Bookings impossible even under races. Reschedule and cancel are idempotent by end state and publish events. The Google invitation to the Prospect is the calendar's own; Closeline sends no email in this module.

**Contract.** Routes: Calendar Connections (start, complete, status, disconnect), working hours, Booking Types, Routing Rules (with a `test` route), `route`, `slots`, `book`, reschedule, cancel, list Bookings (cursor, role-scoped), and public equivalents for slots and book under an unguessable Booking Type link with rate limits. Errors: `booking.slot_taken`, `booking.calendar_unavailable`, `booking.no_eligible_rep`, `routing.rule_invalid`, `calendar.not_connected`. Events: `core.booking.created`, `core.booking.cancelled`, `core.booking.rescheduled`.

**Schema (core).** `calendar_connections`, `working_hours`, `booking_types`, `routing_rules`, `routing_state`, `routing_decisions`, `busy_blocks`, `bookings`. All have `organization_id` and row-level security.

**Roles.** Rep: own connection, own hours. Manager: rules and pools whose targets are on their Team, and their Team's Bookings. Admin and Owner: everything.

**Hot path.** Slot computation runs inside an Agent conversation. Budget: p95 at most 800 ms for `slots` over 20 Reps and 14 days on the memory calendar; the CPU part is benchmarked in `core/bench` (merge and filter of busy blocks, at most 50 ms, budget 5x measured). `route` is O(rules + candidates). Complexity is bounded by the 20-Rep and 14-day caps, never by the Organization's size.

**Public page.** A Vite route in the portal for unauthenticated Prospects: no secrets, a Booking Type token in the URL, fields validated at the edge, a Prospect upserted through M02 by email, rate-limited by address and token.

## Testing Decisions

- Highest seam: core HTTP routes on the memory calendar adapter: connect, set hours, define a Booking Type and rules, ask for slots, book, then cancel; assert the memory calendar holds exactly the events expected.
- Concurrency: two simultaneous books for one slot yield one `confirmed` and one `booking.slot_taken`; the exclusion constraint is also tested directly in the db harness.
- Routing: table-driven cases for each condition, default rule, skipped Reps with reasons, round-robin fairness over many bookings, and daily caps.
- Failure: the calendar adapter fails on write; assert no Booking remains and the same key succeeds on retry.
- Second-Organization test: B cannot read A's connections, rules, busy blocks or Bookings, cannot book into A's Reps through a public link of A's with B's token, and cannot route to A's Reps.
- Role tests: a Manager cannot change a rule targeting a Team they do not manage.
- Calendar port behaviour suite shared by memory and Google (Google only with credentials).
- Benchmark for slots with the budget above.
- Portal: component tests, `agent-browser` run of the public page and the rule editor test panel.
- Prior art: core's Invitation and idempotency-key tests, kit's queue behaviour suite, playbook bench style.

## Out of Scope

- Outlook before the later ticket, Zoom or other video vendors, CalDAV.
- Reminders, no-show tracking and rescheduling nudges by email or SMS (email arrives with M8 and M9).
- Round-robin weighted by performance, lead scoring in routing, territories drawn on a map.
- Group or multi-Rep Bookings, recurring Bookings, payments on Booking.
- Calendar push notifications from Google (the refresh job polls); Chili Piper integration (R40) is not built, since routing here covers the same function.
- Contact Consent: a Booking is initiated by the Prospect and sends no Agent contact.

## Further Notes

- **Proposed GLOSSARY terms.** **Booking**: a time reserved on a Rep's calendar for a future Call or video conversation with a Prospect. _Avoid_: meeting, appointment, event, slot. **Booking Type**: a named kind of Booking with a length, buffers, minimum notice and mode, such as "Discovery, 30 minutes". _Avoid_: meeting type, event type. **Calendar Connection**: a Rep's authorised link to their calendar so Closeline can read busy times and write Bookings. _Avoid_: calendar sync, integration. **Routing Rule**: an ordered condition that picks which Rep or Team gets a Prospect's Booking or Handoff. _Avoid_: assignment rule, lead routing.
- **ADRs needed.** "Calendar and routing" (Google first, token storage, exclusion constraint, decisions stored). None exists.
- **Dependencies.** `M02-T4` (Prospect attributes and upsert by email) and the HubSpot OAuth pattern (hub issue 17).
- **11x rows.** R38 and R39 at parity; R41 provides the routing half of a warm transfer (M14 supplies the call half); R78 for Google Calendar; R40 is deliberately met with native routing. Ahead of 11x on the stored explanation of each routing decision.
- **Not verified yet.** Google OAuth consent screen verification for the calendar scopes (a process step with lead time); behaviour for Reps with delegated calendars.
