# M5 Enrichment and signals: tickets

References: `M02-T2` is the `prospect` contract area and `M02-T4` the Prospect API in core (create, read, patch with per-field source).

### T1: Create the outbound service repository
Repo: hub
Blocked by: none

## What to build
The `tula-closeline-outbound` repository, created from `templates/service` with `scripts/new-repo.sh`, labelled `outbound`, with the shared setup synced, CI calling the hub workflow, a health route, `env.ts`, an empty container, and the repo added to `bun run dev` and the sync list. M5 to M8 build in it.

## Acceptance criteria
- [ ] `bun run verify` is green in the new repo and in the hub.
- [ ] `bun run sync:check` shows no drift for the new repo.
- [ ] `bun run dev` starts the service and `/health` answers.
- [ ] The `outbound` label exists and `AGENTS.md` of the repo names its hot paths as none yet.

### T2: Contract for enrichment, signals and fit
Repo: contract
Blocked by: none

## What to build
The `outbound` area with schemas, types, routes and error codes for enrichment requests and runs (with field provenance and cost), provider settings (secret never returned), budget, signals (a union by kind) and fit criteria and scores; the three events. Lists carry a cursor and a maximum page size. Tagged for consumers.

## Acceptance criteria
- [ ] Each schema has parse tests for valid, unknown-field and oversized input.
- [ ] Error codes use `area.reason` and are listed in the code table.
- [ ] Provider settings response type has no key field.
- [ ] Version bumped, `dist/` rebuilt, tag cut.

### T3: Schema for enrichment, signals and spend
Repo: db
Blocked by: T2

## What to build
The `outbound` schema with `enrichment_runs`, `enrichment_attempts`, `signals`, `fit_criteria`, `provider_settings` (encrypted key column) and `enrichment_spend`, one migration, typed schema exports, and the work-hint registry for the schema if ADR for outbound hints exists.

## Acceptance criteria
- [ ] Every table has `organization_id` with fail-closed row-level security; the isolation test lists them.
- [ ] A second Organization's scope reads zero rows from each table.
- [ ] Indexes support cursor listing of signals by Prospect and runs by time.
- [ ] Tag cut.

### T4: Enrich a Prospect through a waterfall (memory providers)
Repo: outbound
Blocked by: T1, T3, M02-T4

## What to build
`POST` to enrich one Prospect or a bounded set: the waterfall over the `EnrichmentProvider` and `EmailVerifier` ports with memory adapters, per-attempt recording, cost in micro-dollars, a per-run ceiling and the monthly budget checked before each call, queue-driven execution with idempotency, and write-back of fields to core with `enrichment:<provider>` lineage. `GET` of a run and a cursor-paged list.

## Acceptance criteria
- [ ] First provider fills and stops; failure falls through; none fills ends `incomplete`.
- [ ] Budget exhaustion stops the run with `enrichment.budget_exceeded` and no further provider call.
- [ ] Same request id twice charges once.
- [ ] Core receives each field with its provider as source; an Organization's own imported field is not overwritten.
- [ ] A second Organization cannot read the first's runs or spend.

### T5: Apollo, ZeroBounce adapters and provider settings
Repo: outbound
Blocked by: T4

## What to build
Real adapters for Apollo (person, company) and ZeroBounce (verification) with timeouts, bounded jittered retry and a circuit; routes to set provider order, enable or disable a provider and store an Organization's own key (write-only).

## Acceptance criteria
- [ ] Fixture-based contract tests pass with no network in `verify`.
- [ ] An opt-in live test runs when keys are in the environment.
- [ ] A key never appears in a response, log line or error report (test scans them).
- [ ] A disabled provider is never called; a failing one is skipped after the circuit opens.
- [ ] Second-Organization test: its key and order are not visible or used by the first.

### T6: Signals and fit score
Repo: outbound
Blocked by: T4

## What to build
Record signals by hand, from a provider adapter and from a signed webhook; list them for a Prospect with a cursor; freshness per kind; Organization fit criteria with weights; a score that lists matched and missed criteria and emits `prospect.fit_changed`.

## Acceptance criteria
- [ ] Webhook with a bad signature, an old timestamp or a replayed id is refused with no record.
- [ ] Expired signals are excluded from the default listing.
- [ ] Score equals the sum of matched weights and the response lists each criterion's result.
- [ ] Signal text containing instructions is stored and returned as data only.
- [ ] A second Organization's webhook secret cannot record a signal for the first's Prospect.

### T7: Enrichment and ICP screens
Repo: portal
Blocked by: T5, T6

## What to build
The enrichment panel on the Prospect page (fields with provider and time, verification state, cost, signal timeline, fit explanation), a bulk Enrich action with progress, and a settings page for providers, order, keys, budget and fit criteria with a spend view.

## Acceptance criteria
- [ ] A Rep enriches a Prospect and sees provenance and cost without reloading.
- [ ] Budget exhaustion shows the reason, not a generic error.
- [ ] Keys are masked after saving; only Owner and Admin see the settings page.
- [ ] Driven end to end with `agent-browser` against the local stack.
- [ ] Keyboard-only use works for the panel and the settings forms.
