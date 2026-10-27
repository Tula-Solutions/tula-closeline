# ADR 0022 — CRM sync: a provider port, sealed tokens, Source-based conflicts and webhooks with a sweep

**Status:** Accepted (a lead decision). The defaults marked as the lead's are open to revision by the owner.
**Date:** 2026-10-23
**Builds on:** ADR 0003, ADR 0007, ADR 0013, ADR 0018, ADR 0020, ADR 0021

## Context

Milestone M4 (`docs/specs/m04-crm-sync.md`) connects an Organization's CRM to Closeline: HubSpot first (hub issue 17), Salesforce second. Deals, Calls, companies and contacts come in; Closeline activity can go back. Four things need one answer before any ticket builds on them: how a provider is reached and its tokens kept, who wins when both sides changed a value, how changes arrive and are made safe to repeat, and what a CRM may never tell us. Core owns the connection (ADR 0007: one writer per schema), and the Playbook keeps Deals and Calls (ADR 0018).

## Decision

**Provider port.** Core talks to a CRM only through a `CrmProvider` port: authorise, exchange and refresh tokens, list objects changed since a cursor, get by id, write, and verify a webhook. Adapters are memory (tests and local dev), HubSpot, then Salesforce, and all must pass one behaviour suite. One CRM connection per provider per Organization. Outside calls have a timeout and a bounded, jittered retry. ADR 0013 rule 5 (a vendor proxy) covers calls to CRMs only; calls from core to the Playbook are internal and use the kit's internal-call helper under rule 4.

**Token storage.** Access and refresh tokens are stored only encrypted, through a `SecretBox` port (encrypt, decrypt) with a local-key adapter and a memory adapter; the AWS key adapter comes with infra. A token is never returned, logged or sent to Sentry, and a test scans for it. Each ciphertext is bound to its Organization and connection id (associated data) and carries a key id, so a copied row does not decrypt elsewhere. The env schema fails at boot if the local-key adapter is chosen when `ENVIRONMENT` is `staging` or `prod`. Disconnecting deletes the tokens at once. A refresh that fails with a revoked or expired grant marks the connection `needs_reconnect` and stops its runs; it is never silent. OAuth uses the authorisation-code flow with a signed, expiring `state` bound to the Admin and the Organization, compared in constant time and single use. Scopes start at the minimum read set; write scopes are asked for only when write-back is switched on.

**Directions.** An Admin chooses, per field, read only, write only or both; the default is read only.
- Deals and Outcomes: CRM to Closeline, into the Playbook's existing Deal path (ADR 0018). An Admin-confirmed Stage mapping says which deal stages are won, lost or open; without it no Deal is imported (`crm.mapping_incomplete`). Outcome changes made in Closeline go back only if the Admin allows it.
- Calls: CRM to Closeline, only with the rights confirmation of ADR 0018 choice 12 (`crm.rights_not_confirmed`). A Call with no usable Recording or Transcript is listed as skipped with a reason. A note for a Call or an Agent message carries a short summary and a link, never the message body, the Transcript or the Recording. The link needs a Closeline sign-in and shows nothing to anyone else.
- Companies and contacts: CRM to Prospect Companies and Prospects with Source `crm:<system>`. Edits made in Closeline go back per the field setting.
- A Deal deleted in the CRM is marked unlinked in Closeline; it is not removed from the Playbook.

**Conflicts.** Every write into a Prospect field goes through ADR 0020's function. A manual value beats a CRM value whatever the time; otherwise the most recent wins. A sync never overwrites a manual value, and the run reports the fields it skipped for that reason. For write-back, a field is written to the CRM only when its current value is a Closeline value and the field's setting allows it; the CRM's own later edit is read back as a new `crm:<system>` value and is ranked by ADR 0020 like any other.

**Loops.** After a write-back core stores the provider's new version in `crm_external_ref`. When that change returns by webhook or pull, a record whose version equals the stored one is recognised as our echo and dropped. Writing a value equal to the current one is a no-op.

