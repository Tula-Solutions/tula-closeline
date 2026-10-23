# M4 CRM sync: tickets

T4 to T7 are hub issue #17 (HubSpot connection) cut into slices. T9 onward wait on M2 and M3.
The Salesforce tickets (T13, T14) are phase 2.

### T1: Hub: ADR for CRM sync and glossary terms
Repo: hub
Blocked by: none

## What to build
A decision record covering the `CrmProvider` port, token storage and `SecretBox`, conflict and loop policy, webhooks with a sweep, and that CRM consent flags are information only. Glossary terms CRM connection and Stage mapping.

## Acceptance criteria
- [ ] ADR written with considered options and consequences; builds on ADR 0003, 0007, 0013, 0018
- [ ] Glossary terms added and synced; `bun run verify` green

### T2: Contract: the `crm` area
Repo: contract
Blocked by: M04-T1

## What to build
Connection, status, stage mapping, field direction, sync run, webhook shapes and `crm.*` codes. Tag a release.

## Acceptance criteria
- [ ] Lists have cursors and page maximums; codes are `area.reason`
- [ ] `dist/` rebuilt, version bumped, tag named

### T3: Db: CRM tables
Repo: db
Blocked by: T2

## What to build
`crm_connection`, `crm_mapping`, `crm_sync_run`, `crm_external_ref`, `crm_webhook_receipt` in the core schema with row-level security and uniqueness of one connection per provider per Organization.

## Acceptance criteria
- [ ] Migration applies; `db:check` green
- [ ] A second Organization reads and writes nothing in any table
- [ ] A second HubSpot connection in one Organization is refused
- [ ] Tag released

### T4: Core: `CrmProvider` and `SecretBox` ports, connection routes, memory adapters
Repo: core
Blocked by: T3

