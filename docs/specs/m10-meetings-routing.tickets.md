# M10 tickets: Meetings and routing

Libraries first (T1 to T4). Core slices (T5, T6, T9, T10, T12) each pair with a portal slice so the work is demoable. `M02-T4` is the Prospect API in core, including upsert by email.

### T1: Contract: Booking, routing and calendar routes
Repo: contract
Blocked by: none

## What to build
Routes, schemas, error codes and events listed in the spec, including the public slots and book routes. Tag a release.

## Acceptance criteria
- [ ] Every route has role list and OpenAPI description; lists are cursor-paginated with a maximum page size.
- [ ] `book` requires an idempotency key; schema tests reject its absence.
- [ ] Error codes `booking.slot_taken`, `booking.calendar_unavailable`, `booking.no_eligible_rep`, `routing.rule_invalid`, `calendar.not_connected` exist.
- [ ] Rebuilt `dist/` committed and tag pushed.

### T2: Core schema for calendars, rules and Bookings
Repo: db
Blocked by: none

## What to build
The tables in the spec with RLS and an exclusion constraint on a Rep's confirmed Booking time ranges.

## Acceptance criteria
- [ ] RLS harness: Organization B reads and writes no row of A in any table.
- [ ] Inserting two overlapping confirmed Bookings for one Rep fails at the database; non-overlapping and cancelled ones succeed.
- [ ] Migration generated and checked; tag pushed.

### T3: Calendar port and memory adapter
Repo: kit
Blocked by: none

## What to build
`CalendarPort` (connect, busy intervals, event create, update, delete idempotent by request id, revoke) with a memory adapter and a behaviour suite.

## Acceptance criteria
- [ ] Suite covers an idempotent re-create, a failing provider and a revoked connection.
- [ ] Tokens never appear in logs or errors.
- [ ] `dist/` rebuilt; tag pushed.

### T4: Google Calendar adapter
Repo: kit
Blocked by: T3

## What to build
Google implementation (free/busy, events with Meet link, least scopes). Blocked on credentials.

## Acceptance criteria
- [ ] T3 suite passes with credentials, skipped and named without.
- [ ] Timeouts and bounded jittered retry on every call.

### T5: A Rep connects a calendar
Repo: core
Blocked by: T1, T2, T3

## What to build
Start and complete a connection (memory adapter in tests and dev), status, disconnect with token removal.

## Acceptance criteria
- [ ] Connect, see `healthy`, disconnect; tokens are encrypted and never returned.
- [ ] A revoked grant flips the status to `needs_reconnect`.
- [ ] A Rep cannot read or disconnect another Rep's connection; Organization B cannot see A's.

### T6: Booking Types and working hours
Repo: core
Blocked by: T5

## What to build
Admin CRUD of Booking Types (length, buffers, notice, mode, public link token) and a Rep's working hours and time zone.

## Acceptance criteria
- [ ] Invalid hours or length answer a typed error.
- [ ] A Rep cannot edit Booking Types; an Admin cannot edit a Rep's connection.
- [ ] Second-Organization test on both.

### T7: Rep calendar and hours in the portal
Repo: portal
Blocked by: T6

## What to build
A settings page where a Rep connects a calendar, sees its health and sets hours and time zone.

## Acceptance criteria
- [ ] Connect on the memory adapter, see the status change, set hours; error messages show their code text.
- [ ] Checked with `agent-browser`.

### T8: Booking Types in the portal
Repo: portal
Blocked by: T6

## What to build
An Admin page to create, edit and retire Booking Types and copy the public link.

## Acceptance criteria
- [ ] Create, edit, retire; a Rep does not see the page.

### T9: Busy-block refresh and Rep slots
Repo: core
Blocked by: T6

## What to build
A queued, idempotent refresh of busy blocks for the next 14 days, and `slots` for one Rep computed from hours, busy blocks and Bookings.

## Acceptance criteria
- [ ] Busy memory-calendar times never appear as slots; hours and buffers are respected across time zones.
- [ ] `slots` never calls the calendar on the request path.
- [ ] `bench/slots.bench.test.ts` holds the CPU part to its budget with the measured number in a comment.

### T10: Routing rules and `route`
Repo: core
Blocked by: T9, M02-T4

## What to build
Rule CRUD (Admin, and Manager for Team-targeted rules), the `test` route, `route` returning ordered candidates with reasons, round-robin under a row lock, and stored decisions.

## Acceptance criteria
- [ ] Table-driven tests cover each condition, the default rule, skipped Reps with reasons and the daily cap.
- [ ] A hundred concurrent routes spread across a Team within one booking of even.
- [ ] A Manager cannot change a rule that targets another Team; Organization B never routes to A's Reps.

### T11: Routing rule editor
Repo: portal
Blocked by: T10

## What to build
An ordered rule editor with a "try a sample Prospect" panel that shows the winning rule, the ordered Reps and who was skipped and why.

## Acceptance criteria
- [ ] Reorder, edit and test; the result matches the API.
- [ ] Checked with `agent-browser`.

### T12: Pooled slots, book, reschedule, cancel
Repo: core
Blocked by: T10

## What to build
`slots` across routed candidates, idempotent `book` with live re-check, calendar write, exclusion constraint, reschedule, cancel and the three events.

## Acceptance criteria
- [ ] Two simultaneous books for one slot: one `confirmed`, one `booking.slot_taken`.
- [ ] A calendar write failure leaves no Booking and the same key then succeeds.
- [ ] Reschedule and cancel are idempotent by end state; events are published once.
- [ ] Organization B cannot book into A's Reps or read A's Bookings.
- [ ] Pooled `slots` p95 within 800 ms over 20 Reps and 14 days on the memory adapter.

### T13: Public booking page
Repo: portal
Blocked by: T12

## What to build
A public page for a Booking Type link: times in the Prospect's zone, name and email, confirmation, cancel and reschedule from the confirmation.

## Acceptance criteria
- [ ] A Prospect books on the memory calendar and sees the confirmation; a taken slot shows a clear message.
- [ ] Input is validated at the edge; the page is rate-limited; no internal ids are exposed.
- [ ] Checked with `agent-browser`.

### T14: Bookings list
Repo: portal
Blocked by: T12

## What to build
Upcoming and past Bookings with cancel and reschedule, scoped by role.

## Acceptance criteria
- [ ] Rep sees own, Manager Team, Admin all; paged by cursor.

### T15: Booking in `dev:smoke`
Repo: hub
Blocked by: T12

## What to build
A smoke step that connects a memory calendar, books through a link and checks the event, plus an Organization isolation check.

## Acceptance criteria
- [ ] `bun run dev:smoke --strict` passes with the new steps.

### T16: Outlook calendar adapter
Repo: kit
Blocked by: T3

## What to build
Microsoft Graph implementation of `CalendarPort`. Later slice; blocked on credentials.

## Acceptance criteria
- [ ] T3 suite passes with credentials, skipped and named without.
- [ ] Core selects the adapter per Calendar Connection.
