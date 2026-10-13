# ADR 0015 — Member names and emails: core keeps a copy

**Status:** Accepted
**Date:** 2026-10-13
**Builds on:** ADR 0005, ADR 0007, ADR 0011, ADR 0013

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
- The copy can be stale until a change reaches core. Delivery of a change is idempotent and retried with a bounded, jittered retry.
- An older change arriving late must not overwrite a newer one, so the update carries an ordering guard. Its form is left to the implementing ticket.
- A final change that is lost leaves the copy wrong until the next change, unless a reconcile is added. That is left open.
- Auth is the source: when the copy and auth disagree, auth is right.
- The copy is first sent during sign-up, before the account is certain to be written, so core can briefly hold an email for an account that never exists. That is the orphan case of ADR 0011 and is cleaned up with it (hub issue 36).
- The copy needs new columns on `core.memberships`, in a new migration in `tula-closeline-db`. Their names and whether they may be empty are left to that ticket; the table is empty everywhere, so no backfill is needed.
- Work lands in this order: contract (payloads), db (columns), core, auth, portal. Role changes and removal work on user ids and do not wait for this.
