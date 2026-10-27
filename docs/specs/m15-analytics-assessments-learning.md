Phase: 5 · Repos: contract, db, core, playbook, portal · Parity rows: R68, R73, R74, R75, R76 (and R67 by learning from Outcomes)

## Problem Statement

Once Agents and Reps sell, an Organization has to know what is working, whether the Agents are behaving, and how to improve. Today there are no numbers on replies, meetings or Outcomes, nobody can say which message or Moment a won Deal came from, no one checks what an Agent said for invented facts or rule breaks, and the Playbook only learns from history someone imports by hand. 11x has dashboards, hallucination and deviation assessments, and conversation summaries (R68, R73 to R76), but no evidence that its knowledge learns from the customer's own won and lost Deals (R67).

## Solution

Four connected pieces. (1) **Dashboards** in the portal: replies, positive replies, meetings, Outcomes, per-Campaign comparison and per-Rep views, served from daily rollups fed by events, so a request never scans an Organization's history. (2) **Attribution**: every Deal Outcome is traced back to the Messages and Calls that touched the Prospect, with first-touch and last-touch credit, and to the Playbook Moments and Documents those Messages cited, giving each source a win rate with its sample size. (3) **Assessments**: every Agent turn (a Draft before release, a Call turn after it) is judged for unsupported claims, policy deviation and missing disclosure; a failed Draft is held, a flagged Call turn goes to review. (4) **Learning**: Conversations and Calls that end in a won Deal become Moments tagged as Agent- or Rep-authored, and a win review proposes **Suggestions** (an objection answer that worked, a question worth asking) that an Admin accepts before they influence any Agent. Each Conversation also gets a short summary and an Outcome label.

## User Stories

1. As a Manager, I want a dashboard of sends, replies, positive replies and meetings by week, so that I see how outreach performs.
2. As an Admin, I want to compare Campaigns side by side on reply rate and meetings, so that I stop what does not work.
3. As a Rep, I want my own numbers and nobody else's, so that I can see my progress.
4. As a Manager, I want numbers for the Reps on my Team, so that I can coach.
5. As an Admin, I want a filter by channel, Agent or Rep, and date range, so that I can isolate a cause.
6. As an Admin, I want a metric to say how many records it is based on and say "not enough data" below a minimum, so that I am not misled by small samples.
7. As a Manager, I want to open a number and see the Conversations behind it, so that I can check it.
8. As an Admin, I want each won or lost Deal to show the Messages and Calls that led to it, so that I know what worked.
9. As an Admin, I want first-touch and last-touch credit shown side by side, so that I choose the model that suits us.
10. As an Admin, I want each Moment and Document passage the Agents cited to show a win rate and how many Deals that is based on, so that I know which knowledge earns its place.
11. As an Admin, I want to see Moments that are cited often but correlate with losses, so that I can retire them.
12. As a Rep, I want a two-sentence summary and an Outcome label on every Conversation, so that I catch up fast.
13. As an Admin, I want every Agent Draft checked for claims the cited sources and Playbook do not support, so that the Agent does not invent facts.
14. As an Admin, I want every Agent Draft checked against my Agent instructions and our fixed rules, so that deviations are caught before they are sent.
15. As an Admin, I want a Draft that fails a check held for a person and shown with the failing finding, so that it never auto-sends.
16. As a Rep, I want to see why a Draft was flagged in plain words, with the offending sentence, so that I can fix it.
17. As a Manager, I want every Call turn by an Agent assessed afterwards, so that problems on a Call are found.
18. As an Admin, I want a list of flagged turns with severity, so that I review the worst first.
19. As an Admin, I want to mark a finding as correct or a false alarm, so that the checks can be measured.
20. As an Admin, I want a weekly rate of failed assessments by Agent and by instruction version, so that I see whether a change helped.
21. As an Admin, I want won Deals to turn into proposed Playbook Suggestions, so that the Playbook improves from what works.
22. As an Admin, I want to accept, edit or reject each Suggestion, so that nothing reaches the Agents without a person.
23. As an Admin, I want Moments authored by Agents to be marked as such in search, so that Agents do not learn only from themselves.
24. As an Owner, I want accepted Suggestions to be traceable to the Deal and Moments they came from, so that I can audit the Playbook.
25. As an Admin, I want to disable learning from Agent-authored Moments, so that I control the loop.
26. As a Prospect, I want my messages used in analytics only as counts and labels, never exposed to other Organizations, so that my words stay private.
27. As an Admin, I want reports to load quickly however large the Organization, so that I use them daily.
28. As a Manager, I want to export a dashboard table as CSV, so that I can share it.

## Implementation Decisions

**Ownership.** Core owns the analytics read model and assessments: it already holds Prospects, Conversations and Drafts (M2, M9) and metering, and services may not read each other's schemas, so analytics is built from events. Playbook owns Suggestions and the tagging of Moments by origin, since it owns Moments. No new service; a split is a later decision if rollup load demands it.

