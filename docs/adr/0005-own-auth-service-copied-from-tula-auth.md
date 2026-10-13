# ADR 0005 — Closeline's own auth service, copied from tula-auth

**Status:** Accepted
**Date:** 2026-10-12
**Supersedes:** ADR 0002

## Context

ADR 0002 made closeline depend on a running tula-auth. tula-auth is unpublished, so that meant consuming an image and tarballs from another repo and being blocked by its breaking changes. Closeline is also now split into separately deployed services, each of which needs to know a person's Organization and role on every request.

## Decision

Closeline has its own auth service, `tula-closeline-auth`, created by copying tula-auth's server, its tests and conformance scenarios, its contract, and its core and React client packages. Its schema and migrations move to `tula-closeline-db`. The mobile clients, CLI, scaffolder and tula-auth's own admin dashboard are not copied. tula-auth's project and environment structure is kept unchanged, with one fixed project per Region, so that security-critical code is not rewritten.

Organizations, Teams and roles live in the core service, not in auth. When auth issues a token it asks core once, through the existing token hook, and writes the Organization and role into the token. Other services read them from the token and make no call to core per request.

## Considered options

- **Depending on tula-auth as a service** (ADR 0002). Rejected for the coupling to an unpublished product.
- **Membership inside the auth service.** Fewer moving parts at sign-in, but it would push closeline's own concepts into copied code and widen the gap from its source.
- **Each service asking core on every request.** Role changes would apply faster, but core would sit on every request path.

## Consequences

- The copy is a fork. Security fixes made in tula-auth after the copy must be ported by hand; the source commit is recorded in the new repo so the difference can be reviewed.
- A role change takes effect when the token is next refreshed, not instantly.
- Auth cannot issue tokens while core is unreachable, so the hook call needs a timeout and a defined failure behaviour.
- "Workspace", "project" and "environment" remain in the auth service's code with tula-auth's meanings; they are not closeline domain terms.
