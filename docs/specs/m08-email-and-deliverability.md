Phase: 4 · Repos: contract, db, outbound, portal (core's suppression API, M03, is called) · Parity rows: R4, R20, R29, R36, R46, R47, R48, R78 (R49 and R50 to R52 deliberately different or not pursued)

# M8 Email channel and deliverability

## Problem Statement

Cold and warm email outreach lives or dies on sender reputation. 11x runs managed domains and mailboxes, warms them for about two weeks, cycles through them and monitors health (R46 to R49), and its own blog says trouble starts at a few hundred sends a week and advises dedicated domains, so the customer carries much of the risk while seeing little of it. The Organization cannot inspect a mailbox's health, set its limits, or take its domain with it. Closeline sends nothing today: the mail port in the repositories is a Mailpit stand-in for sign-up emails. Sending campaign email on behalf of Reps needs real mailboxes, hard limits, immediate handling of bounces, complaints and unsubscribes, and a check against Contact Consent and suppression before every single send.

## Solution

Email goes out through **Mailboxes that Reps and Admins connect themselves**: Gmail and Outlook accounts authorised by OAuth, sending from the address the Prospect would expect (the Rep's own, or a shared address the Admin connects). There are no opaque managed domains. Every Mailbox has visible limits (per day, per hour, minimum gap between sends, send window), a visible **health score** with its reasons, and a state: `warming`, `healthy`, `limited`, `paused` or `disconnected`.

**Before every send** the pipeline checks, in order: the Campaign is running and in its window; the Prospect's address is verified (M5) or the Admin accepted unverified; core says the Prospect is not suppressed and has whatever consent the channel needs (M03, no setting overrides it); the Mailbox is usable and under its limits; the send has an idempotency key. A refusal is recorded with its reason and never retried blindly. Each message carries a one-click unsubscribe header and a visible unsubscribe link to a public page; opting out suppresses the address Organization-wide (and tells core, M03) immediately.

**After a send** the service watches the Mailbox for: bounces (hard bounce suppresses the address and stops the Sequence; soft bounce retries within bounds), spam complaints where the provider reports them, replies (handed to M09 and stop the Enrollment), and out-of-office (no stop; Sequence waits). Rates feed the **health score**. A bad score lowers limits automatically; a complaint spike or a provider suspension pauses the Mailbox and tells its owner and the Admin, with the reason.

**Warm-up without a warm-up network.** Reps' own mailboxes already have history, so Closeline does not simulate engagement. A newly connected Mailbox follows a published ramp (for example 10, 15, 25, 40 sends a day over weeks, capped by health) and says so on screen. Synthetic mailbox-to-mailbox warm-up is not built and is stated as a choice.

**Rotation** is fair selection among the connected Mailboxes a Campaign may use, within each one's limits; an Enrollment sticks to one Mailbox for its whole thread so replies and threading stay coherent.

Transport sits behind a port with a memory adapter (what tests and `bun run dev` use) and two real adapters: **Gmail API** first, then **Microsoft Graph** for Outlook.

## User Stories

1. As a Rep, I want to connect my Gmail account with a normal Google consent screen, so that messages go out from my own address.
2. As a Rep, I want to connect my Outlook account the same way, so that I can use the mailbox I have.
3. As an Admin, I want to connect a shared sending address and say which Teams may use it, so that a Team can send from one place.
4. As a Rep, I want to disconnect my Mailbox and have its tokens deleted, so that I stay in control of my account.
5. As an Admin, I want to see every connected Mailbox with its owner, state, limits and health, so that I can manage sending.
6. As an Admin, I want to set per-Mailbox limits (per day, per hour, gap, window), so that no one sends faster than is safe.
7. As a Rep, I want sensible default limits that I can lower but not raise above the Organization's ceiling, so that I cannot hurt my own reputation by accident.
8. As an Admin, I want a new Mailbox to ramp up its volume over weeks, so that sudden volume does not trigger spam filters.
9. As a Rep, I want to see a health score for my Mailbox with the reasons (bounce rate, complaints, replies, errors), so that I know what to fix.
10. As an Admin, I want a Mailbox with a bad score to be limited or paused automatically, with an email to its owner, so that damage stops early.
11. As a Rep, I want the system to tell me when my provider suspends or revokes access, so that I can reconnect.
12. As an Admin, I want every send to be refused when the Prospect is suppressed or lacks consent, so that we never message someone we must not.
13. As an Admin, I want no setting anywhere that turns the suppression check off, so that the rule cannot be removed by mistake.
14. As a Prospect, I want an unsubscribe link and a one-click unsubscribe that works at once, so that I stop hearing from the Organization.
15. As a Prospect, I want the unsubscribe page to confirm what happened without asking me to log in, so that opting out is easy.
16. As a Rep, I want a hard bounce to stop the Sequence and mark the address, so that I do not send to a dead address again.
17. As a Rep, I want a reply to stop the Sequence and appear in the inbox, so that the Agent never talks over a person.
18. As a Rep, I want an out-of-office to pause the Sequence until the stated return date, so that the message is read.
19. As an Admin, I want a complaint to pause the Mailbox and flag the Prospect as suppressed, so that one complaint is never ignored.
20. As a Manager, I want a view of bounces, complaints, replies and sends per Mailbox on my Team, so that I can coach on volume.
21. As an Admin, I want messages in a thread to keep going from the same Mailbox, so that replies look natural to the Prospect.
22. As an Admin, I want sends spread across my connected Mailboxes within their limits, so that no single Mailbox carries all the volume.
23. As an Admin, I want a daily cap across all Mailboxes of the Organization, so that total volume is bounded.
24. As a Rep, I want sent messages to appear in my own Sent folder, so that my mailbox shows what went out under my name.
25. As an Admin, I want to see the reason for every refused or deferred send, so that I can answer "why was this not sent".
26. As an Owner, I want an export of send and event history, so that I can leave with my data.
27. As an Admin, I want the domain's SPF, DKIM and DMARC state checked and explained for each connected domain, so that I fix setup problems before launch.
28. As a Prospect, I want the message to state who sent it and from which company, so that I know who is writing.

## Implementation Decisions

**Ownership.** Outbound owns Mailboxes, tokens, sends, mail events, health and limits. Core owns the suppression list and Contact Consent (M03): outbound calls core's decision endpoint before each send, and calls core's add-suppression endpoint on hard bounce, complaint or unsubscribe (and records it locally). Outbound owns the public unsubscribe route; core owns what an unsubscribe means for the Prospect. Replies are passed to M09 by event and API.

**Modules (outbound).** `mailbox` (connect, tokens, state, limits, ramp), `send` (the pre-send checks, selection, transport call, record), `mailevent` (bounce, complaint, reply, out-of-office, unsubscribe ingestion), `health` (score, automatic limiting), `domaincheck` (DNS checks for SPF, DKIM, DMARC through a DNS port).

**Ports and adapters.** `MailTransport` (send, fetch changes since a cursor, read bounce and complaint notices, watch for push; adapters memory, Gmail, Graph). `Dns` (memory, system resolver). Gmail uses restricted scopes; the Google verification and any security assessment are an Admin and process matter, tracked in Further Notes, not code. Every outbound call has a timeout and a bounded jittered retry; a 4xx revokes or limits, a 5xx retries.

**Tokens.** OAuth tokens are encrypted at rest with an envelope key from configuration, never logged or returned, rotated on refresh, and deleted on disconnect and on Organization deletion. Scopes are the minimum for send and read replies.

**Send idempotency.** The send key is (Enrollment, Step, attempt epoch). The transport call carries it where the provider allows; otherwise the send is recorded `sending` first, and recovery on restart reconciles against the provider's Sent folder by a header carrying the key. A send is never repeated when its state is unknown without that reconciliation.

**Health score.** A 0 to 100 score from a rolling 14-day window: hard bounce rate, complaint rate, soft bounce and error rate, reply rate, and provider warnings, each with a stated weight and threshold. Thresholds: above a warning level the daily limit is halved; above a critical level the Mailbox is paused. The score and its components are stored per day, shown to the owner, and open for the Admin to audit. Sample sizes below a minimum show "not enough data" rather than a score.

**Events ingestion.** Gmail push notifications and Graph change notifications are received on authenticated webhooks (signature verified, replay-limited) with a polling fallback by history cursor; processing is idempotent by provider message id. Message bodies are fetched only for replies, handed to M09, and never logged.

**Unsubscribe.** A signed, expiring token in the link and in the `List-Unsubscribe` header (one-click POST, RFC 8058); the public route is rate-limited, reveals nothing about whether an address exists, and works without a session.

**Contract areas** (`outbound`): `mailbox`, `send` (decision record), `mail-event`, `health`, `unsubscribe`, `domain-check`. Error codes: `mailbox.not_connected`, `mailbox.limit_reached`, `mailbox.paused`, `mailbox.auth_revoked`, `send.suppressed`, `send.no_consent`, `send.unverified_address`, `send.outside_window`, `send.duplicate`, `unsubscribe.invalid_token`. Events: `mailbox.state_changed`, `mail.bounced`, `mail.complained`, `mail.replied`, `mail.unsubscribed`.

**Schema (db, `outbound`).** `mailboxes` (encrypted token fields), `mailbox_limits`, `mail_messages` (send log with state, no body kept after delivery beyond the Draft held by M6), `mail_events`, `health_daily`. Row-level security on all; the public unsubscribe route resolves the Organization from the signed token and then uses the scoped helper.

**Portal.** Mailbox connections (connect, disconnect, limits, ramp, health with reasons, domain check), a send log per Campaign and Prospect, and the public unsubscribe page in the same editorial style.

## Testing Decisions

- Highest seam: outbound HTTP routes and the queue consumer with the memory `MailTransport` and a scripted consent/suppression client, on a real test Postgres, with an injected clock.
- Pre-send checks as external behaviour: for each of suppressed, no consent, unverified address, outside window, over the daily limit, paused Mailbox and duplicate key, the send route returns the named refusal and the transport saw no call.
- Idempotency and recovery: a transport call that succeeds but whose record fails is reconciled on restart without a second send.
- Events: a hard bounce suppresses the address in core and stops the Enrollment; a complaint pauses the Mailbox and suppresses; a reply creates an M09 thread and stops the Enrollment; out-of-office defers; replayed notifications change nothing.
- Health: scripted event streams move the score across the warning and critical thresholds and the limits change; below the minimum sample the score is `not_enough_data`.
- Unsubscribe: valid token suppresses at once, one-click POST works, a forged or expired token is refused, and the response is identical for known and unknown addresses.
- Isolation: a second Organization cannot see or use another's Mailboxes, tokens, sends or events; a token signed for one Organization's Prospect cannot suppress in another.
- Secrets: a log and error-report scan for tokens and message bodies after a full flow finds none.
- Adapters: Gmail and Graph contract tests against recorded fixtures; an opt-in live test with real test accounts.
- Prior art: auth's email verification and Mailpit smoke steps (`dev:smoke`), kit queue consumer and signature tests, playbook sweep tests.

## Out of Scope

- Managed or purchased domains and mailboxes, synthetic warm-up networks (R49), dedicated IPs.
- Phone number rotation and spam-flag detection for numbers (R50 to R52): a voice concern (M12).
- SMTP-only mailboxes and other providers (for example IMAP): later, behind the same port.
- Open and click tracking pixels: off and not built in this module; the sequence engine's branches use replies and time. An Admin setting may add them later with an ADR.
- Reply classification and the inbox (M9); calendar and booking (M10).
- Sending transactional mail for Closeline itself (auth and core keep their own mail port).

## Further Notes

**Proposed GLOSSARY terms.**
- **Mailbox**: an email account a Rep or Admin has connected so the Outbound Agent can send and read replies from it. _Avoid_: sender, inbox, email account, domain
- **Mailbox Health**: a 0 to 100 score with its reasons, derived from a Mailbox's recent bounces, complaints, replies and errors. _Avoid_: reputation, deliverability score
- **Suppression**: a recorded decision that an address must not be contacted by the Organization again (owned by M03). _Avoid_: blocklist, do-not-contact list, unsubscribe list

**ADRs needed.** (1) Email sending through connected Mailboxes instead of managed domains, including the warm-up choice and no tracking pixels by default. (2) Mailbox token encryption and key handling (shared with M5). (3) Gmail restricted-scope verification and Microsoft publisher verification as launch tasks, with owner and date. (4) Gmail and Graph as first adapters. None of these exists.

**11x rows reached.** R4 (verification before send, with M5), R20 (email), R29 (per-mailbox limits), R36 (instant unsubscribe, plus a suppression flag in core), R46 (ramp, adapted), R47 (rotation across connected Mailboxes), R48 (health with reasons, more open than 11x), R78 (Gmail and Outlook). Beyond: a published health score, visible limits, no lock-in to a domain, tokens deletable by the Rep.

**Open points.** The exact health thresholds and ramp numbers are starting values and are to be tuned against real sending; the PR must state them in the ADR.
