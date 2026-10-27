# M8 Email channel and deliverability: tickets

References: `M03-T6` the kit's ContactGuard over core's Contact Check; `M03-T4` core's suppression list; `M09-T3` M09's reply ingestion API; `M05-T1` outbound repository, `M05-T4` verified-address state.

### T1: Contract for Mailboxes, sends, mail events and health
Repo: contract
Blocked by: none

## What to build
Schemas, routes, error codes and events for Mailbox, limits, send decision record, mail events, health, unsubscribe and domain check. Tagged.

## Acceptance criteria
- [ ] Mailbox responses have no token fields (parse test).
- [ ] Error codes `area.reason`, each listed; unknown fields dropped.
- [ ] Lists carry a cursor and a maximum page size; tag cut.

### T2: Schema for Mailboxes, sends and events
Repo: db
Blocked by: T1

## What to build
Migration for `mailboxes` (encrypted token columns), `mailbox_limits`, `mail_messages`, `mail_events`, `health_daily`, and the work-hint kind for mail polling and health.

## Acceptance criteria
- [ ] Row-level security on every table; isolation test lists them; a second Organization reads zero rows.
- [ ] Unique constraint on the send key and on provider message id per Mailbox.
- [ ] Tag cut.

### T3: Connect a Gmail Mailbox and send through the port
Repo: outbound
Blocked by: T2, M05-T1

## What to build
OAuth connect, callback, refresh and disconnect for Gmail; the `MailTransport` port with memory and Gmail adapters; an authenticated test-send route; token encryption; deletion of tokens on disconnect.

## Acceptance criteria
- [ ] Connect and disconnect work against the memory provider and the fake Google provider in `bun run dev`.
- [ ] Tokens never appear in responses, logs or error reports (scan test).
- [ ] A revoked grant sets `mailbox.auth_revoked` and the state `disconnected`.
- [ ] A Rep sees only their own Mailboxes; Admin sees all; second-Organization test passes.
- [ ] Gmail adapter passes recorded-fixture contract tests; live test opt-in.

### T4: Outlook Mailbox through Microsoft Graph
Repo: outbound
Blocked by: T3

## What to build
Connect, refresh, disconnect and send for Outlook through a Graph adapter behind the same port.

## Acceptance criteria
- [ ] The same port contract tests that Gmail passes pass for Graph.
- [ ] Timeouts and bounded jittered retries are tested; a 4xx limits, a 5xx retries.
- [ ] Tokens handled as in T3.

### T5: Send pipeline with checks, limits and rotation
Repo: outbound
Blocked by: T3, M03-T6, M05-T4

## What to build
The send function: window, verified address, core decision, Mailbox state and limits (day, hour, gap), Organization daily cap, idempotency, fair selection among permitted Mailboxes with thread stickiness, unsubscribe link and `List-Unsubscribe` headers, recording a send decision. Capacity route for launch checks.

## Acceptance criteria
- [ ] Each refusal (suppressed, no consent, unverified, outside window, limit, paused, duplicate) returns its named code and the transport saw no call.
- [ ] No configuration disables the core decision call (test over all settings).
- [ ] Crash after transport success but before recording reconciles with no second send.
- [ ] Selection never exceeds any Mailbox limit across 1,000 simulated sends.
- [ ] Second-Organization test passes.

### T6: Unsubscribe route and bounce, complaint and reply handling
Repo: outbound
Blocked by: T5, M03-T4, M09-T3

## What to build
The public signed-token unsubscribe route and one-click POST; ingestion of bounces, complaints, replies and out-of-office from Gmail and Graph by authenticated webhook with polling fallback; effects: suppress in core, stop the Enrollment, pause the Mailbox, hand replies to M09.

## Acceptance criteria
- [ ] Unsubscribe suppresses at once, identical response for known and unknown addresses, forged or expired token refused.
- [ ] Hard bounce suppresses and stops; soft bounce retries within a bound; complaint pauses the Mailbox and suppresses.
- [ ] Replayed notifications change nothing.
- [ ] A token for one Organization's Prospect cannot suppress in another.
- [ ] No message body in logs (scan test).

### T7: Health score, automatic limiting and ramp
Repo: outbound
Blocked by: T6

## What to build
Daily health computation with components and weights, `not_enough_data` below a minimum sample, automatic halving at warning and pause at critical, a published ramp for newly connected Mailboxes, owner and Admin notification, and `mailbox.state_changed`.

## Acceptance criteria
- [ ] Scripted event streams cross each threshold and the limits change accordingly.
- [ ] The ramp never lets a new Mailbox exceed its day-N cap.
- [ ] Notification is sent once per state change.
- [ ] Health is readable only by the owner, Managers of the Team and Admins.

### T8: Mailbox and send-log screens
Repo: portal
Blocked by: T5, T7

## What to build
Mailbox connections page (connect, disconnect, limits, ramp, health with reasons, domain check), send log per Campaign and Prospect with refusal reasons, state banners.

## Acceptance criteria
- [ ] A Rep connects a Mailbox against the fake provider and sees limits and health, via `agent-browser`.
- [ ] A paused Mailbox shows why and what to do.
- [ ] Limits cannot be set above the Organization ceiling in the UI or the API.
- [ ] Keyboard operable; tokens never shown.

### T9: Public unsubscribe page
Repo: portal
Blocked by: T6

## What to build
The unsubscribe confirmation page reached from the message link, in the brand style, with no sign-in, stating who sent the message and that the opt-out is done.

## Acceptance criteria
- [ ] Works with JavaScript disabled for the one-click path.
- [ ] Invalid and expired links show a calm message with no information about the address.
- [ ] Verified with `agent-browser` including the invalid-token case.
