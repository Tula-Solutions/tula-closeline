# ADR 0017 — Playbook background work: a registry of work hints

**Status:** Accepted
**Date:** 2026-10-13
**Builds on:** ADR 0007, ADR 0016

## Context

Every table in the `playbook` schema is under forced, fail-closed row-level security (ADR 0007), so a background sweep sees no rows until it is inside one Organization's scope. The sweep must find which Organizations have work due: purges of deleted documents (ADR 0016), ingestion jobs, vector cleanup, old consumed messages, old idempotency keys, and purges that reached their attempt bound. The Playbook service has no list of Organizations, and core's list is in a schema the service must not read (ADR 0007). This came up in hub issue 53 (db PR 10).

This is a decision of the lead, made during that work. It is not a choice of the product owner.

## Decision

1. **A registry table, `playbook.work_hints`,** holds only a kind, an Organization id and a due time. It is outside row-level security and is on the isolation allowlist. No service role has any privilege on it. This is the one exception to the common rule that every table carrying an Organization id is under fail-closed row-level security. It is not an Organization data table: it holds no Organization data, only that work of a kind is due from a time, and nothing but the triggers and one function can touch it. The db library's isolation test, which pins the exact allowlist, enforces this.
2. **It is written only by `SECURITY DEFINER` triggers** on the Organization tables. A trigger can note work only for its own row's Organization.
3. **It is read only through `playbook.organizations_with_work`,** a definer function that only the playbook role may execute. The function:
   - refuses to run inside an Organization scope, so a request path cannot call it;
   - verifies each due hint inside that Organization's own scope;
   - returns Organization ids only, except that the kind `consumed_purge` also covers messages that belong to no Organization, under a reserved all-zero id;
   - bounds both what it returns and how many hints it visits.
4. **A hint may be early or stale; a missing hint is the failure to prevent.** The function corrects or removes a wrong hint. Every state change that creates work notes a hint in the same transaction.

## Considered options

- **A function owned by a role with `BYPASSRLS` that reads the Organization tables.** Rejected: no role, the owner included, should read across Organizations, and a `BYPASSRLS` role breaks that for every table at once; a bug in it reaches every Organization table.
- **A second permissive policy for a sweeper role.** Rejected: the isolation check requires exactly one policy per table, and a second weakens fail-closed.
- **Asking core for the Organization list on each pass.** Rejected: work proportional to the number of Organizations on every sweep, and a synchronous dependency on core.
- **A function that sets the scope for each Organization.** Not an option alone: it needs the list first.

## Consequences

- One cross-Organization table exists in the `playbook` schema. A leak of it or of the function shows which Organizations have work, of what kind and when (a customer list with activity patterns), never documents or contents.
- Calling the function needs an unscoped connection as the playbook role, so the protection rests on request code always going through the Organization-scoped helper.
- Deletes, job state changes, consumed messages and idempotency keys pay an extra hint check: a share lock, and a write only when the hint moves earlier.
- A lost hint is not a delay but a miss until some later write notes it. That is why every new kind of background work needs its own trigger and kind, and a test that its hint cannot be lost.
- The sweep runs the discovery call alone in its transaction, because the call sets the scope per Organization while verifying and holds hint locks until commit.
- Discovery writes, since it corrects and removes hints, and it skips hints locked by a writer, so a busy Organization can appear one sweep late.
- Purge, retention and erasure (ADR 0016) are the work being found. Erasure removes an Organization's hints with the rest, and a leftover hint is harmless because verification removes it.
- Hints for consumed messages (15 days) and idempotency keys follow the real purge cutoffs.
- Any new table added to the allowlist needs its own decision record.
