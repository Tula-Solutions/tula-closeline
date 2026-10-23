Phase: 4 · Repos: hub, contract, db, outbound, portal (calls core's Prospect API, M02) · Parity rows: R2, R3, R4, R5, R6, R7, R8, R11 (R1 deliberately not pursued)

# M5 Enrichment and signals

## Problem Statement

A Prospect an Organization imports or a Rep types in is usually a name and an email address. The Outbound Agent cannot write a good message, or decide whether a Prospect is worth contacting, without a job title, a company, a verified address and a reason to write now. 11x answers this with a claimed 400M-record database of its own, 21+ undisclosed providers and live web search (R1 to R7), and shows no cost and no source for any field. An Organization cannot see where a field came from, what it paid for it, or why a Prospect was rated "high fit" (R11). Closeline has no Prospect data beyond what M2 stores, and must not become a contact database (lead decision, parity analysis section 5).

## Solution

Enrichment is a service of the new `tula-closeline-outbound` service, behind a port. A request to enrich a Prospect runs a **provider waterfall**: an ordered list of providers per field group (person, company, email verification), each asked only for what is still missing and stopping when the field is filled with enough confidence. Every field that comes back carries its provider, time and cost, and is written to the Prospect in core (M02) with that lineage, so M2's "every field shows where it came from" holds. The portal shows the cost per Prospect and per enrichment run, and an Organization-wide monthly budget stops runs when it is spent.

**Signals** are typed events about a Prospect or its company: funding, hiring spike, job change, technology change, website visit, and a Rep-recorded note. They come from provider adapters, from a signed webhook the Organization can call, and from M4 (CRM) later. A fit score explains itself: it is a sum of named, weighted criteria the Organization sets (ICP), and the portal lists which criteria matched. There is no owned database: nothing is kept for an Organization that it did not ask about, and nothing is shared across Organizations.

First adapters (a lead proposal, each needs an ADR before the real key is used): **Apollo** for person and company data and signals, **ZeroBounce** for email verification, **Exa** for live web search (used by M6). Memory adapters ship first and are what every test and `bun run dev` use.

## User Stories

1. As a Rep, I want to select Prospects and enrich them in one click, so that I do not research each one by hand.
2. As a Rep, I want to see each enriched field with the provider that supplied it and when, so that I can judge how far to trust it.
3. As an Admin, I want to see what each Prospect cost to enrich, broken down by provider, so that I can judge value per Prospect.
4. As an Admin, I want a monthly enrichment budget for the Organization, so that a large import cannot run up an unbounded bill.
5. As an Admin, I want runs to stop and say why when the budget is spent, so that nothing fails silently.
6. As an Admin, I want to choose the order of providers for each field group, so that I can try the cheapest first.
7. As an Admin, I want to switch a provider off, so that I can stop using one whose data I distrust.
8. As an Admin, I want to enter my own provider API key per Organization, so that I pay my own contract rate rather than a marked-up one.
9. As a Rep, I want an email address to be verified before any message is sent to it, so that bounces do not damage my mailbox.
10. As a Rep, I want to see "valid", "risky" or "invalid" with a reason on each address, so that I know what will be sent.
11. As a Manager, I want to see how many of my Team's Prospects have a verified address, so that I can fix gaps before a campaign.
12. As an Admin, I want to describe my ideal customer (industry, size, region, title, technology) as named criteria with weights, so that fit is scored the way we sell.
13. As a Rep, I want each Prospect's fit score to list the criteria that matched and missed, so that the score is explainable.
14. As a Manager, I want to sort and filter Prospects by fit score, so that my Reps start with the best ones.
15. As a Rep, I want a timeline of signals on a Prospect (funding, hiring, job change, technology, website visit), so that I know why now is a good time.
16. As a Rep, I want to record a signal by hand, such as "met at the conference", so that the Agent writes with it.
17. As an Admin, I want a signed webhook that records website-visit signals from our own site, so that visits reach Prospects without a vendor tag.
18. As an Admin, I want to choose which signal types matter and how long each stays fresh, so that stale news is not used in a message.
19. As a Rep, I want enrichment to run in the background and show progress, so that a list of two thousand does not block my screen.
20. As a Rep, I want a retry of a run to cost nothing extra, so that a double click does not double the bill.
21. As an Owner, I want enrichment data deleted when I delete a Prospect or the Organization, so that we hold nothing we should not.
22. As a Prospect, I want my data erased when I ask, and the erasure to reach every field copied from a provider, so that my request is honoured.
23. As an Admin, I want to see which fields are from providers and which are from my own import, and never have the import overwritten silently, so that my data stays mine.
24. As an Admin, I want a Rep to be unable to read another Organization's enrichment, so that provider data bought by one customer is never visible to another.
25. As an Admin, I want an enrichment failure at a provider to fall through to the next one with the failure recorded, so that one outage does not stop the run.
26. As a Manager, I want the portal to show provider spend this month against budget, so that I can plan.
27. As an Owner, I want enrichment data export in a standard format, so that I am not locked in (R92).

## Implementation Decisions

**Ownership.** Outbound owns enrichment runs, signals, fit criteria and spend. Core (M02) owns the Prospect record and its per-field lineage; outbound writes enriched fields to core over HTTP typed by the contract, with a source tag `enrichment:<provider>`, and never reads core's schema. Outbound does not keep a copy of the Prospect beyond ids and the data needed to resolve a run.

**Modules (outbound).** `enrichment` (run orchestration, waterfall, budget, spend), `signal` (ingest, freshness, listing), `fit` (criteria, scoring). Router, service and schema per the service layout. Service functions take deps and never import an adapter.

**Ports and adapters.** `EnrichmentProvider` (person/company lookup, returns fields with confidence and cost; memory adapter with scripted fixtures and failures; first real adapter Apollo). `EmailVerifier` (memory; ZeroBounce). Both are ports because each has two implementations from day one. Every call has a timeout and a bounded jittered retry; a provider that fails repeatedly opens a circuit for a short window so the waterfall skips it.

**Waterfall.** Per request: field groups still missing, providers in the Organization's order, stop on first result above the confidence threshold, record every attempt (provider, group, outcome, cost). Cost is stored in integer micro-dollars. A per-run cost ceiling and the Organization's monthly budget are checked before each provider call, not after.

**Work.** A run for one Prospect is a queue message with an idempotency key (Organization, Prospect, request id). A bulk request creates a run set and enqueues per-Prospect messages in bounded batches; nothing proportional to Organization size runs on the request path. Due-work discovery for budget resets and signal expiry uses a work-hint registry like ADR 0017 (an ADR for outbound is needed; see Further Notes).

**Contract areas** (in `tula-closeline-contract`, area `outbound`): `enrichment` (request, run, field provenance, provider config without secrets, budget), `signal` (typed union by kind, freshness, listing with cursor and a maximum page size), `fit` (criteria, score with matches). Error codes: `enrichment.budget_exceeded`, `enrichment.provider_unavailable`, `enrichment.prospect_not_found`, `enrichment.verification_failed`, `signal.invalid`, `fit.invalid_criteria`. Events: `enrichment.completed`, `signal.recorded`, `prospect.fit_changed`.

**Schema (db, schema `outbound`).** `enrichment_runs`, `enrichment_attempts`, `signals`, `fit_criteria`, `provider_settings` (keys stored encrypted, never returned), `enrichment_spend` (per month). Every table carries `organization_id` under fail-closed row-level security and is accessed through the tenant-scoped helper. Migrations come from the db library only.

**Security.** Provider responses and web text are untrusted data: validated against schemas, length-bounded, and never passed to a model as instructions (M6 treats signal text the same way). Provider keys never appear in logs, responses or error reports. Webhook signals are authenticated with a per-Organization signing secret, compared in constant time, and replay-limited by timestamp and id.

**Portal.** An enrichment panel on the Prospect page, a bulk action on the Prospect list, an Enrichment settings page (providers, order, keys, budget, ICP criteria), and a spend view.

## Testing Decisions

- Highest seam: the outbound HTTP routes with the memory adapters, against a real test Postgres as in core and playbook. Assert on responses, stored lineage, recorded cost and emitted events, not on internals.
- Waterfall behaviour is tested through the enrich route with a scripted memory provider: first provider fills person data and stops; first fails and the second fills; none fills and the run ends `incomplete`; the budget stops a run mid-way and records why.
- Idempotency: the same request id twice charges once; a retried queue message does not double-call a provider.
- Cross-Organization isolation: a second Organization cannot read runs, signals, spend or provider settings of the first, by id or by listing, and a signed webhook of one cannot record a signal for the other's Prospect.
- Provider adapters: contract tests against recorded fixtures (no network in `verify`); a separate opt-in live test behind an env flag for the Apollo and ZeroBounce keys.
- Untrusted input: a provider field containing instruction text is stored as data and never changes behaviour; oversized fields are truncated with a recorded flag.
- Portal: the enrichment panel and settings are driven with `agent-browser` in `/run-check`.
- Prior art: playbook's job and sweep tests (work hints), core's idempotency-key tests, the contract's untrusted-input tests.

## Out of Scope

- Any owned or resold contact database, bulk list buying, or phone number lookup.
- Website visitor identification by reverse IP (R5): a webhook for the Organization's own tracking is in; a vendor identification product is later.
- G2 intent (R6): a signal adapter can be added behind the same port after this module.
- Mobile numbers and calling data (Agents may not cold-call, ADR 0003).
- CRM-sourced signals (M4) and Prospect storage (M2).

## Further Notes

**Proposed GLOSSARY terms.**
- **Enrichment**: filling in missing facts about a Prospect from outside providers, with each fact's source and cost recorded. _Avoid_: data append, data cleansing, lookup
- **Signal**: a dated, typed event about a Prospect or its company that gives a reason to contact them now. _Avoid_: trigger, intent data, buying signal
- **Fit score**: a number from the Organization's own named criteria saying how closely a Prospect matches its ideal customer, with the matched criteria listed. _Avoid_: lead score, rating, grade

**ADRs needed.** (1) Enrichment vendors: Apollo, ZeroBounce, Exa, and how Organization-supplied keys are stored (no ADR exists). (2) The `outbound` service's background-work discovery (extends ADR 0017 to a second schema). (3) How secrets at rest are encrypted before an infra KMS exists (also needed by M8).

**11x rows reached.** R2 and R3 (providers, web search), R4 (verification), R5 partly (own-site visits), R6 later, R7 (signals), R8 (CRM sources arrive with M4), R11 (fit). Beyond 11x: per-field provenance, per-Prospect cost, an Organization budget, own keys.

**Dependencies.** Prospect API (M02), a vector-free design (no Playbook use here). The first ticket of this module creates the `outbound` repository for all of M5 to M8.
