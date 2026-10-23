Phase: 2 · Repos: contract, db, core, portal, hub · Parity rows: R1 (partial: no owned database), R8 (CRM records as the audience source)

# M2 Prospects and Accounts

## Problem Statement

Closeline has Deals and Calls but no record of the people they are about. A Deal carries only the Organization's own identifier. The Copilot, the Inbound Agent and the Outbound Agent each need to know who a Prospect is, where that information came from, who owns the relationship, and what they agreed to. Without a shared Prospect record every later module would invent its own, and consent (M3) and CRM sync (M4) would have nothing to attach to. 11x leans on a claimed 400M-record database and on CRM leads (R1, R8); we will not own a database, but we can be the place where an Organization's Prospects are accurate and where every field says where it came from.

## Solution

Core owns Prospects and the businesses they work for. An Organization creates Prospects by hand, by CSV import, from a form (later), and from its CRM (M4). Each Prospect belongs to a Prospect Company (the term for what the CRM world calls an account; see Further Notes), has an owner Rep, and shows, for every field, its value, source and time. Duplicates are found by normalised email, phone and LinkedIn address and merged without losing provenance. The portal gets a Prospects list and detail screens. Enrichment (M5) will write into the same provenance model.

Role rules (lead decision, flagged): Owners and Admins see every Prospect; a Manager sees Prospects owned by Reps on their Team; a Rep sees Prospects they own. This follows the glossary's rule that a Rep sees only their own conversations.

## User Stories

1. As a Rep, I want to add a Prospect with a name, email, phone, job title and company, so that I can start working them.
2. As a Rep, I want to see only the Prospects I own, so that I am not buried in everyone's records.
3. As a Manager, I want to see the Prospects of the Reps on my Team, so that I can coach and rebalance.
4. As an Admin, I want to see every Prospect in the Organization, so that I can manage the whole book.
5. As an Admin, I want to assign or reassign a Prospect's owner Rep, so that coverage follows the Team.
6. As an Admin, I want to import Prospects from a CSV, so that I can bring in a list.
7. As an Admin, I want an import report that says which rows were created, updated, skipped or rejected and why, so that nothing is silently dropped.
8. As an Admin, I want to download that report, so that I can fix the file and try again.
9. As a Rep, I want to open a Prospect and see each field with where it came from and when, so that I know how far to trust it.
10. As a Rep, I want a field I edit by hand to be marked as mine and to win over later automatic updates, so that my correction does not get overwritten.
11. As an Admin, I want the system to tell me when two Prospects look like the same person, so that I do not contact someone twice.
12. As an Admin, I want to merge two Prospects and choose which value to keep per field, so that the record is right.
13. As an Admin, I want a merge to keep both histories and be reversible within thirty days, so that a mistaken merge is not permanent.
14. As a Rep, I want to group Prospects under a Prospect Company, so that I see everyone I am talking to at one business.
15. As a Rep, I want to find Prospects by name, email, company, owner or source, so that I can reach one quickly.
16. As a Rep, I want long lists to page smoothly, so that the screen stays fast with tens of thousands of Prospects.
17. As a Rep, I want to see on a Prospect which Deals are linked to it, so that I know the history.
18. As a Rep, I want to see a Prospect's consent and suppression state at a glance (from M3), so that I do not try a channel that is closed.
19. As an Admin, I want a Prospect's email and phone stored in a normalised form, so that matching and suppression work.
20. As an Admin, I want a Prospect marked with a source (manual, CSV import, HubSpot, form), so that I can audit where my data came from.
21. As an Admin, I want to erase a Prospect on request, so that I can meet a deletion request.
22. As an Admin, I want an erasure to remove the Prospect from the Playbook's links and keep only a hashed suppression entry, so that we never contact them again by accident.
23. As an Owner, I want an Organization's Prospects kept in its Region and unreadable to other Organizations, so that my data is isolated.
24. As a Prospect, I want my data corrected or removed when I ask the Organization, so that I keep control of it.
25. As an Agent (later), I want one place to read who a Prospect is and who owns them, so that I act on current data.
26. As a Rep, I want tags and free-text notes on a Prospect, so that I can record what the fields cannot.
27. As an Admin, I want a bulk action to assign many Prospects to a Rep, so that a new Rep gets a book quickly.
28. As an Admin, I want to see how many Prospects exist and how many were added this month, so that I understand growth without a dashboard project.
29. As a Rep, I want an import or merge I started to continue if I close the page, so that long work is safe.
30. As an Admin, I want the Prospect API documented in the public OpenAPI, so that my team can integrate.

## Implementation Decisions

