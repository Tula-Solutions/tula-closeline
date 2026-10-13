# ADR 0002 — tula-auth for identity, closeline for membership

**Status:** Superseded by ADR 0005
**Date:** 2026-10-12

## Context

Closeline needs sign-in and sessions. Tula already builds an auth server, tula-auth, but as of this date none of its packages are published and it has no organizations, memberships or roles; those are planned for its Phase 3. Hosted providers offer all of this today but charge per user.

## Decision

Closeline uses a self-hosted tula-auth for sign-in, sessions and token verification, one instance per Region. Closeline owns Organizations, Teams and the Owner, Admin, Manager and Rep roles in its own database until tula-auth provides them.

## Considered options

- **A hosted provider such as Clerk.** Fastest to start and includes organizations and roles, but the per-user fee works against the goal of minimal cost.
- **Auth written inside closeline.** No external dependency, but it repeats work tula-auth has already done.

## Consequences

- Closeline consumes tula-auth as a Docker image and packed tarballs, not from a registry, until tula-auth publishes.
- A breaking change in tula-auth can block closeline; the two repos must be versioned together.
- Closeline's whole product is a single project inside each tula-auth instance. tula-auth's own "workspace" is not closeline's Organization, which is why closeline avoids the word.
- When tula-auth ships organizations and roles, membership moves there in a planned migration.
