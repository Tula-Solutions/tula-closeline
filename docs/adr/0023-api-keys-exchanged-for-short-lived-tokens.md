# ADR 0023 — API keys are exchanged for short-lived tokens, and public routes are marked in OpenAPI

**Status:** Accepted (a lead decision).
**Date:** 2026-10-23
**Extends:** ADR 0005
**Builds on:** ADR 0007, ADR 0013

## Context

Milestone M16 (`docs/specs/m16-agent-controls-audit-openness.md`) lets an Admin create an **API key** so a program can call Closeline for an Organization. Every service already verifies one kind of credential, the auth service's token (ADR 0005), and ADR 0005 put the Organization and role into that token so no service calls core per request. A long-lived key checked on every request by every service would break both properties. Core owns keys (ADR 0007); auth owns tokens.

## Decision

**A key is never sent to a service other than auth.** The key (`clk_` plus 43 URL-safe characters, 256 bits) is shown once and stored in core only as a SHA-256 hash. A program calls auth's `POST /v1/token` with the key. Auth asks core over the internal call to verify it (timeout, bounded jittered retry), then mints a token and returns it. Every other service verifies that token with the kit exactly as it verifies a member's.

**The token** (kit's `apiKeyTokenClaimsSchema`, contract `API_KEY_SCOPES`):
- `act: 'api_key'`. A member's token has no `act`; any other `act` value is refused.
- `sub` is the API key id (`akey_…`), `org` the Organization, `region` the Region.
- `scp` is one or more scopes from the contract's closed list, `<area>:read` or `<area>:write` over the areas prospects, consent, enrichment, campaigns, messaging, bookings, playbook and calls. `write` does not imply `read`: a key that needs both lists both.
- There is no `role` and no Membership; a token that carries a role together with `act: 'api_key'` is refused. A key records a role ceiling (never above its creator's) for core to apply on routes that check roles.
- It lives 10 minutes. There is no refresh token: the program exchanges the key again.

**Verification is fail-closed.** The kit refuses the token for any malformed or missing claim, an unknown actor, an empty scope list, a scope outside the contract's list, or an expired or incoherent `iat`/`exp`. A route accepts an API key only if it carries the kit's `requireScope(scope)` guard; the auth middleware refuses an API key on any route without one, and a guard opts in one method of one route. A scope check is exact: `prospects:write` does not allow a read.

**Revocation** takes effect at the next exchange: a revoked or expired key cannot be exchanged, and tokens already minted work until they expire, at most 10 minutes. The refusal of an unknown, malformed or revoked key is one answer that reveals nothing about which keys exist. Failed exchanges are counted per source in Postgres, not in memory. Per-key rate limits are Postgres counters and answer `apikey.rate_limited`.

**What a key can never reach.** Keys are limited to the eight areas above. They never reach the Organization's administration (members, billing, API keys, audit log, exports, Agent instructions and controls), Call recordings or Transcripts, or webhook, internal and public-form routes.

**Audit.** An action by a key is recorded with actor kind `api_key` and the key id, never as a person (ADR 0024).

### Marking public routes

A route is part of the public API only if its OpenAPI operation says so. Each service's `openapi.json` marks an operation with two extensions:

- `x-closeline-public: true`
- `x-closeline-scopes: ["<area>:read"]` or `["<area>:write"]`: exactly one scope, `read` for GET and `write` for any other method.

The source of truth is the contract's route table, where a route carries `publicApi: { scope }`. At the time of writing the contract has the marking but the services' generated `openapi.json` does not emit these two extensions yet (core's has no `x-` keys): **each service must emit them from `publicApi`** before any route appears in the public document. Until then the document has no paths.

`scripts/public-openapi.ts` (`bun run public-openapi`) merges the marked operations of each sibling service's `openapi.json` into `public-openapi.json`:
- Only marked operations are kept, only under `/v1/…`, and each must accept the `accessToken` security scheme. An unmarked operation, an `internal` or non-`/v1` path, a webhook is never copied.
- A marked operation with no scope, a malformed or second scope, a read scope on a write method (or the reverse), or a scope on an unmarked operation fails the build.
- Only the components reachable from kept operations are copied. A component that two services define differently, a reference that does not resolve, or the same method and path in two services fails the build.
- The output is deterministic: services are processed in name order, keys are sorted, two-space indent. Core alone is enough to produce a valid OpenAPI 3.1 document.
- Breaking changes need a new version prefix (`/v2`); `/v1` only grows.

The workflow `.github/workflows/public-openapi.yml` fails a pull request when the committed `public-openapi.json` has an operation not marked public, is not valid OpenAPI 3.1 or is not in the canonical form. `bun run verify` runs the same check through the script's tests. The file is regenerated from the sibling clones by `bun run public-openapi`; a service ticket that marks a route reruns it in the same round.

## Considered options

- **Verify the key at every service.** Rejected: core on every request path, and key hashes beyond core.
- **A long-lived signed key that is itself the token.** Rejected: revocation could not be faster than expiry, and expiry would have to be short anyway.
- **Give a key a Membership.** Rejected: a key is not a person; roles belong to Memberships (ADR 0005), and the token would then pretend to be one.
- **A list of public routes kept in the hub.** Rejected: it drifts from the services. A mark on the route fails closed.
- **A separate hand-written public OpenAPI.** Rejected for the same drift.

## Consequences

- Auth gains `POST /v1/token` and calls core (ticket M16-T9); a token is never minted while core cannot verify the key.
- Each service's OpenAPI generator must emit the two extensions (an open follow-up for the contract and each service).
- A revoked key can act for up to 10 minutes. This is accepted.
- The scope list is closed in the contract; a new area is a contract change, a new tag and this record's list updated.
