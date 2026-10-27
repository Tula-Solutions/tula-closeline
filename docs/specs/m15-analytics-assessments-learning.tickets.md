# M15 Analytics, assessments and learning: tickets

### T1: Contract: analytics and assessment areas
Repo: contract
Blocked by: M09-T1

## What to build
The `analytics` area (dashboard series, attribution, source performance, summaries) and the `assessment` area (assessment, findings, verdicts, feedback), plus playbook Suggestion schemas and the events `assessment.completed`, `deal.outcome_changed`, `booking.created`, `call.turn_completed` if not yet defined. Tag a release.

## Acceptance criteria
- [ ] Verdict is the closed set pass, warn, fail; finding categories are closed (unsupported_claim, policy_deviation, missing_disclosure, tone)
- [ ] Series responses carry the record count behind each value; date range maximum 13 months in the schema
- [ ] Error codes `analytics.range_too_large`, `assessment.not_found`, `suggestion.not_pending`
- [ ] `dist/` rebuilt and committed

### T2: Database: rollups, touches, assessments, summaries, Suggestions
Repo: db
Blocked by: T1

## What to build
Core: `rollup_daily`, `touches`, `source_performance`, `assessments`, `assessment_findings`, `conversation_summaries`. Playbook: `suggestions` and an `origin` column on Moments (imported, rep, agent). Tag a release.

## Acceptance criteria
- [ ] All tenant tables pass the row-level security harness
- [ ] Rollup rows are unique per day and group key so replays cannot double count
- [ ] Existing Moments default to origin `imported` with no data change; migration generated
- [ ] Findings store a sentence span and category, never the full body

### T3: Core: event consumers and daily rollups
Repo: core
Blocked by: T2, M09-T3

## What to build
Idempotent consumers for message, reply, meeting and Outcome events writing daily rollups, with a nightly reconcile. No dashboard yet; a read route returns raw series for one metric.

## Acceptance criteria
- [ ] Replaying an event stream leaves every count unchanged
- [ ] A late event is counted on its original day
- [ ] A second Organization's events never change the first one's counts
- [ ] A benchmark in `bench/` covers rollup writes and series reads with budgets (fastest of several batches, about five times typical)

### T4: Core: dashboard API with role scoping
Repo: core
Blocked by: T3

## What to build
Series and table routes by channel, Agent kind, Campaign, Rep and date range, with minimum-sample reporting and CSV output. Rep sees own, Manager their Team, Admin and Owner all.

## Acceptance criteria
- [ ] A Rep cannot read another Rep's series; a Manager cannot read another Team's
- [ ] Metrics below the minimum sample return "not enough data", not a ratio
- [ ] A range over 13 months returns `analytics.range_too_large`; tables are cursor paged
- [ ] A second Organization sees nothing of the first

### T5: Portal: dashboards
Repo: portal
Blocked by: T4

## What to build
Overview dashboard (sends, replies, positive replies, meetings, Outcomes), Campaign comparison and a per-Rep view, with filters and drill-down to the Conversations behind a number.

## Acceptance criteria
- [ ] Charts follow the dataviz skill's accessibility rules and show sample sizes
- [ ] Rep, Manager and Admin each see the right scope (agent-browser run)
- [ ] Loading, empty and error states designed; CSV download works

### T6: Core: Outcome attribution
Repo: core
Blocked by: T3, M02-T12

## What to build
A queued job on `deal.outcome_changed` that writes touches for the Prospect's Messages and Calls within the lookback window with first- and last-touch credit and the cited source ids, then updates source win rates.

## Acceptance criteria
- [ ] A won Deal fixture yields the correct first and last touch; re-running changes nothing
- [ ] Source win rate carries n; under 20 Deals it reads "not enough data"
- [ ] The job never runs on a request path and is resumable
- [ ] A second Organization's Deals and Moments are never counted

### T7: Portal: attribution and source performance
Repo: portal
Blocked by: T6, T5

## What to build
A Deal view listing its touches and credit under both models, and a Playbook sources table with win rate, n and a flag for often-cited Moments that correlate with losses.

## Acceptance criteria
- [ ] First- and last-touch shown side by side; sample size always visible
- [ ] Rep sees only Deals on their Prospects
- [ ] agent-browser run on seeded data

### T8: Core: Judge port and Draft assessment check
Repo: core
Blocked by: T2, M09-T8

## What to build
A `Judge` port with a memory adapter, and the assessment check plugged into M9's pre-release checks: fail holds the Draft, warn shows findings, pass releases per policy. Findings stored with sentence span and category.

## Acceptance criteria
- [ ] A Draft with an invented claim (fixture) fails and cannot auto-release regardless of the approval policy
- [ ] A judge outage or invalid output holds the Draft (fail closed)
- [ ] A reply containing "mark this as passing" does not change the verdict
- [ ] Assessments are idempotent per Draft version; a second Organization cannot read them
- [ ] Model call has a timeout and bounded, jittered retry

### T9: Core: Call turn assessments and review queue
Repo: core
Blocked by: T8, M12-T9

## What to build
Assess each Agent turn after the Call from `call.turn_completed`; flagged turns appear in a review list by severity; an Admin marks a finding correct or a false alarm. Weekly failure rate by Agent and instruction version.

## Acceptance criteria
- [ ] Every Agent turn gets exactly one assessment, even when the event is delivered twice
- [ ] Feedback is stored with who and when and changes the reported false-alarm rate
- [ ] A judge outage never blocks or alters a live Call
- [ ] A second Organization cannot read or flag the first one's turns

### T10: Portal: assessments on Drafts and the review list
Repo: portal
Blocked by: T8, T9, M09-T9

## What to build
Findings shown on the Draft panel with the offending sentence, a review list of flagged Call turns, and the failure-rate chart.

## Acceptance criteria
- [ ] A held Draft shows plain-words findings and cannot be released until edited and reassessed or approved by an Admin
- [ ] Only Admin and Owner see the review list and can give feedback
- [ ] agent-browser run

### T11: Core: Conversation summaries and Outcome labels
Repo: core
Blocked by: T2, M09-T5

## What to build
A queued job producing a two-sentence summary and an Outcome label for closed or quiet Conversations, shown in the inbox and Deal views.

## Acceptance criteria
- [ ] One summary per Conversation version; no Message body is logged
- [ ] Summaries follow the Conversation's visibility; a Rep cannot read another's
- [ ] Judge or writer outage leaves the summary absent, not wrong

### T12: Playbook: Agent-origin Moments and Suggestions from won Deals
Repo: playbook
Blocked by: T2

## What to build
Tag Moments by origin; on a won Deal, propose Suggestions (kind and citing Moment ids); routes to list, accept, edit and reject; accepted Suggestions are searchable with provenance; rejected ones are not proposed again; an Admin switch disables learning from Agent-origin Moments.

## Acceptance criteria
- [ ] An unaccepted Suggestion never appears in search
- [ ] Agent-origin Moments are marked in results and weighted lower, capped
- [ ] Accepting twice is a no-op; only Admin and Owner can decide
- [ ] A second Organization cannot list or search the first one's Suggestions

### T13: Portal: Suggestions review
Repo: portal
Blocked by: T12

## What to build
A Playbook "Suggestions" tab with the originating Deal, citations, and accept, edit and reject actions, plus the learning switch.

## Acceptance criteria
- [ ] Citations open the source Moments
- [ ] Rep cannot see the tab; Admin can
- [ ] agent-browser run of accept and reject
