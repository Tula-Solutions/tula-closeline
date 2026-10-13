# ADR 0007 — One database per Region, one schema per service

**Status:** Accepted
**Date:** 2026-10-12

## Context

Closeline's services are deployed separately, but running a Postgres per service in each Region is costly from the first day. Payhub shares one database with every service reading and writing the same tables, and keeps its schema definitions and its migrations in two different repos, which drifted apart.

## Decision

Each Region has one Postgres. Each service owns one named Postgres schema and is the only writer to it, enforced by a database role per service. A service that needs another's data calls that service or consumes its events; it does not read the other schema.

`tula-closeline-db` holds every migration and the typed schema definitions together, and is the only place migrations are generated or applied from. Tenant isolation inside each schema is by fail-closed row-level security on the Organization.

## Considered options

- **Shared tables, as payhub.** Least code, but couples services through the tables so they cannot change or scale independently.
- **A database per service.** Strongest independence, at several times the fixed cost and operational load.

## Consequences

- A service can be moved to its own database later without a rewrite, because nothing else reads its schema.
- Queries that would be one join in a shared-table design become a service call or a locally kept copy fed by events.
- All services depend on a version of `-db`; a migration is released as a new tag before the service that needs it.
