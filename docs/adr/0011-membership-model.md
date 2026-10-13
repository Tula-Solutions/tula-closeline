# ADR 0011 — One Organization per user, joined at sign-up, found through directories

**Status:** Accepted
**Date:** 2026-10-12
**Builds on:** ADR 0001, ADR 0005, ADR 0007

## Context

ADR 0005 puts Organizations, Teams and roles in the core service and has the auth service stamp the Organization and role into each token. It leaves open how a person gets into an Organization, how many they can be in, and how sign-in finds the Organization before one is known. Row-level security on `organization_id` (ADR 0007) answers every query with nothing until an Organization is set, so it forbids, by design, asking "which Organization is this user in" at sign-in and "which invitation does this token belong to" when accepting. The schema is in `tula-closeline-db` (hub issue 9, phase 1 steps 1.7, 1.8 and 1.9).

## Decision

1. **One Organization per user.** A user (a person who can sign in) belongs to exactly one Organization in a Region. One database constraint enforces it, `membership_directory_one_organization_per_user`, so allowing several later is one migration plus an Organization picker and a switch flow.
2. **Sign-up creates or joins.** The only two ways in are creating an Organization, whose creator becomes its Owner, or accepting an Invitation. The account and the membership are made in one step, so every signed-in user has an Organization and every access token carries the Organization and role. The auth service calls core during sign-up.
3. **Lookups made before the Organization is known go through directory tables and exact-key functions.**
   - Two directory tables hold only that mapping: user to Organization and its status, and invitation token hash to Organization, invitation, expiry and status. They are written only by triggers, in the same transaction as the tenant rows. They sit on the db library's allowlist of tables outside row-level security, and the library's catalog check fails if any service role can read either.
   - The core service has no privilege on them. It calls two functions, each taking one exact key and returning at most one row. `organization_of_user` takes a user id and returns the Organization id and its status. `invitation_for_token` takes a token hash and returns the Organization id and invitation id, and only when the invitation is pending, unexpired and in an `active` Organization. A used, revoked, expired or unknown token, and one in a suspended or deleted Organization, all return nothing, so a caller cannot tell them apart.
   - A holder of the service connection therefore learns, for a user id or token hash it already holds, that user's Organization and status or that token's Organization and invitation. It also learns that a user id it tries to add already belongs to an Organization, because the unique constraint fires. It cannot list users, Organizations or token hashes, and learns nothing about ids it does not hold.
   - The caller then sets the Organization it was given and reads the real rows under row-level security.
4. **Rules the database enforces**, so no service can break them:
   - An Organization's Region never changes.
   - An `active` or `suspended` Organization always has an Owner: it is created with one and the last Owner cannot be removed or demoted, so ownership passes by promoting the next Owner first. A `deleted` Organization may be emptied, the last Owner included, so its users can join another; an emptied Organization cannot become `active` or `suspended` again.
   - A Team and its members are in the same Organization.
   - An Invitation never offers the Owner role. It is revoked, never deleted. It cannot be accepted twice, after it expires, or unless its Organization is `active`. There is one pending Invitation per email per Organization.
   - Emails and Team names are folded to lower case for ASCII letters only, so the result does not depend on the database's locale. The service folds the same way.
5. **Invitation tokens** are at least 128 bits from a cryptographically secure generator, and only their SHA-256 hash is stored. The database checks the hash's shape, not the token's entropy, so the generator is a rule for the service and a test there.

## Considered options

- **Several Organizations per user, picked at sign-in.** Rejected for now: it adds an Organization picker, a switch flow and more ways for a Rep to act in the wrong Organization.
- **Account first, Organization later.** Rejected: a signed-in user with no Organization needs a second, limited kind of token that every other service must learn to refuse.
- **Weakening the tenant policies** with a second permissive policy so the lookups can pass. Rejected: the catalog check requires exactly one canonical policy on every tenant table, and a second one is combined with OR.
- **Letting the service role read the directories.** Rejected in review: one injected query could list every user and Organization in the Region, and with the Organization ids it could read each in turn.
- **A superuser or `BYPASSRLS` connection for sign-in.** Rejected: nothing in a service may bypass row-level security, and the catalog check fails if a service role can.

## Consequences

- There is no Organization picker and no second token kind. A consultant working for two customers needs two email addresses.
- Sign-up depends on core being up. An account without a membership is a fault: sign-in refuses it and reports it.
- During sign-up the auth service holds its database transaction open across the call to core, with an idempotency key fixed at the start of the attempt and a bound of 5 s. That ties up a connection under a slow core, and is a known cost.
- Suspending or deleting a large Organization updates one directory row per member and per pending Invitation. It is a background job, never a request.
- The service retries a transaction on serialization failure and on deadlock, with a bounded, jittered retry.
- The minimum Postgres version is 18, the version CI runs.
- A user who is removed from an Organization, or freed by its deletion, keeps a valid access token elsewhere until it expires, which is its short lifetime. Refresh is where the change takes effect, as ADR 0005 says of role changes.
- Allowing several Organizations per user later means dropping the constraint and also replacing `organization_of_user`, whose single-row answer rests on it, as well as the picker and switch flow.