**Events consumed.** `message.sent`, `reply.classified`, `booking.created` (M10), `deal.outcome_changed` (playbook, CRM), `voice.call.ended` (voice), `draft.created`, `assessment.completed`. Consumers are idempotent by event id. Payloads carry ids and labels only, never bodies.

**Rollups.** Tables of per-day counts keyed by Organization, channel, Agent kind, Campaign, Rep and label. Dashboards read rollups only: bounded date ranges, cursor-paged tables, a maximum range of 13 months. Late events update the right day. A nightly job reconciles against sources and logs drift. Hot path: dashboard reads; complexity O(days x groups), with a benchmark and budget.

**Attribution.** On `deal.outcome_changed`, a job (queued, never on a request) walks the Prospect's Messages and Calls from the first touch in the lookback window (default 180 days) and writes touch rows with first- and last-touch credit and the cited source ids of each touch. Source win rate = won Deals among Deals touched by that source, shown only with n of at least 20. Linking Deals to Prospects relies on M2 and the CRM sync (M4).

**Assessments.** A `Judge` port (memory adapter; first adapter Claude on Amazon Bedrock, same decision record as M9). Inputs: the Draft or turn text as fenced data, its cited sources, the active Agent instructions (M16) and the fixed rules (disclosure, consent). Output, validated against a schema: verdict (pass, warn, fail), findings with category (unsupported_claim, policy_deviation, missing_disclosure, tone), the sentence span and a short explanation. Drafts run the judge as an M9 check before release: fail holds the Draft, always. Call turns are judged after the fact from `call.turn_completed` and flagged for review. Judge output is untrusted data and is never executed; a judge outage holds Drafts (fail closed) and does not block Calls.

**Summaries.** A summary and Outcome label per closed or quiet Conversation, generated from the queue by the same model port, stored separately from Message bodies.

**Learning.** Playbook adds an `origin` (imported, rep, agent) to Moments and a Suggestions store: on a won Deal, a queued job proposes candidate Suggestions (kind: objection answer, discovery question, closing move) citing Moment ids. Accepted Suggestions are indexed for search with their provenance; rejected ones are kept so they are not proposed again. The Agent-origin weighting is lower and capped.

**Contract areas.** New `analytics` area (dashboard series, attribution, source performance, summaries) and `assessment` area (assessments, findings, feedback), plus playbook routes for Suggestions. Schema: core `rollup_daily`, `touches`, `source_performance`, `assessments`, `assessment_findings`, `conversation_summaries`; playbook `suggestions`. All carry `organization_id` with row-level security.

**Roles.** Rep: own rows. Manager: own Team's Reps. Admin and Owner: all. Applied in the service.

## Testing Decisions

Highest seam: HTTP routes with memory adapters and the fixed clock; events fed through the memory queue. Behaviours: replaying the same events leaves counts unchanged; a late event lands on the correct day; a Rep sees only their numbers; a source with fewer than 20 Deals reports "not enough data"; a won Deal yields first- and last-touch credit pointing to the right Messages; a Draft with an invented claim (fixture) fails and cannot auto-release; a judge outage holds the Draft; a prompt-injection fixture inside a reply cannot make the judge pass a bad Draft; Suggestions need acceptance before they appear in search; Agent-origin Moments are marked. Cross-Organization test: a second Organization sees no rollups, touches, assessments, Suggestions or source rates of the first, and its events never change the first one's counts. Prior art: playbook sales-history tests for Deal data, kit queue suite for idempotent consumers, bench suites in playbook for budgets. Portal via agent-browser with seeded events.

## Out of Scope

Revenue forecasting, CRM pipeline reports beyond Outcome, custom report builders, scheduled email reports, BI export, real-time sub-minute dashboards, automatic Playbook changes without an Admin, fine-tuning models (the Playbook's fine-tuning is its own work), and assessments of Rep-written messages.

## Further Notes

New GLOSSARY terms proposed:

- **Attribution**: the link from a Deal's Outcome back to the Messages, Calls and Playbook sources that touched it. _Avoid_: Tracking, credit (alone).
- **Assessment**: an automatic check of one Agent turn for unsupported claims, rule breaks and missing disclosure. _Avoid_: Evaluation, QA score.
- **Suggestion**: a proposed Playbook addition derived from a won Deal, active only after an Admin accepts it. _Avoid_: Recommendation, insight.

ADRs needed: the model vendor (shared with M9; none yet); "analytics is a core read model built from events" and the rollup retention period; the Agent-origin Moment weighting rule. 11x rows reached: R68, R73, R74, R75, R76. Open: attribution lookback default (180 days) and the minimum sample (20) are proposals to confirm.