## What to build
The ports with memory adapters and a shared behaviour suite; routes to read connection status and to disconnect (deleting stored tokens); the Integrations status shape. No real provider yet. (Issue #17, slice 1.)

## Acceptance criteria
- [ ] Route tests: status is `not_connected` by default; connecting with the memory provider shows `connected`; disconnect deletes tokens
- [ ] Stored tokens are encrypted through `SecretBox` and never returned or logged (test scans responses and logs)
- [ ] Only Owner and Admin may connect or disconnect; Manager may read status
- [ ] Second-Organization test

### T5: Core: HubSpot adapter and OAuth connection
Repo: core
Blocked by: T4

## What to build
An Admin starts the HubSpot authorisation, returns through a callback with a signed `state`, and ends connected; tokens refresh before expiry; revocation shows `needs_reconnect`. (Issue #17, slice 2.)

## Acceptance criteria
- [ ] Callback tests with fixtures: success, denied consent, tampered or expired `state`, state from another Organization
- [ ] Refresh with bounded jittered retry; a revoked token sets `crm.needs_reconnect`
- [ ] All provider calls have timeouts and honour rate-limit headers
- [ ] Adapter passes the `CrmProvider` behaviour suite on recorded fixtures

### T6: Core: pull Deals and Outcomes into the Playbook, incrementally
Repo: core
Blocked by: T5

## What to build
After the Admin confirms a stage mapping, a queued sync pulls HubSpot deals (first load, then changes since the cursor) and sends them to the Playbook's deal import path as won, lost or open. Counts and errors appear in the run history. (Issue #17, slice 3.)

## Acceptance criteria
- [ ] Route and consumer tests: mapped stages become the right Outcomes; an unmapped stage returns `crm.mapping_incomplete` before syncing
- [ ] A rerun of the same page creates nothing new; the cursor advances only after commit
- [ ] A poison record is reported in the run and does not stop it; 429 backs off and resumes
- [ ] Preview endpoint returns counts without writing
- [ ] Second-Organization test: another Organization cannot trigger or read the run, and its Deals are never mixed

### T7: Core: pull call records into Playbook Call ingestion
Repo: core
Blocked by: T6

## What to build
HubSpot calls linked to a pulled Deal are sent to Playbook Call ingestion with the recording or transcript where available; others are listed as skipped with a reason. Refused until the Organization's rights confirmation exists. (Issue #17, slice 4.)

## Acceptance criteria
- [ ] Without the confirmation: `crm.rights_not_confirmed`, nothing fetched
- [ ] Tests for call with transcript, with recording only, with neither (skipped with reason)
- [ ] Large recordings are streamed, never held whole in memory
- [ ] Second-Organization test

### T8: Portal: Integrations screen for HubSpot
Repo: portal
Blocked by: T6

## What to build
Connect, status with last sync and next step, stage mapping editor, preview counts, run history with retry, disconnect. Manager views read-only. Editorial style.

## Acceptance criteria
- [ ] Screen tests: not connected, connected, needs reconnecting, mapping incomplete, running, failed with retry
- [ ] `/run-check` against the fake HubSpot: connect, map, sync, find the Deal in Playbook search
- [ ] No card grid, icon chip, dashed empty state or stat tiles; axe passes

### T9: Hub: fake HubSpot in the local stack and `dev:smoke`
Repo: hub
Blocked by: T6

## What to build
A loopback-only fake HubSpot started by `bun run dev`, with seeded deals, contacts and calls, and a smoke step that connects, syncs and searches.

## Acceptance criteria
- [ ] `bun run dev:smoke --strict` passes the CRM step; `--down` stops the fake
- [ ] The fake listens on loopback only, documented in `docs/local-development.md`

### T10: Core: pull companies and contacts as Prospect Companies and Prospects
Repo: core
Blocked by: T6, M02-T4

## What to build
Companies and contacts sync into Prospect Companies and Prospects with Source `crm:hubspot`, owner matched by email to a Rep where possible, and provenance honoured on every field.

## Acceptance criteria
- [ ] A manual edit survives the next sync; a CRM change replaces an older CRM value
- [ ] Unmatched owner leaves the Prospect unassigned and reports it
- [ ] A contact already present by normalised email is updated, not duplicated
- [ ] Second-Organization test

### T11: Core: CRM opt-outs become Suppression
Repo: core
Blocked by: T10, M03-T4

## What to build
A HubSpot unsubscribe or opt-out flag adds a Suppression entry (reason `crm`); a consent flag is stored as information on the Prospect and never grants Contact Consent.

## Acceptance criteria
- [ ] After sync the Contact Check denies the opted-out address on every channel
- [ ] A "consented" flag leaves `consent.missing` for agent-initiated phone and SMS
- [ ] Re-sync is idempotent; second-Organization test

### T12: Core: HubSpot webhooks with a periodic sweep
Repo: core
Blocked by: T6

## What to build
A signed webhook route that enqueues a targeted pull, plus a scheduled sweep for misses.

## Acceptance criteria
- [ ] Bad signature, stale timestamp and replayed receipt do nothing and are logged without payload
- [ ] A webhook for an unknown account is ignored; one for Organization A never triggers B
- [ ] A missed webhook is caught by the sweep in a test with the fake clock

### T13: Core: write-back with per-field direction and loop prevention
Repo: core
Blocked by: T10

## What to build
Admin chooses read, write or both per field; Closeline notes for Calls and Agent messages, Outcome changes and Prospect edits are written to HubSpot; echoes of our own writes are recognised and dropped. Write scopes are requested only when switched on.

## Acceptance criteria
- [ ] A field set to read-only is never written; a write is not echoed back as a change
- [ ] Outbound writes are idempotent by key and bounded-retried; a failed write is shown in the run history
- [ ] Switching write-back on without write scopes returns `crm.needs_reconnect`
- [ ] Second-Organization test

### T14: Core: Salesforce adapter (connect and pull Deals)
Repo: core
Blocked by: T6

## What to build
Salesforce OAuth and an incremental pull of Opportunities mapped to Deals, on the same port and the same stage-mapping screen.

## Acceptance criteria
- [ ] The adapter passes the `CrmProvider` behaviour suite on fixtures
- [ ] First load of a large Organization uses a bulk path and runs in the background; ordinary changes use incremental queries
- [ ] Second-Organization test; revoked authorisation shows `needs_reconnect`

### T15: Core: Salesforce companies, contacts and write-back
Repo: core
Blocked by: T14, T10, T13

## What to build
Salesforce Accounts and Contacts into Prospect Companies and Prospects, and write-back on the same per-field rules.

## Acceptance criteria
- [ ] Same provenance, opt-out and loop-prevention tests as HubSpot pass for Salesforce
- [ ] Second-Organization test
