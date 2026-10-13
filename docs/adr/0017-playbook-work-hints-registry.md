# ADR 0017 — Playbook background work: a registry of work hints

**Status:** Accepted
**Date:** 2026-10-13
**Builds on:** ADR 0007, ADR 0016

## Context

Every table in the `playbook` schema is under forced, fail-closed row-level security (ADR 0007), so a background sweep sees no rows until it is inside one Organization's scope. The sweep must find which Organizations have work due: purges of deleted documents (ADR 0016), ingestion jobs, vector cleanup, old consumed messages, old idempotency keys, and purges that reached their attempt bound. The Playbook service has no list of Organizations, and core's list is in a schema the service must not read (ADR 0007). This came up in hub issue 53 (db PR 10).

This is a decision of the lead, made during that work. It is not a choice of the product owner.

## Decision

1. **A registry table, `playbook.work_hints`,** holds only a kind, an Organization id and a due time. It is outside row-level security and is on the isolation allowlist. No service role has any privilege on it.
2. **It is written only by `SECURITY DEFINER` triggers** on the tenant tables. A trigger can note work only for its own row's Organization.
3. **It is read only through `playbook.organizations_with_work`,** a definer function that only the playbook role may execute. The function:
   - refuses to run inside an Organization scope, so a request path cannot call it;
   - verifies each due hint inside that Organization's own scope;
   - returns Organization ids only;
   - bounds both what it returns and how many hints it visits.
4. **A hint may be early or stale; a missing hint is the failure to prevent.** The function corrects or removes a wrong hint. Every state change that creates work notes a hint in the same transaction.

## Considered options

- **A function owned by a role with `BYPASSRLS` that reads the tenant tables.** Rejected: it needs a role created by a superuser, and a bug in it reaches every tenant table.
- **A second permissive policy for a sweeper role.** Rejected: the isolation check requires exactly one policy per table, and a second weakens fail-closed.
- **Asking core for the Organization list on each pass.** Rejected: work proportional to the number of Organizations on every sweep, and a synchronous dependency on core.
- **A function that sets the scope for each Organization.** Not an option alone: it needs the list first.

## Consequences

- One cross-tenant table exists in the `playbook` schema. It shows only that an Organization has work of a kind, and when.
- Deletes, job state changes, consumed messages and idempotency keys pay an extra hint check: a share lock, and a write only when the hint moves earlier.
- Every new kind of background work needs its own trigger and kind, and a test that its hint cannot be lost.
- The sweep runs the discovery call alone in its transaction.
- Hints for consumed messages (15 days) and idempotency keys follow the real purge cutoffs.
- Any new table added to the allowlist needs its own decision record.
