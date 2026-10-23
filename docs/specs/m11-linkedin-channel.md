Phase: 5 · Repos: contract, db, outbound, portal, hub · Parity rows: R21

## Problem Statement

Customers expect LinkedIn as a step in outbound sequences. LinkedIn's terms forbid automated activity and the penalty, a restricted or closed account, lands on the Rep who owns it. ADR 0004 accepts that risk on conditions: each Rep connects their own account, an Admin accepts the risk in writing, closeline enforces low daily limits per account, and the channel can be switched off without touching other channels. None of this exists. Without it the Outbound Agent has no LinkedIn step, and building it carelessly would hide a legal risk from the people who carry it.

## Solution

The outbound service gets a LinkedIn channel behind a `LinkedInProvider` port (memory adapter for tests; first real adapter Unipile). A Rep connects their own LinkedIn account through the provider's hosted login, and sees its status. An Admin enables the channel only after recording a written risk acceptance against the current wording; revoking it, or an Admin switch, stops all LinkedIn sends at once and leaves email and other channels running. Every send passes a guard that checks suppression, the channel switch, the account status, and per-account daily and weekly limits reserved atomically in Postgres, with human-like timing and jitter. Connection requests, accepted-invitation signals and message replies flow back: replies enter the M9 inbox; an account the provider reports as restricted or needing a checkpoint is paused automatically and the Rep and Admin are told.

## User Stories

1. As a Rep, I want to connect my own LinkedIn account through a login I complete myself, so that no one else holds my password.
2. As a Rep, I want to see whether my account is connected, needs re-login, or is paused, so that I know why nothing is sending.
3. As a Rep, I want to disconnect my account at any time, so that I stay in control of it.
4. As a Rep, I want to be told before connecting that automated activity breaks LinkedIn's terms and my account can be restricted, so that I decide knowingly.
5. As an Admin, I want to be unable to connect an account on behalf of a Rep, so that every account belongs to its person.
6. As an Admin, I want to read the risk statement and accept it in writing with my name and the date before the channel can be used, so that the Organization has accepted the risk on record.
7. As an Admin, I want the risk acceptance to be tied to a specific wording version, so that a changed statement needs a new acceptance.
8. As an Owner, I want to see who accepted the risk and when, so that I can answer a question about it.
9. As an Admin, I want to disable the LinkedIn channel with one switch, so that I can stop it without affecting email.
10. As an Admin, I want revoking the acceptance to stop every LinkedIn send immediately, so that withdrawing consent really withdraws it.
11. As an Admin, I want to lower the daily connection and message limits for any account, so that I can be more careful than the default.
12. As an Admin, I want to be unable to raise limits above the system ceiling, so that no setting can exceed what ADR 0004 requires.
13. As a Rep, I want my connection requests and messages spread through working hours with random gaps, so that my account does not look automated.
14. As a Rep, I want the Agent to stop at my daily limit and continue the next day, so that I never exceed it.
15. As a Manager, I want to see today's usage against the limit for each Rep on my Team, so that I can plan campaigns.
16. As a Rep, I want a connection request to carry a short note only when the Campaign step says so, so that unwanted text is not sent.
17. As a Manager, I want LinkedIn steps (connect, then message after acceptance) to appear in the sequence builder only while the channel is enabled, so that I cannot schedule what cannot run.
18. As a Rep, I want a Prospect's LinkedIn reply to appear in my inbox as a Conversation, so that I answer it with the rest.
19. As a Rep, I want an accepted connection request to start the follow-up step, so that sequences continue automatically.
20. As a Prospect, I want a "stop" reply on LinkedIn to end all LinkedIn contact immediately, so that I am left alone.
21. As an Admin, I want a Prospect on the suppression list never to receive a LinkedIn request or message, so that opt-outs hold across channels.
22. As a Rep, I want my account paused automatically when LinkedIn flags a restriction or checkpoint, so that I do not make it worse.
23. As an Admin, I want a notice when any account is paused or the provider is unavailable, so that I can respond.
24. As an Admin, I want a provider outage to pause only LinkedIn, so that email and chat campaigns continue.
25. As an Admin, I want every LinkedIn send, acceptance, pause and setting change recorded, so that I can review it later.
26. As an Admin, I want to remove a Rep's account connection when the Rep leaves the Organization, so that nothing sends in their name.
27. As a Rep, I want a failed send never to be retried into a duplicate request, so that Prospects do not receive two.

## Implementation Decisions

**Ownership.** The `outbound` service (created by M07) owns the LinkedIn channel, its accounts, limits and risk acceptances, as ADR 0004 and the brief place it there. Core's inbox (M9) receives replies. No change to core except one audit event type.

