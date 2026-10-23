# M16 Agent controls, audit and openness: tickets

### T1: Contract: agent, audit, export and apikey areas
Repo: contract
Blocked by: none

## What to build
Schemas, routes and error codes for instruction versions, agent settings (levels, windows, escalation), audit events, export jobs and API keys; events `audit.recorded`, `export.requested`, `export.part_ready`; a `public` route marker and scope names. Tag a release.

## Acceptance criteria
- [ ] Error codes `agent.version_not_found`, `agent.instruction_too_long`, `audit.range_too_large`, `export.already_running`, `apikey.scope_not_allowed`, `apikey.revoked`
- [ ] Control levels and actor kinds are closed enums; audit metadata schema forbids free text fields named body or text
- [ ] Lists use cursor pagination with a maximum page size
- [ ] `dist/` rebuilt and committed

### T2: Database: instructions, settings, audit, exports, keys
Repo: db
Blocked by: T1

## What to build
Core tables `agent_instruction_versions`, `agent_instruction_pointer`, `agent_settings`, `audit_events`, `export_jobs`, `export_parts`, `api_keys`, `api_key_usage`. Tag a release.

## Acceptance criteria
- [ ] Row-level security harness passes on every table
- [ ] The core service role has insert and select only on `audit_events` and `agent_instruction_versions` (catalog check)
- [ ] Per-Organization audit sequence is unique; key hashes unique
- [ ] The existing auth `api_keys` and `audit_logs` are untouched

### T3: Kit: audit recorder port
Repo: kit
Blocked by: none

## What to build
An `AuditRecorder` port with a memory adapter and a queue adapter publishing `audit.recorded`, which accepts only ids, labels and an action code. Tag a release.

## Acceptance criteria
- [ ] Recording is idempotent per event id and bounded in size
- [ ] A property test shows metadata containing a string over 200 characters or a key named body is rejected
- [ ] One behaviour suite runs against both adapters

### T4: Kit: token actor, scopes and requireScope
Repo: kit
Blocked by: none

## What to build
Token verification exposes `actor` (member or api_key) and `scopes`; a `requireScope` guard; member tokens keep working unchanged. Tag a release.

## Acceptance criteria
- [ ] A token with actor api_key and no matching scope is refused with the contract's code
- [ ] Existing member-token tests pass unmodified
- [ ] An api_key token never yields a Membership role

### T5: Core: audit log write, verify and read
Repo: core
Blocked by: T2, T3

## What to build
An idempotent consumer for `audit.recorded`, direct audit writes for core's own actions, hash chaining per Organization, a verify route, and a filtered, cursor-paged read with CSV. Admin and Owner read all; Manager reads their Team's Prospects.

## Acceptance criteria
- [ ] Rows cannot be updated or deleted (database test); a tampered row makes verify report the break
- [ ] Replaying an event writes one row
- [ ] A second Organization cannot read or verify the first one's log
- [ ] A Rep gets a role error; filters by actor, action, subject and range work; ranges over the cap return `audit.range_too_large`

### T6: Core: versioned Agent instructions
Repo: core
Blocked by: T5

## What to build
Save a draft version, publish, roll back, list and diff versions, per Agent kind; an internal read of the published text and number for Agent services. Changes are audited.

## Acceptance criteria
- [ ] Saving never changes an earlier version; rollback re-points and creates an audit event
- [ ] Text over 20,000 characters returns `agent.instruction_too_long`
- [ ] Only Admin and Owner write; Manager and Rep read published text
- [ ] A fixture instruction contradicting disclosure or consent has no effect on the fixed-rule layer (test through the M9 writer with the memory adapter)
- [ ] A second Organization cannot read or publish

### T7: Core: control levels, send windows and pause
Repo: core
Blocked by: T6, M09-T8

## What to build
Per Agent and channel settings: level preset (Supervised, Assisted, Autonomous) that writes the M9 approval policy, send windows by weekday and time zone, escalation rules, and an Organization-wide `agents_paused` switch checked by senders.

## Acceptance criteria
- [ ] At Autonomous, an ungrounded Draft, a failed assessment and a first message are still held
- [ ] Pausing stops release of Drafts at once and is audited
- [ ] A send outside the window is deferred, not dropped
- [ ] Changing a level writes one audit event with before and after
- [ ] A second Organization's settings are unaffected

