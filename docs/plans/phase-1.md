# Phase 1 — Foundation and Playbook ingestion

## Goal

An Admin can sign in, create an Organization in a Region, invite Reps into Teams, and load the
Organization's sales history (documents, call transcripts, deal outcomes, HubSpot) into a Playbook
that can be searched for what worked in won deals. Nothing is sold yet; phases 2 to 5 build the
Copilot, the Inbound Agent, the Outbound Agent and the extra channels on this base.

## How phase 1 is built

The loop in `AGENTS.md`: one step per ticket, one repo per ticket, a branch from `origin/develop`,
`bun run verify` green, `/review-loop` with no blocking findings, a failing-first test for every
fixed finding, a PR into `develop`. Library steps land and are tagged before the steps that
consume them. Up to four workers run at once.

## Steps

Each step is one ticket. "After" lists the steps that must be merged first.

| Step | Repo | What | After |
| --- | --- | --- | --- |
| 1.1 | kit | Runtime base: structured logger that redacts secrets, typed app error, fixed advanceable clock, `createTestDeps` helper | — |
| 1.2 | contract | Error envelope and `area.reason` codes, cursor pagination schemas, branded ids, event envelope | — |
| 1.3 | db | Drizzle setup; `db:generate`, `db:check`, `db:migrate`; one Postgres schema and one database role per service; `withOrganization` tenant helper; row-level security test harness | — |
| 1.4 | core | Service skeleton in the hexagonal layout: container, ports, error handler, request ids, OpenAPI document, health and readiness; then fold it back into `templates/service` in the hub | 1.1, 1.2 |
| 1.5 | kit | Token verification middleware: offline JWKS, EdDSA, checks `kid`, `iss`, `aud`, `exp`, exposes Organization and role | 1.2 |
| 1.6 | db | Auth schema: tula-auth's tables and migrations brought into the `auth` schema | 1.3 |
| 1.7 | auth | Copy tula-auth's server (email and password, verification, sessions, refresh, JWKS) with its tests and conformance scenarios; one fixed project per Region; record the source commit; sign-up creates an Organization or accepts an invitation, see [ADR 0011](../adr/0011-membership-model.md) | 1.4, 1.6 |
| 1.8 | core | Organizations (with Region), memberships, the Owner, Admin, Manager and Rep roles, Teams, invitations; role checks; cross-Organization tests; the directory lookups and one Organization per user, see [ADR 0011](../adr/0011-membership-model.md) | 1.3, 1.4, 1.5 |
| 1.9 | auth | Token hook: ask core once at issuance and stamp Organization and role into the token, with a timeout and a defined failure behaviour; sign-up calls core the same way, see [ADR 0011](../adr/0011-membership-model.md) | 1.7, 1.8 |
| 1.10 | kit | Queue port with memory and AWS adapters; idempotent consumer helper; one behaviour suite run against both adapters | 1.1, 1.2 |
| 1.11 | hub | Research: choose the vector database, embedding model and document parser. Compare price, EU Region availability and limits; record the choice as a decision record. Decided on 2026-10-12: [ADR 0010](../adr/0010-knowledge-ingestion-vendors.md) | — |
| 1.12 | kit | Object storage port (memory and S3) and vector store port. Shipped with a memory adapter for each; the vendor adapter for the vector store moved to 1.35 (issue 48) | 1.10, 1.11 |
| 1.13 | playbook | Document ingestion: upload, parse, chunk, embed, index, per Organization; queued, idempotent, resumable; see [ADR 0016](../adr/0016-document-ingestion.md) | 1.12, 1.32, 1.33, 1.34 |
| 1.14 | playbook | Sales history ingestion: call transcripts and a deal export with won or lost outcomes, linked by deal identifier; index the moments of each call with its outcome | 1.13 |
| 1.15 | playbook | Search: given a moment in a conversation, return similar moments from won deals with the evidence count. Hot path: benchmark with a latency budget | 1.14 |
| 1.16 | core | HubSpot connection: OAuth, pull deals and call records into the same ingestion path as 1.14, incremental sync | 1.8, 1.14 |
| 1.17 | portal | Web app skeleton (Vite, React, TanStack, client generated from the services' OpenAPI); sign-in; create Organization; members and Teams; Playbook upload and status | 1.7, 1.8, 1.13 |
| 1.18 | infra | Choose the infrastructure-as-code tool; one dev environment in one Region on ECS Fargate with Postgres, queues, object storage and path-based routing; deploy from CI | 1.4 |
| 1.19 | hub | Local development: one compose file for Postgres and local stand-ins for the queue and object storage, and a script that runs every service | 1.3, 1.10 |
| 1.20 | hub | Phase 1 load test: ingestion throughput and search p95 against stated targets, with results recorded here | 1.15, 1.18 |
| 1.21 | kit | Error reporting port with Sentry adapter (#24): `ErrorReporter` port, Sentry and memory adapters, a no-op when no DSN is set; Sentry is the error tracker for every service and the portal | — |
| 1.32 | contract | The `playbook` area: routes, schemas and `area.reason` error codes for documents and their status, and the queue message for an uploaded document, see [ADR 0016](../adr/0016-document-ingestion.md) | 1.2 |
| 1.33 | db | Playbook tables in the `playbook` schema: documents, ingestion jobs, the per-Organization index settings (embedding model and dimension), and the consumed-message table for queue consumers; all tenant tables with row-level security | 1.3 |
| 1.34 | playbook | Service skeleton from `templates/service`: library bumps, container, error handling, OpenAPI, token middleware, queue and storage wiring on memory adapters, a `REGION` setting | 1.4, 1.5, 1.10, 1.12, 1.32 |
| 1.35 | kit | Vector store adapter for turbopuffer (hub issue 48), one namespace per Organization, passing the same behaviour suite as the memory adapter. Blocked on credentials | 1.12, 1.11 |
| 1.36 | playbook | Embedder (Cohere Embed v4 on Bedrock) and OCR (Mistral OCR 3) adapters behind ports in the service. Blocked on credentials; 1.13 runs on fakes until then | 1.24 |

Steps 1.22 to 1.31 were added as hub issues after this plan was written and are tracked there: #30 1.22 Move sign-in lockout and rate limits from process memory to Postgres; #33 1.23 Idempotency-key store for core's public POST routes; #34 1.24 Move the auth service's error codes into the contract; #35 1.25 Invitation email: mail provider, outbox and delivery through the queue; #36 1.26 Reconcile Organizations whose Owner has no account; #38 1.27 Local mail delivery so sign-up and Invitations work in local development; #41 1.28 Browser sessions: a refresh cookie on one origin; #43 1.29 Member profile changes reach core, with an ordering guard; #44 1.30 Detect when a vendored API spec is behind its service; #45 1.31 Keep-alive for the internal client, without losing the proxy guarantee.

Steps with no "after" (1.1, 1.2, 1.3, 1.11) start in parallel.

## Exit criteria

- A new Organization can be created in either Region's configuration, and a second Organization
  cannot read the first one's rows, files or search results (proved by tests in every service).
- A token issued by auth carries Organization and role, and every service rejects a request
  without one.
- An uploaded document, a transcript with a deal outcome and a HubSpot deal each appear in search.
- Search meets its latency budget in the benchmark and in the phase load test.
- Every repo's `bun run verify` is green in CI.

## Decisions still to make in this phase

- Infrastructure-as-code tool (step 1.18).

## Not verified yet

Things nobody has tested against the real thing. Add to this list as steps land.

- `shared/` hooks are tested in the hub (`scripts/hooks.test.ts`), but the Stop gate has not been
  exercised by a real agent session in a service repo.
- If a repo is made private again, its CI needs a `CLOSELINE_REPO_TOKEN` secret to install the
  libraries, and GitHub Actions billing for the organization must be working. Neither has been
  tested: on 2026-10-12 GitHub refused to start jobs while the repos were private.

## Verified on 2026-10-12

- All nine repos are public; `bun run verify` is green in CI in each.
- A ruleset protects `main` and `develop` in each repo: pull request required, `verify / verify`
  required, no deletion, no force-push.
