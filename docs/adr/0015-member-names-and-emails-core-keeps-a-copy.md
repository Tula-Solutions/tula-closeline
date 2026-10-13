# ADR 0015 — Member names and emails: core keeps a copy

**Status:** Accepted
**Date:** 2026-10-13
**Builds on:** ADR 0005, ADR 0007, ADR 0011

## Context

The portal's member list must show who each member is. Core owns memberships (ADR 0005) but stores only the user id and role. The auth service owns the person's email and name. A service never reads another service's schema (ADR 0007). The member response in the contract's `0.4.0` payloads carries only `userId`, `role` and timestamps, so a list of members cannot be displayed (hub issue 31, from the review of contract#3).

## Decision

1. **Auth stays the owner of a person's name and email.** It is where they are changed, and the source of truth.
2. **Auth sends them to core** when the membership is made, in the two sign-up calls ADR 0011 describes (creating an Organization and accepting an Invitation), and again when either changes.
3. **Core stores the copy on the membership** and returns it in the member list, so one query serves the list.
4. **The copy arrives over the typed internal call.** This fits ADR 0007: core reads nothing from the `auth` schema. Auth, the owner, chooses to send the data, in a request described by the contract and authenticated as ADR 0013 says.

The contract carries the fields on the member response and on both internal sign-up requests. How a later change reaches core (a direct call or a queued event) and the exact request shapes are left to the implementing tickets.

## Considered options

- **The portal asks auth for profiles by user id** after reading the list from core. Rejected: auth can only check that those users are in the caller's Organization by asking core, so each list becomes a second call that makes a third.
- **Core asks auth in a batch** when serving the list. Rejected: a synchronous dependency on auth on a read path, needing a timeout and a degraded answer for the case where auth is slow or down.

## Consequences

- Personal data is held in two schemas. Erasure and export must cover both.
- The copy can be stale until a change reaches core. The delivery of a change must be idempotent and retried with a bounded, jittered retry, so a lost or repeated delivery cannot leave a wrong name behind for long.
- Auth is the source: when the copy and auth disagree, auth is right, and the next change delivery corrects core.
- `email` and `display_name` are added to `core.memberships` in a new migration in `tula-closeline-db`. The table is empty everywhere, so they can be `NOT NULL`.
- Work lands in this order: contract (payloads), db (columns), core, auth, portal. Role changes and removal work on user ids and do not wait for this.