### T8: Core: API keys
Repo: core
Blocked by: T5

## What to build
Create (secret shown once, SHA-256 stored), list, revoke, and an internal verify route returning Organization, scopes and role ceiling. Per-key usage counters in Postgres with a rate limit.

## Acceptance criteria
- [ ] The secret is unretrievable after creation and absent from logs and the audit log
- [ ] A scope request above the creating Admin's role returns `apikey.scope_not_allowed`
- [ ] Revoked and expired keys verify as `apikey.revoked`
- [ ] Constant-time comparison of hashes; a second Organization cannot list or revoke keys

### T9: Auth: exchange an API key for a token
Repo: auth
Blocked by: T4, T8, T12

## What to build
`POST /v1/token`: verify the key with core over the internal call, mint a 10-minute token with actor api_key, Organization and scopes, no Membership. Timeout and bounded, jittered retry on the core call.

## Acceptance criteria
- [ ] A valid key yields a token that core accepts only on routes of its scopes
- [ ] A revoked key is refused; the refusal reveals nothing about which keys exist
- [ ] Failed attempts are counted per source in Postgres, not memory
- [ ] The dev smoke gains a key exchange and call

### T10: Core: Organization data export
Repo: core
Blocked by: T5, T3

## What to build
Create, status and download for exports: one running per Organization, two a day, parts from each service, a manifest, 24-hour download link; core contributes its own slice. Audited.

## Acceptance criteria
- [ ] No credential, token hash, key hash or other Organization's row appears (test over a seeded pair of Organizations)
- [ ] A failed part marks the export failed with a reason code and can be retried
- [ ] The job is queued and idempotent; a second request while running returns `export.already_running`
- [ ] The download link expires and is audited

### T11: Playbook: export slice
Repo: playbook
Blocked by: T10

## What to build
Consume `export.requested`, write Documents (originals and metadata), Transcripts, Deals, Outcomes and Moments as newline-delimited JSON plus files, optionally with Recording links, then publish `export.part_ready`.

## Acceptance criteria
- [ ] Output streams in bounded chunks; memory use is independent of Organization size
- [ ] Only the requesting Organization's data is written; a second Organization's data is absent
- [ ] Redelivery of the request writes the same part once

### T12: Hub: public OpenAPI build and API-key decision record
Repo: hub
Blocked by: T1

## What to build
An ADR for exchanging keys for short-lived tokens (extends ADR 0005), audit retention and export format; a script merging routes marked public from each service's OpenAPI into `public-openapi.json` with `/v1` paths; a CI check that fails on an unmarked route in the document.

## Acceptance criteria
- [ ] The ADRs are written and `bun run verify` is green
- [ ] The merge is deterministic; a route lacking a scope is rejected
- [ ] Running it with core only produces a valid OpenAPI 3.1 file

### T13: Portal: instructions and control levels
Repo: portal
Blocked by: T6, T7

## What to build
An Agent screen: instruction editor with versions, diff, publish and rollback; the fixed-rules banner; control level picker with plain-words explanations, channel overrides, send windows, escalation rules and the pause-all switch.

## Acceptance criteria
- [ ] Rep and Manager cannot open the editor; Manager can read published text
- [ ] Rollback and pause show effect and confirmation, and appear in the audit log
- [ ] agent-browser run on the local stack

### T14: Portal: audit log and data export
Repo: portal
Blocked by: T5, T10

## What to build
An Audit screen with filters, verify status and CSV; an Export screen to request, watch and download an export.

## Acceptance criteria
- [ ] Filters and cursor paging work on seeded data; no Message text appears
- [ ] Export states (running, failed with reason, ready, expired) are designed
- [ ] agent-browser run; Rep sees neither screen

### T15: Portal: API keys and developer page
Repo: portal
Blocked by: T8, T12

## What to build
A Keys screen (create with scopes and expiry, show-once secret dialog, last used, revoke) and a developer page rendering the public OpenAPI with a short "get a token" guide.

## Acceptance criteria
- [ ] The secret appears once and cannot be shown again
- [ ] The page renders the merged document without calling any private route
- [ ] Only Admin and Owner see the Keys screen; agent-browser run