- **Core owns** two new modules, `prospect` and `prospect-company`, each with router, service and schema. Prospects are tenant data: every table carries `organization_id` under fail-closed row-level security and all access goes through the tenant-scoped helper.
- **Contract area `prospect`**: Prospect, Prospect Company, field provenance, import job and row report, merge record, list filters, cursor pagination (maximum page 100), idempotency key on create and import. Error codes `prospect.not_found`, `prospect.duplicate_identity`, `prospect.import_invalid`, `prospect.merge_conflict`, `prospect.forbidden_owner`.
- **Schema (db library, core schema)**: `prospect_company` (id, name, domain, normalised domain); `prospect` (id, company ref, owner Rep, status, tags, notes); `prospect_identity` (prospect, kind email|phone|linkedin, normalised value, unique per Organization, primary flag); `prospect_field` (prospect, field name, value, source kind, source ref, set at, set by); `prospect_import` and `prospect_import_row`; `prospect_merge` (survivor, merged ids, snapshot for undo). Normalisation follows ADR 0011: ASCII case folding, E.164 for phone, host-only for LinkedIn.
- **Provenance rule**: a write carries a source (`manual`, `import`, `crm:hubspot`, `crm:salesforce`, `form`, later `enrichment:<provider>`). Precedence: manual beats everything; otherwise most recent wins unless a per-field policy says otherwise. The rule lives in one service function so M4 and M5 reuse it.
- **Events** through the queue port: `prospect.created`, `prospect.updated`, `prospect.merged`, `prospect.erased`, using the contract's event envelope. The Playbook consumes `prospect.erased`.
- **Import** is asynchronous like the Playbook's deal import (ADR 0018): CSV with documented template, 10 MB and 50,000 rows, a queued job, a per-row report, idempotent and resumable. No work proportional to Organization size on a request path.
- **Matching** for duplicate suggestions runs from indexed normalised identities, bounded per request; no scan of the whole table.
- **Visibility** is enforced in the service from the verified token's role and Team membership, not in the portal.
- **Deal link**: core stores the link between a Prospect and a Deal's Organization identifier; the Deal itself stays in the Playbook, read over HTTP when a Prospect screen needs it.
- **Portal**: Prospects list (search, filters, cursor), detail with provenance, create form, import flow, duplicate review and merge. Editorial style as the rest of the portal.
- **Erasure** removes the Prospect, its fields and identities, writes a salted-hash suppression entry (M3) and emits `prospect.erased`. It is a queued job.
- **Vendors**: none. Enrichment providers belong to M5 behind a port.

## Testing Decisions

- Highest seam: HTTP routes in core with memory adapters, as in `router.test.ts` for members and teams. Cover create, update with provenance, list with cursor, filter and role visibility, merge and undo, import report, erasure.
- Cross-Organization isolation: a second Organization cannot read, list, update, merge into, import over, or learn the existence of (404, not 403) the first one's Prospects, Prospect Companies or imports; db harness proves the row-level security on each new table.
- Role tests: a Rep sees only owned Prospects; a Manager sees Team Prospects and not another Team's; Admin sees all.
- Import tests: bad rows reported with reasons, repeated upload with the same key creates nothing new, a crash mid-job resumes without duplicates.
- Idempotency and pagination tests follow the Invitation and Playbook prior art; a benchmark for list and identity lookup with a budget at 100,000 Prospects (hot path for later Agents).
- Portal: screen tests with a fake client for the list, detail provenance and merge flow; `/run-check` imports a CSV and merges a pair in `agent-browser`.

## Out of Scope

- Enrichment, signals and any purchased data (M5); audience building for campaigns (M7).
- Consent and suppression logic itself (M3); this module only displays the state and calls the erase hook.
- CRM connections and syncing (M4); this module provides the write path they use.
- Custom fields defined by the Organization (a later extension), pipelines and a Deal board.
- Prospect-facing portals or preference centres.

## Further Notes

- **Proposed GLOSSARY terms.**
  - **Prospect Company**: the business a Prospect works for, held as a record in an Organization's book. _Avoid_: account (reserved: it is also a sign-in), Organization (that is the Closeline customer), company, client.
  - **Source**: where a value on a Prospect came from, with the time it arrived. _Avoid_: origin, provenance (in user-facing text), channel.
- The module list calls this "Accounts"; the glossary already forbids "account" for an Organization, so the term above is proposed and needs the lead's approval before tickets run.
- **ADR needed:** one short decision record for the provenance and precedence rule, since M4 and M5 depend on it (ticket M02-T1).
- **Parity:** R8 fully (CRM records as an audience source, via M4 and M7); R1 only in the sense of a Prospect store; the 400M database is not pursued.
- Open question: whether Reps may see unowned Prospects in their Team's pool; default here is no.
