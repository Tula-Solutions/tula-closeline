Phase: 1 (HubSpot, issue #17 is the first slice) and 2 (Salesforce) · Repos: hub, contract, db, core, portal · Parity rows: R42 (Salesforce), R43 (HubSpot), R36 (CRM flag on unsubscribe); R44 and R45 (Pipedrive, Zoho, Dynamics) not pursued yet

# M4 CRM sync

## Problem Statement

An Organization's sales history lives in its CRM. Today the Playbook takes Deals only from a CSV and Calls only by upload. Hub issue #17 ("1.16 HubSpot connection") asks for OAuth and an incremental pull of Deals and call records into the same ingestion path, but it is one ticket and only the pull. Parity (R42, R43) means a connection an Admin can set up alone, in both directions, with clear status and errors. The twist: Deals and Outcomes flow into the Playbook automatically, so the CRM teaches the Agents without anyone exporting a file.

## Solution

Core owns a **CRM connection** per Organization, behind a `CrmProvider` port with HubSpot as the first adapter and Salesforce the second. A connection syncs in four directions of data:

1. **Deals and Outcomes** (HubSpot deal stage to won, lost or open, by an Admin-confirmed stage mapping) into the Playbook's existing Deal import path (ADR 0018).
2. **Calls** logged in the CRM, with a recording or transcript where the provider exposes one, into the Playbook's Call ingestion.
3. **Companies and contacts** into Prospect Companies and Prospects (M2) with Source `crm:hubspot` and field provenance. CRM opt-outs become Suppression (M3); CRM "consented" flags never become a Contact Consent without recorded evidence.
4. **Write-back** of Closeline activity (notes for Calls and Agent messages, Outcome changes, Prospect edits) to the CRM, per field and per direction, with loop prevention.

Sync is incremental, queued, idempotent, rate-limit aware, and visible: a run history with counts and errors an Admin can retry. Issue #17 is delivered as tickets T4 to T7 here.

## User Stories

1. As an Admin, I want to connect HubSpot with a standard sign-in screen, so that I need no developer.
2. As an Admin, I want to see that the connection is healthy, when it last synced and what it synced, so that I trust it.
3. As an Admin, I want to disconnect HubSpot and have its tokens deleted, so that access ends when I say so.
4. As an Admin, I want to choose which HubSpot deal stages count as won and lost, so that Outcomes are right for my pipeline.
5. As an Admin, I want won and lost Deals pulled into the Playbook without exporting a CSV, so that search learns from them automatically.
6. As an Admin, I want only new and changed records pulled after the first load, so that sync is fast and cheap.
7. As an Admin, I want a large first load to run in the background and show progress, so that I can leave the page.
8. As an Admin, I want a failed run to tell me why and offer a retry, so that I can fix it.
9. As an Admin, I want an expired or revoked authorisation to be shown as "needs reconnecting", not as silence, so that sync does not quietly stop.
10. As an Admin, I want HubSpot calls with recordings or transcripts to arrive as Calls linked to their Deal, so that Moments are built from them.
11. As an Admin, I want a call without a usable recording or transcript to be listed as skipped with a reason, so that I know what is missing.
12. As an Admin, I want the rights confirmation for Recordings and Transcripts (ADR 0018) required before calls are pulled, so that the Organization has agreed it may share them.
13. As a Rep, I want my HubSpot contacts to appear as Prospects I own, so that I need not retype them.
14. As a Rep, I want a field I edited in Closeline to survive a later sync according to the provenance rule, so that my correction stays.
15. As an Admin, I want a HubSpot unsubscribe to suppress that person here, so that we never contact someone who opted out there.
16. As an Admin, I want a HubSpot "marketing consent" flag to be shown as information only, not as Contact Consent, so that a checkbox is never taken as proof.
17. As an Admin, I want to choose, per field, whether Closeline writes back, reads only, or both, so that I control what changes in my CRM.
18. As a Rep, I want my Call summaries and Agent messages logged to the contact in HubSpot, so that the CRM shows the full history.
19. As an Admin, I want an Outcome I correct in Closeline to update the HubSpot Deal when I allow it, so that the two agree.
20. As an Admin, I want sync not to bounce changes back and forth, so that records are not rewritten forever.
21. As an Admin, I want near-real-time updates when HubSpot sends a change, with a periodic sweep as backup, so that nothing is missed.
22. As an Admin, I want Salesforce to be connectable the same way later, so that my CRM does not decide whether I can use Closeline.
23. As an Owner, I want each Organization's CRM data, tokens and mappings isolated, so that no other Organization can see them.
24. As an Admin, I want tokens stored encrypted and never shown or logged, so that a leak of a table does not leak access.
25. As an Admin, I want sync to respect HubSpot's rate limits and to back off without losing work, so that my CRM is not throttled for other tools.
26. As an Admin, I want the first sync to start with a preview of counts, so that I know what will be imported before it runs.
27. As an Admin, I want a Deal deleted in the CRM to be marked unlinked here, not silently removed from the Playbook, so that history is preserved by choice.
28. As a Manager, I want to see the connection status without being able to change it, so that I know when data is stale.
29. As a developer, I want a fake HubSpot in local development, so that `dev:smoke` proves the whole path without credentials.
30. As an Admin, I want to see a sync run's counts of created, updated, skipped and failed records, so that I can verify it.

## Implementation Decisions

- **Core owns** a `crm` module: connection, run history, field and stage mapping, external-reference map. The Playbook keeps Deals and Calls; core calls the Playbook's existing internal ingestion routes over HTTP typed by the contract, with a timeout and bounded jittered retry, passing an idempotency key derived from provider, object and version.
- **Ports**: `CrmProvider` (authorise, exchange and refresh tokens, list changed objects since a cursor, get by id, write, verify webhook) with a **memory adapter** (used by tests and local dev) and a **HubSpot adapter** first; **Salesforce adapter** second, passing the same behaviour suite. `SecretBox` (encrypt and decrypt tokens) with a local-key adapter and a memory adapter; the AWS key-management adapter arrives with infra.
- **Contract area `crm`**: connection, status, stage mapping, field direction settings, sync run, webhook payload shapes. Codes: `crm.not_connected`, `crm.authorisation_failed`, `crm.needs_reconnect`, `crm.rate_limited`, `crm.mapping_incomplete`, `crm.rights_not_confirmed`.
- **Schema (db library, core schema)**: `crm_connection` (provider, status, encrypted tokens, scopes, external account id), `crm_mapping` (stage mapping, per-field direction), `crm_sync_run` (kind, state, counts, cursor, errors), `crm_external_ref` (provider object id to Closeline id, last seen version), `crm_webhook_receipt` (idempotency). One connection per provider per Organization.
- **Sync flow**: a queued job per object kind pulls pages (bounded size) after a stored cursor, maps, writes through the owning service (Prospect service for Prospects, Playbook ingestion for Deals and Calls), then advances the cursor only after commit. Redelivery is harmless.
- **OAuth**: authorisation-code flow with a signed, expiring `state` bound to the Admin and Organization; redirect to the portal after callback; scopes are the minimum read set first and write scopes requested only when write-back is switched on.
- **Webhooks**: a public route with signature verification and replay protection; it only enqueues a targeted pull. A periodic sweep covers misses.
- **Conflict and loops**: provenance rule from M2 decides precedence; each write-back records the provider's version so the echo is recognised and dropped.
- **Events**: `crm.connected`, `crm.disconnected`, `crm.run_completed` for the portal and later analytics.
- **Portal**: Integrations screen with Connect, status, stage mapping, direction settings, run history with retry. Owner/Admin may change; Manager may view.
- **Local dev**: a fake HubSpot (loopback only, like the fake Google provider) in the dev stack so `dev:smoke` can connect, sync a Deal, and see it in Playbook search.
- **Rate limiting**: honour provider limit headers and Retry-After; a per-connection concurrency limit so one Organization cannot starve others.

## Testing Decisions

- Behaviour suite for `CrmProvider` run against the memory adapter and, with recorded fixtures, the HubSpot adapter; the Salesforce adapter later passes the same suite. No live calls in CI.
- Highest seam: core HTTP routes (connect callback, status, mapping, trigger sync) plus the queue consumer driven with the memory queue; assertions on what reaches the Playbook's route (a fake Playbook client) and on Prospects created.
- Failure paths first: revoked token marks `needs_reconnect`; 429 backs off and resumes; a poison record is reported and does not stop the run; webhook with a bad signature or replay does nothing.
- Idempotency: re-running the same page creates no duplicates; cursor advances only after commit.
- Cross-Organization isolation: one Organization cannot read, change or trigger another's connection, runs or mappings; a webhook for one Organization's account never touches another; the OAuth `state` from one cannot be used by another.
- Security: tokens never appear in responses or logs (test scans); stored value is not the plain token.
- Prior art: the Invitation mailer outbox tests, the Google sign-in tests with the fake provider, the Playbook deal-import tests. `dev:smoke` gains a CRM step; `/run-check` connects the fake HubSpot in `agent-browser`.

## Out of Scope

- Pipedrive, Zoho, Dynamics and LeadSquared (R44, R45), until asked for.
- Real-time Closeline-to-CRM streaming beyond the near-real-time webhook pull and queued write-back.
- Custom objects, custom pipelines beyond stage mapping, and CRM-side Closeline apps or cards.
- Enrichment from the CRM's data marketplace (M5).
- Billing for sync volume (metering is phase 5).

## Further Notes

- **Proposed GLOSSARY terms.**
  - **CRM connection**: an Organization's authorised link to one external customer-relationship system, from which Closeline reads and to which it can write. _Avoid_: integration (generic), sync account, plug-in.
  - **Stage mapping**: an Admin's rule saying which CRM deal stages mean won, lost or open. _Avoid_: pipeline mapping, status mapping.
- **ADR needed (M04-T1):** token storage and the `SecretBox` port, the conflict and loop policy, webhooks plus sweep, and "CRM consent flags are information, not Contact Consent".
- **Issue #17.** It stays open as the first slice: tickets T4 (port and connection), T5 (HubSpot OAuth) and T6 and T7 (pull Deals and Calls) satisfy its text. The lead should re-title it or split it; this spec does not create issues.
- **Parity:** R42 and R43 with the stage mapping, rights check and loop prevention; R36 via CRM opt-out to Suppression.
- Open question: whether HubSpot recordings are reachable through the public API for all plans; the ticket verifies against a developer account and reports.
