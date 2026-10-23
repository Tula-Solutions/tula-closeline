# M7 Campaigns and sequences: tickets

References: `M02-T4` Prospect API in core including lists/filters; `M03-T6` the kit's ContactGuard over core's Contact Check (M03-T4); `M09-T3` approvals API (create approval for a Draft, emit reply events).

### T1: Contract for campaigns, sequences and enrollments
Repo: contract
Blocked by: none

## What to build
Schemas, routes, error codes and events for Campaign, Sequence (step union: email, wait, branch, rep task, end), Enrollment (state and stop-reason enum), Variant, Play, audience check and launch check. Tagged.

## Acceptance criteria
- [ ] A Sequence schema rejects cycles without a wait, unreachable steps and branches without a default.
- [ ] Variant weights must sum to 100 with two to four variants.
- [ ] Step kinds are a discriminated union so a new kind is additive.
- [ ] Lists have cursors and a maximum page size; tag cut.

### T2: Schema for campaigns and the engine
Repo: db
Blocked by: T1

## What to build
Migration for `campaigns`, `sequences` (versioned), `steps`, `variants`, `enrollments`, `enrollment_events`, `plays`, `play_citations`, `send_decisions` with an index on (organization, next due time) and the outbound work-hint registry for `step_due`.

## Acceptance criteria
- [ ] Row-level security on every table; isolation test lists them; a second Organization reads zero rows.
- [ ] The work-hint function cannot run inside an Organization scope and returns ids only.
- [ ] An EXPLAIN-based test shows due selection uses the index.
- [ ] Tag cut.

### T3: Campaigns and the Sequence builder model
Repo: outbound
Blocked by: T2, M05-T1

## What to build
Create, read, update, duplicate, archive Campaigns; save Sequences as new versions with graph validation; Campaign states draft, ready, running, paused, archived; role visibility (Rep own, Manager Team, Admin all).

## Acceptance criteria
- [ ] An invalid Sequence returns `campaign.invalid_sequence` with the offending step.
- [ ] Editing a running Campaign's Sequence creates a version that applies to new Steps only.
- [ ] Rep sees only their own Campaigns; Manager their Team's; second-Organization test passes.

### T4: Audience and enrollment with consent and suppression checks
Repo: outbound
Blocked by: T3, M02-T4, M03-T6

## What to build
Resolve an audience from a Prospect list or filter in queued pages, enroll once per Campaign, enforce one active Campaign per Prospect (setting to allow overlap), ask core for the send-permission decision before enrolling, and record refusals with their reason. Audience check route (count, verified, suppressed).

## Acceptance criteria
- [ ] A suppressed or no-consent Prospect ends the Enrollment with `enrollment.suppressed` or `enrollment.no_consent`, visible in the log.
- [ ] Re-running enrollment for the same audience creates no duplicates.
- [ ] Audience of 10,000 resolves without any request holding the whole list.
- [ ] Second-Organization test passes.

### T5: Sequence engine with branching, windows and caps
Repo: outbound
Blocked by: T4, M06-T7

## What to build
The sweep and handler: find Organizations with due Steps, take bounded pages with skip-locked, enqueue idempotent Enrollment-Step messages, re-check state, window, caps and permission, obtain a Draft, apply approval mode (hand to send, M8, or approvals, M09), record a send decision, schedule the next Step, branch on recorded events, stop on reply, bounce, unsubscribe or suppression. Pause and resume; benchmark in `bench/`.

## Acceptance criteria
- [ ] With an injected clock: due Step sends once; retried message does not send twice.
- [ ] Reply, bounce, unsubscribe and added suppression each stop the Enrollment before the next send.
- [ ] Send outside the window defers to the next window; paused sends nothing.
- [ ] Draft that is ungrounded or failing a check goes to approvals even in auto mode.
- [ ] Benchmark budget enforced in `bun run bench`; complexity stated in the PR.
- [ ] Sweep for one Organization never touches another's rows.

### T6: Variants and A/B results
Repo: outbound
Blocked by: T5

## What to build
Two to four weighted variants per email Step, deterministic assignment per Prospect, per-variant stats with an interval and minimum-sample rule, manual winner and optional auto-promotion with logged `variant.promoted`.

## Acceptance criteria
- [ ] Same Prospect, same variant on any retry or restart.
- [ ] Observed split approximates weights on a large synthetic audience.
- [ ] Below the minimum sample the result says `not_enough_data`.
- [ ] Promotion needs the stated sample and margin and writes an audit entry.

### T7: Plays and seeding from the Organization's won Deals
Repo: outbound
Blocked by: T3, M06-T7

## What to build
Built-in plays, and a route that proposes plays for a goal and ICP using Moment and Document search, with Citations and evidence counts; accept, edit or discard; nothing runs until accepted. No evidence yields a clear label.

## Acceptance criteria
- [ ] Every proposed Step cites only items the Playbook returned.
- [ ] With an empty Playbook the response says "no evidence in your history" and offers only built-in plays.
- [ ] Model output that fails the Step schema is discarded.
- [ ] Second-Organization test: citations never include another Organization's items.

### T8: Launch checks
Repo: outbound
Blocked by: T5, M06-T8, M08-T5

## What to build
Launch route that requires a preview of the current Sequence and voice, a healthy mailbox with capacity, and a non-empty audience; returns the launch check.

## Acceptance criteria
- [ ] Refused with `campaign.not_previewed`, `campaign.no_healthy_mailbox` or `campaign.audience_empty` with reasons.
- [ ] Editing the Sequence after preview requires a new preview.
- [ ] `campaign.launched` is emitted once.

### T9: Campaign screens and builder
Repo: portal
Blocked by: T6, T7, T8

## What to build
Campaign list and detail, structured Sequence builder, audience picker, launch check, play library and proposed plays with citations, variant results, per-Prospect activity log and pause/resume.

## Acceptance criteria
- [ ] A Campaign is built, previewed, launched and paused with `agent-browser` against the local stack.
- [ ] Refusal reasons shown in words next to the control.
- [ ] Variant results show "not enough data" text, not an empty chart.
- [ ] Rep, Manager and Admin see the right Campaigns.
- [ ] Keyboard operable builder.