**Idempotency of write-back.** Each write to the CRM carries a deterministic key (Closeline object id plus version). The intended write is recorded in `crm_external_ref` before the call, and a retry looks up the recorded provider id before it creates anything, so a lost response never duplicates a note. The behaviour suite covers a write that is applied and then reported failed.

**Idempotency and cursors.** A queued job per object kind pulls a bounded page after a stored cursor, writes through the owning service, and advances the cursor only after the commit. Calls into the Playbook carry an idempotency key built from provider, object id and version. A re-run page creates no duplicate. One poison record is reported and does not stop the run.

**Webhooks and sweep.** A public webhook route verifies the provider's signature in constant time, refuses a delivery outside a bounded timestamp window, refuses a replayed delivery (recorded in `crm_webhook_receipt`), and only enqueues a targeted pull for the named object. It never trusts the payload as data. Receipts are kept for the timestamp window plus a margin and pruned by a periodic job. A periodic sweep per connection pulls everything changed since the cursor, so a lost webhook only delays an update. The route answers fast and does no sync work.

**Rate limits.** Core honours the provider's limit headers and `Retry-After`, backs off with jitter and resumes without losing the cursor (`crm.rate_limited` is shown, never fatal). Each connection has a concurrency limit, so one Organization cannot use up the shared queue.

**CRM consent flags are information only.** A CRM "consented" or "marketing opt-in" flag is stored and shown as information. It is never a granted event in the consent ledger without recorded evidence (ADR 0003, ADR 0021). A CRM opt-out or unsubscribe is the opposite: it becomes a Suppression entry (ADR 0021), because refusing is always safe.

**Never synced.** Consent evidence (ledger events, Consent Wording, form IP and user agent) and Suppression hashes never leave Closeline. Recordings are never sent to a CRM. Message bodies and Transcripts are not copied into the CRM; a note carries a short summary and a link. A CRM's data flows into Closeline only under these rules, and tokens are never copied between Organizations.

**Isolation.** Every table is Organization-scoped with row-level security. The pair (provider, external account id) is unique across all Organizations: connecting an account that another Organization already holds is refused by a database unique index, not a cross-tenant read, with a generic `crm.authorisation_failed` that names no Organization. A webhook is matched to its one connection by that pair, through a single named lookup that runs before any Organization is known and returns only the Organization id; all later work runs through the tenant-scoped helper. The OAuth `state` of one Organization is refused for another.

## Considered options

- **Use HubSpot's API directly, with no port.** Quicker for one CRM; Salesforce would then copy the logic. Rejected: the port costs little once the memory adapter exists (the memory adapter counts as the second implementation).
- **Store tokens in plain columns protected by row-level security.** Rejected: a leaked table or backup would leak access to every Organization's CRM.
- **Trust the CRM's consent flag.** Rejected: a checkbox is not evidence, and ADR 0003 has no setting to relax it.
- **A fixed rank, CRM always wins.** Rejected by ADR 0020 for the same reason: it loses a Rep's correction.
- **Webhooks only, or polling only.** Webhooks alone lose events; polling alone is slow and spends the rate limit. Both together are cheap and complete.
- **Two-way sync of everything by default.** Rejected: an Admin should choose what changes in their CRM; read only is the safe default.
- **Syncing in a request handler or the webhook.** Rejected: work proportional to an Organization's size must be queued.

## Consequences

- The `crm` contract area, tables and ports (tickets T2 to T4) follow from this record; codes are `crm.not_connected`, `crm.authorisation_failed`, `crm.needs_reconnect`, `crm.rate_limited`, `crm.mapping_incomplete` and `crm.rights_not_confirmed`.
- Core gains a key to manage: the local-key adapter is fine for development only, and infra must supply the AWS key adapter before real tokens are stored.
- A write-back cannot be perfectly exact when a CRM does not return a version; the adapter then falls back to comparing values, and the behaviour suite covers it.
- Whether HubSpot exposes Recordings on every plan is unverified; ticket T6 checks and reports.
- Salesforce has a different auth and event model; its adapter may need an addition to the port, which then gets a new record.
