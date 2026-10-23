# M3 Contact Consent and suppression: tickets

The check path (T1 to T6) is the core of the module and unblocks voice and outbound. Capture
surfaces (T7 to T11) follow.

### T1: Hub: ADR for the consent ledger and terms
Repo: hub
Blocked by: none

## What to build
A decision record for the ledger, Suppression scope, the fail-closed Contact Check and evidence retention (builds on ADR 0003 and 0007); glossary terms Suppression, Contact Check, Consent Wording.

## Acceptance criteria
- [ ] ADR states scope, purposes, denial codes, retention and what no setting can change
- [ ] Glossary terms added with `_Avoid_` lists and synced
- [ ] `bun run verify` green in the hub

### T2: Contract: the `consent` area
Repo: contract
Blocked by: M03-T1

## What to build
Channels, consent events, wording versions, suppression entries and reasons, contact check request/result, evidence export, public unsubscribe and consent form routes, events and `consent.*` codes. Tag a release.

## Acceptance criteria
- [ ] A denial is a typed result carrying a code, not an HTTP error
- [ ] Lists use cursors with a page maximum
- [ ] `dist/` rebuilt, version bumped, tag named

### T3: Db: ledger, wording, suppression and check log
Repo: db
Blocked by: T2

## What to build
Tables per the spec, with row-level security, an append-only trigger on the ledger, wording immutable once referenced, a unique salted hash per Organization and channel scope on suppression, and indexes for the check path.

## Acceptance criteria
- [ ] Harness: update or delete on a ledger row fails; editing referenced wording fails
- [ ] Second Organization reads and writes nothing on any table
- [ ] The check query uses an index (explain test) at 1,000,000 suppression rows
- [ ] Tag released

### T4: Core: suppression list and Contact Check, fail closed
Repo: core
Blocked by: T3

## What to build
Add and look up suppression entries (manual add, listing, removal of manual entries only with a reason) and the internal Contact Check returning allowed/denied with a code, for every channel and purpose, writing a check-log row. Unknown Prospect or address is denied.

## Acceptance criteria
- [ ] Table-driven route tests cover every channel, purpose, consent state and suppression state
- [ ] A suppressed address is denied on every channel and purpose, including `rep_initiated`
- [ ] Removing a non-manual entry returns `consent.entry_not_removable`
- [ ] Second-Organization test: suppression in one never affects the other, and one cannot read the other's list or logs
- [ ] Check p95 benchmark with a budget; `suppression.added` published once
- [ ] Only the internal secret may call the check

### T5: Core: record and withdraw Contact Consent, with evidence
Repo: core
Blocked by: T4

## What to build
A Rep or Admin records a granted consent on a channel with source, wording version and reference; a withdrawal appends a withdrawn event; current state is derived. The Contact Check now allows agent-initiated phone, SMS and WhatsApp only with a current grant.

## Acceptance criteria
- [ ] Route tests: grant, withdraw, grant again gives allowed; withdrawn gives `consent.withdrawn`; no event gives `consent.missing`
- [ ] A grant without source or wording is refused
- [ ] A Rep may record only for Prospects they can see (M02 visibility)
- [ ] Withdrawal on one channel leaves others unchanged; STOP-all withdraws all
- [ ] Second-Organization test; events `consent.granted` and `consent.withdrawn` published

### T6: Kit: ContactGuard with HTTP and memory adapters
Repo: kit
Blocked by: T2

## What to build
A port the voice and outbound services call, with an HTTP adapter to the internal check (timeout 500 ms, one jittered retry, fail closed) and a configurable memory adapter for tests. Tag a release.

## Acceptance criteria
- [ ] Behaviour suite runs against both adapters
- [ ] A timeout and a 5xx both return denied with `consent.unavailable` and log without secrets
- [ ] `dist/` rebuilt, tag named

### T7: Core: one-click unsubscribe and inbound STOP
Repo: core
Blocked by: T5

## What to build
A public unsubscribe endpoint driven by a signed token (works with `List-Unsubscribe-Post`) and an internal `record-withdrawal` for channel adapters on STOP. Both add a suppression and withdraw consent at once.

## Acceptance criteria
- [ ] Route tests: valid, tampered, expired and replayed tokens (`consent.invalid_token` for the bad ones; replay idempotent)
- [ ] After unsubscribe the Contact Check denies email immediately
- [ ] Rate-limited per address in Postgres; no Prospect data in the response page
- [ ] Second-Organization test: a token for one Organization cannot affect another

### T8: Core: hosted consent forms with versioned wording
Repo: core
Blocked by: T5

## What to build
An Admin creates a consent form from a wording; publishing locks the wording version. A public submission stores a grant with the wording version, time, IP and user agent, and the form identifier.

## Acceptance criteria
- [ ] Route tests: submission creates a grant tied to the exact version; editing a used wording is refused with `consent.wording_locked`
- [ ] The form requires an unticked-by-default affirmative choice for each channel
- [ ] Repeated submission with the same key is idempotent
- [ ] Second-Organization test

### T9: Portal: Prospect consent panel and suppression screen
Repo: portal
Blocked by: T5, M02-T5

## What to build
On a Prospect, per-channel consent state with its evidence in ruled rows and a record/withdraw action; an Admin suppression screen with search, reasons, add, and removal of manual entries.

## Acceptance criteria
- [ ] Screen tests for grant, withdraw, denied-channel display, add and remove
- [ ] A Rep cannot see the suppression screen
- [ ] Editorial style; axe passes in both themes

### T10: Portal: consent form builder and hosted page
Repo: portal
Blocked by: T8

## What to build
An Admin screen to write wording, preview and publish; a signed-out hosted consent page at a token URL in the site's editorial style with plain-language explanation of AI contact.

## Acceptance criteria
- [ ] Screen tests for builder lock behaviour and the hosted page submit
- [ ] `/run-check`: submit in `agent-browser` and see the grant on the Prospect
- [ ] The hosted page makes no claim not backed by ADR 0003

### T11: Core: evidence export and bulk suppression import
Repo: core
Blocked by: T5

## What to build
Export a Prospect's ledger and wording as JSON and CSV; import a CSV of addresses to suppress via a queued job with a per-row report.

## Acceptance criteria
- [ ] Export contains every event with wording text and evidence, and is Admin and Owner only
- [ ] Import of 50,000 rows is queued, idempotent and reports bad rows
- [ ] Second-Organization test for both