**Port.** `LinkedInProvider`: start hosted connection for a Rep, read account status, send a connection request (with optional note), send a message, and parse a verified webhook into typed events (message received, invitation accepted, account status changed). It reports provider errors as typed results (rate limited, restricted, checkpoint, invalid recipient). Memory adapter scripts those results. First adapter: Unipile, chosen for hosted login, webhooks and per-account pricing. This needs a new ADR (provider choice, cost, data location, exit plan); ADR 0004 stays the policy.

**Account model.** `linkedin_accounts`: id, Organization, Membership of the Rep who connected it (unique per Rep), provider account reference, status (connected, needs_login, paused, restricted, disconnected), limits and pause reason. Provider credentials never reach closeline; only a reference is stored, and nothing about it is logged.

**Risk acceptance.** `linkedin_risk_acceptances`: Organization, wording version, accepting Admin Membership, typed full name, time, and revoked time. The channel is enabled iff the Organization has a non-revoked acceptance for the current wording version and the Admin switch is on. The wording is a versioned constant in the contract so portal and service agree.

**Limits and send guard.** The ceiling is a system constant: 20 connection requests and 40 messages per account per day, 80 requests per week (conservative starting values, recorded in the ADR and confirmed against the provider's guidance before release). An Organization can only lower them. A send first reserves quota with an atomic counter row in Postgres keyed by account and day; the reservation and the send are one idempotent job keyed by sequence step id, so a retry never doubles a request. Sends are scheduled inside the Rep's working hours with random gaps of several minutes. The guard order is fixed: channel enabled, account connected, M03 suppression, quota, then send. A restricted or checkpoint result pauses the account and notifies, never retries.

**Replies and events.** The webhook route verifies the provider signature in constant time, dedupes by provider event id, and posts replies to the inbox ingest route (M9). Events published: `linkedin.invitation_accepted`, `linkedin.account_paused`, `linkedin.channel_disabled`. M07 consumes acceptance to advance a sequence and hides LinkedIn step types while disabled.

**Contract areas.** New `linkedin` area under the outbound routes: accounts, risk statement and acceptance, settings, usage. Errors: `linkedin.channel_disabled`, `linkedin.risk_not_accepted`, `linkedin.account_not_connected`, `linkedin.limit_reached`, `linkedin.not_account_owner`, `linkedin.limit_above_ceiling`.

**Schema (db, outbound schema).** `linkedin_accounts`, `linkedin_risk_acceptances`, `linkedin_channel_settings`, `linkedin_usage` (account, day, requests, messages). Tenant tables with fail-closed row-level security.

**Security.** Webhook secret in the secret store; message text and recipient profile data never logged; provider responses are untrusted data.

## Testing Decisions

Highest seam: outbound HTTP routes and the send job with the memory provider and the fixed clock. Behaviours: the channel refuses sends before acceptance, after revocation and while switched off; the 21st connection request in a day is deferred to the next day; two concurrent senders cannot exceed the quota; a retried job sends once; a suppressed Prospect is skipped; a restricted result pauses only that account; a Rep cannot connect or disconnect another Rep's account; an Admin cannot raise limits past the ceiling; a forged webhook is rejected and a replayed one is a no-op. Cross-Organization test: a second Organization cannot see, connect, enable or send through the first one's accounts, acceptance or usage, and cannot spend its quota. Prior art: the kit queue behaviour suite, core's idempotency-key tests, the playbook vendor-sends tests. The Unipile adapter runs the same suite as the memory adapter, with a gated live test. Portal checked with agent-browser.

## Out of Scope

Profile views, post likes and comments, InMail credits, group messaging, scraping or enrichment from LinkedIn (M5), Sales Navigator search, voice or video notes, multiple accounts per Rep, our own browser automation (rejected in ADR 0004), and any attempt to evade LinkedIn detection beyond pacing.

## Further Notes

New GLOSSARY terms proposed:

- **LinkedIn account**: a Rep's own LinkedIn profile, connected to Closeline so an Outbound Agent can send for them. _Avoid_: LinkedIn seat, LinkedIn bot.
- **Risk acceptance**: an Admin's written record that the Organization accepts the chance of LinkedIn restricting its Reps' accounts. _Avoid_: Consent (reserved for Contact Consent), waiver.

ADRs needed: LinkedIn provider selection (Unipile proposal; none exists); ADR 0004 is the policy and is not contradicted. Open: whether the daily ceilings need legal review; whether LinkedIn needs a Contact Consent record (ADR 0003 covers phone, SMS and WhatsApp only, so this spec relies on suppression, not consent). Reaches parity on R21 with a stricter safety posture.
