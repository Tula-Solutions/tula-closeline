# M2 Prospects and Accounts: tickets

Libraries first (T2, T3), then core slices that each end in something demoable through the HTTP
route, then the portal screens that sit on them.

### T1: Hub: terms Prospect Company and Source, and the provenance ADR
Repo: hub
Blocked by: none

## What to build
Add the glossary terms and a short decision record for the provenance and precedence rule (manual beats all, then most recent, per-field policy hook).

## Acceptance criteria
- [ ] `GLOSSARY.md` has **Prospect Company** and **Source** with `_Avoid_` lists, synced to every repo
- [ ] The ADR states the precedence rule, an example and the consequences for M4 and M5
- [ ] `bun run verify` is green in the hub

### T2: Contract: the `prospect` area
Repo: contract
Blocked by: M02-T1

## What to build
Schemas, routes, events and error codes for Prospects, Prospect Companies, provenance, merge, import jobs and row reports, with cursor pagination and idempotency keys. Tag a release.

## Acceptance criteria
- [ ] Every list takes a cursor and a maximum page size of 100
- [ ] Error codes are `area.reason` and listed; events use the envelope
- [ ] `dist/` rebuilt and committed; version bumped; tag named in the PR

### T3: Db: prospect tables with row-level security
Repo: db
Blocked by: T2

## What to build
The tables in the spec's schema section with `organization_id`, fail-closed row-level security, a unique constraint on normalised identity per Organization, and indexes for the list and identity lookup.

## Acceptance criteria
- [ ] Migration generated and applied on the harness; `db:check` green
- [ ] The harness proves a second Organization reads and writes nothing on each new table
- [ ] A duplicate normalised email in one Organization is refused; the same email in another is allowed
- [ ] Tag released

### T4: Core: create, read, update and list Prospects with provenance
Repo: core
Blocked by: T3

## What to build
Prospects and Prospect Companies can be created, edited, fetched and listed with a cursor. Every field stores its Source and time; a manual edit beats a later automatic one. Role visibility: Owner and Admin all, Manager their Team's Reps', Rep their own. Filters by owner, Source, company and a name/email search.

## Acceptance criteria
- [ ] Route tests for create (idempotent by key), update, get and paged list including the last page
- [ ] A manual value survives a later `import` write to the same field; a newer `import` replaces an older `import`
- [ ] A Rep cannot fetch another Rep's Prospect (404); a Manager sees Team Prospects only
- [ ] Second-Organization test: list, get and update all return nothing or 404
- [ ] `prospect.created` and `prospect.updated` are published once per change
- [ ] Benchmark for list and identity lookup at 100,000 rows with a budget

### T5: Portal: Prospects list, detail and create form
Repo: portal
Blocked by: T4

## What to build
A Prospects screen (search, filters, cursor paging), a detail page where each field shows its Source and time on demand (a ruled detail row, not a tooltip pile), a create/edit form, and notes and tags.

## Acceptance criteria
- [ ] Screen tests with a fake client for list, empty state, detail provenance and edit
- [ ] A Rep sees only their Prospects in `agent-browser` against the local stack
- [ ] Editorial style; no card grid, icon chips, dashed empty state or stat tiles
- [ ] Keyboard and screen-reader pass (axe) in both themes

### T6: Core: assign owners, bulk reassign
Repo: core
Blocked by: T4

## What to build
An Admin assigns or reassigns an owner Rep for one or many Prospects (bounded batch, queued beyond 500). The new owner must be a Rep or Manager in the same Organization.

## Acceptance criteria
- [ ] Route tests: single and bulk assign; an owner from another Organization is refused with `prospect.forbidden_owner`
- [ ] Visibility changes immediately for the old and new owner
- [ ] A bulk request retried with the same key changes nothing twice
- [ ] Second-Organization test

### T7: Core: CSV import with per-row report
Repo: core
Blocked by: T4

## What to build
Upload a CSV in the documented template; a queued job creates or updates Prospects (matching on normalised email), writes Source `import`, and produces a per-row report (created, updated, skipped, rejected with reason) that can be fetched and downloaded as CSV.

## Acceptance criteria
- [ ] Route tests: a file with good, duplicate-within-file and malformed rows produces the right report; none are silently dropped
- [ ] Uploading the same file again with the same key creates nothing new
- [ ] A job interrupted halfway resumes without duplicates
- [ ] Limits enforced: 10 MB, 50,000 rows; larger is refused with `prospect.import_invalid`
- [ ] Second-Organization test: another Organization cannot fetch the report

### T8: Portal: import flow
Repo: portal
Blocked by: T7, T5

## What to build
A three-step import: choose file (template download link), watch progress, read the report and download it. Safe to leave and return.

## Acceptance criteria
- [ ] Screen tests for success, partial failure and refused file
- [ ] Returning to the page mid-job shows the live status
- [ ] `/run-check` imports a CSV in `agent-browser` and finds the Prospects in the list

### T9: Core: duplicate suggestions, merge and undo
Repo: core
Blocked by: T4

## What to build
List suspected duplicates (matching normalised email, phone or LinkedIn), merge two Prospects choosing a value per field, keep both histories, and undo within thirty days.

## Acceptance criteria
- [ ] Route tests: suggestion list is paged and bounded; merge keeps the chosen values and the other's provenance as history
- [ ] Undo restores both records exactly; after thirty days undo returns `prospect.merge_conflict`
- [ ] `prospect.merged` is published; links to Deals move to the survivor
- [ ] Second-Organization test: cannot merge into or suggest across Organizations

### T10: Portal: duplicate review and merge
Repo: portal
Blocked by: T9, T5

## What to build
A review screen showing a suspected pair side by side with a per-field choice, a merge button and an undo notice.

## Acceptance criteria
- [ ] Screen tests for choose, merge, undo and conflict
- [ ] Keyboard-only merge works; axe passes

### T11: Core: erase a Prospect
Repo: core
Blocked by: T4, M03-T4

## What to build
An Admin erases a Prospect: fields, identities and notes are deleted, a salted-hash suppression entry is written, `prospect.erased` is published, and the Playbook drops its links. Runs as a queued job.

## Acceptance criteria
- [ ] Route test: after erasure the Prospect is 404, its identities are free to re-use only after explicit consent, and a suppression entry exists for the old email and phone
- [ ] The Playbook test consuming `prospect.erased` removes linked data and is idempotent on redelivery
- [ ] Only Owner and Admin may erase; a Rep gets 403
- [ ] Second-Organization test

### T12: Core: link Prospects to Deals
Repo: core
Blocked by: T4

## What to build
Record and list the Deals (by the Organization's identifier) linked to a Prospect, set manually or by CRM sync, and return them with Outcome read from the Playbook.

## Acceptance criteria
- [ ] Route tests for link, unlink, list; a Playbook failure returns the links with outcome unknown and a stated reason, not an error
- [ ] Every outbound call to the Playbook has a timeout and bounded jittered retry
- [ ] Second-Organization test
