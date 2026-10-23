Phase: 4 · Repos: contract, db, outbound, portal · Parity rows: R9, R10, R27, R28, R30, R31, R32 (R29 shared with M8, R69 and R70 shared with M9)

# M7 Campaigns and sequences

## Problem Statement

11x's Sequence Builder offers steps, timing and branching on opens, clicks and replies, a play library, and an unspecified experimentation play (R27 to R32). It says nothing public about how a customer knows a play is any good: plays are 11x's, not learned from the customer's history, and A/B testing is barely mentioned (R30). Closeline has no way to run outreach at all. An Organization needs to turn "talk to these Prospects about this" into a controlled series of messages that stops the moment a Prospect replies, unsubscribes, bounces or is suppressed, that never exceeds a send limit, and that can be tested before and while it runs.

## Solution

The Outbound Agent runs **Campaigns** in the `outbound` service. A Campaign has an audience of Prospects (from M2 lists or filters), a **Sequence** of Steps, a Brand Voice and language (M6), sending rules (send windows, daily cap, time zone), and an approval mode: **auto** (the Agent sends grounded drafts that pass all checks), **review** (every draft waits in the approvals inbox, M09) or **mixed** (auto for grounded drafts, review for the rest).

A Sequence is an ordered graph of Steps: an email Step (goal, wait, variants), a wait, a branch (replied, bounced, unsubscribed, opened, clicked, no response after N days), a manual task for a Rep (for example "call", since the Agent cannot cold-call, ADR 0003) and an end. The step kinds are extensible, so LinkedIn (M11) and later channels add kinds without changing the engine. Phase 4 ships the email Step only plus waits, branches and Rep tasks.

**Enrollment.** A Prospect is enrolled once per Campaign and in at most one active Campaign at a time unless the Admin allows overlap. Before enrolling, and again before each send, the engine asks core (M03) whether the Prospect is suppressed or lacks the consent the channel needs. A refusal ends the Enrollment with a recorded reason; it is never skipped silently and no setting overrides it.

**Plays.** A Play is a reusable Sequence with an intent (cold intro, closed-lost re-engagement, post-event follow-up, nurture). The Organization starts from built-in plays, and from **seeded plays**: the service asks the Playbook which approaches appear in the Organization's won Deals (Moment and Document search against the ICP and a stated goal) and proposes Steps and angles with their Citations and evidence counts, so the Admin sees "this angle appears in 14 won Deals". The Admin edits and accepts; nothing starts without a person accepting.

**A/B built in.** Any email Step can have two to four variants with fixed weights. Assignment is deterministic by Prospect, so a retry never flips a variant. The portal shows per variant: sent, delivered, replied, positive reply (from M9 classification once it exists), bounced, unsubscribed, with an interval, and says "not enough data" until a minimum sample. The Admin picks a winner by hand, or enables auto-promotion with a minimum sample and margin; the change is logged.

**Launch.** A Campaign can launch only after a preview (M6) of the current Sequence and voice, at least one connected, healthy mailbox with capacity (M8), and a passing audience check (count, how many have verified addresses, how many suppressed). The engine is queue-driven; due Steps are found with the outbound work-hint registry, not by scanning all Enrollments.

## User Stories

1. As an Admin, I want to create a Campaign with a name, an audience and a goal, so that the Agent knows who to write to and why.
2. As a Rep, I want to build a Campaign from a Prospect list I already have, so that I do not re-enter anyone.
3. As an Admin, I want to design a Sequence as steps with waits and branches, so that timing and follow-ups match how we sell.
4. As an Admin, I want a Sequence to stop for a Prospect the moment they reply, so that the Agent never writes over a conversation.
5. As an Admin, I want a Sequence to stop on bounce, unsubscribe or suppression, so that no further message goes out.
6. As an Admin, I want a Step where a Rep must do something by hand, such as a call, so that the Agent hands over where I want a person.
7. As an Admin, I want send windows (days, hours, time zone of the Prospect or of the Campaign), so that messages arrive at sensible times.
8. As an Admin, I want a daily cap per Campaign in addition to mailbox limits, so that I control the pace.
9. As an Admin, I want to choose auto, review or mixed approval for a Campaign, so that I decide how much the Agent does alone.
10. As an Admin, I want ungrounded or check-failing drafts to wait for review even in auto mode, so that weak messages are not sent unseen.
11. As an Admin, I want to preview the Campaign on sample Prospects before I can launch it, so that I have seen real output.
12. As an Admin, I want a launch check showing audience size, verified addresses, suppressed Prospects and mailbox capacity, so that I know what will happen.
13. As an Admin, I want a launch to be refused with the reason when no healthy mailbox exists, so that nothing is queued to fail.
14. As a Rep, I want to pause and resume a Campaign, so that I can react to news without losing place.
15. As a Rep, I want to remove one Prospect from a Campaign, so that I can handle a special case by hand.
16. As an Admin, I want a Prospect to be in only one active Campaign unless I allow overlap, so that nobody gets two sequences at once.
17. As an Admin, I want a Prospect with no Contact Consent or a suppression entry to be refused with a visible reason, so that I can see why they were skipped.
18. As an Admin, I want to start from a built-in play, so that I am not facing an empty page.
19. As an Admin, I want a proposed play built from our won Deals, with the angle, the evidence count and the cited Moments, so that I start from what has worked for us.
20. As an Admin, I want to accept, edit or discard a proposed play, so that nothing runs without my decision.
21. As an Admin, I want to test two to four variants of an email Step, so that I learn what works.
22. As a Rep, I want a Prospect to always get the same variant on a retry, so that a test is not spoiled.
23. As a Manager, I want per-variant results with an interval and a "not enough data" message, so that I do not call a winner too early.
24. As an Admin, I want to pick a winning variant, or enable promotion after a stated sample and margin, so that learning is applied on my terms.
25. As a Manager, I want to see per Campaign: enrolled, active, replied, positive, meetings, bounced, unsubscribed and stopped, so that I can judge it.
26. As a Manager, I want to see a Prospect's activity log in a Campaign (each Step, draft, send, reply, stop reason), so that I can answer "what happened with this person".
27. As an Admin, I want every send decision (sent, held, refused and why) in an audit trail, so that I can show it to a customer or regulator.
28. As an Admin, I want Campaigns of one Team visible to its Manager and to Admins, and a Rep to see their own, so that visibility follows roles.
29. As an Owner, I want to archive a Campaign and still keep its history, so that results are not lost.
30. As an Admin, I want to duplicate a Campaign, so that a good setup is reused.
31. As a Prospect, I want to get at most the messages the Sequence says and none after I reply or opt out, so that I am not pestered.

## Implementation Decisions

**Ownership.** Outbound owns Campaigns, Sequences, Steps, Enrollments, Plays, Variants and the engine. Core owns Prospects (M02) and suppression and consent (M03); outbound asks core for a decision over HTTP typed by the contract and records the answer on the Enrollment event. Playbook is read through its search routes. M6 produces Drafts; M8 sends; M9 owns replies, which tell the engine to stop.

**Modules (outbound).** `campaign` (CRUD, state machine: draft, ready, running, paused, archived), `sequence` (graph validation, step kinds), `enrollment` (audience resolution, once-only rules, state and stop reasons), `engine` (due-step execution), `variant` (assignment, stats, promotion), `play` (built-ins, seeding from the Playbook), `audit` (send-decision log). The engine is the hot path of this repository.

**Engine design.** An Enrollment has a current Step and a `next_due_at`. A work hint per Organization marks when work is due (ADR needed). A sweep takes Organizations with due work, then for each takes a bounded page of due Enrollments with `FOR UPDATE SKIP LOCKED`, and enqueues one message per Enrollment-Step with an idempotency key of (Enrollment, Step, attempt epoch). A handler: re-checks Campaign state, send window, caps and suppression/consent; asks M6 for the Draft; applies approval mode (send via M8 or create an approval via M09); records the decision; schedules the next Step. Nothing is held in process memory; any instance can stop at any time. A crash between "sent" and "recorded" is resolved by M8's send idempotency key.

**Expected complexity.** One sweep tick is O(due work in a page), bounded by a page size; cost per Enrollment-Step is O(1) queries plus one model call and one search. A benchmark in `bench/` (budget set at about five times the measured median of several batches after warm-up) covers selecting 10,000 due Enrollments among 1,000,000 across 100 Organizations, and branch evaluation of a 30-Step Sequence.

**Branching.** Branch conditions read recorded events (reply, bounce, unsubscribe, open, click) or elapsed time. Opens and clicks are weak signals (image blocking, link scanners); the portal says so, and the default branches use reply and time. Open tracking is off by default and is an explicit Organization setting.

**Contract areas** (`outbound`): `campaign`, `sequence` (step union), `enrollment` (state, stop reason enum), `variant`, `play`, `audience` (count and check), `launch-check`. Error codes: `campaign.invalid_sequence`, `campaign.not_previewed`, `campaign.no_healthy_mailbox`, `campaign.audience_empty`, `enrollment.suppressed`, `enrollment.no_consent`, `enrollment.already_active`, `variant.invalid_weights`, `play.no_evidence`. Events: `campaign.launched`, `enrollment.stopped`, `step.sent`, `variant.promoted`. Lists use cursors with a maximum page size; audiences are resolved in pages through a queue, never on the request path.

**Schema (db, `outbound`).** `campaigns`, `sequences` (versioned), `steps`, `variants`, `enrollments`, `enrollment_events`, `plays`, `play_citations`, `send_decisions`. Row-level security throughout; indexes on (organization, `next_due_at`) for due selection.

**Seeding plays.** The `play` module issues bounded Moment and Document searches for the stated goal and ICP, and the model (M6 port) summarises the approaches as candidate Steps; every candidate carries Citations and the Playbook's evidence counts, and a candidate with no won-Deal evidence is labelled "no evidence in your history". Model output is validated against the Step schema; a candidate that fails is discarded.

**Portal.** Campaign list and detail, a Sequence builder (a step list with branches shown as indented paths; not a free canvas in the first version), audience picker, launch check, variant results, per-Prospect activity log, plays library with proposed plays.

## Testing Decisions

- Highest seam: the outbound HTTP routes plus the queue consumer, driven by an injectable clock, with memory adapters for Model, mail transport (M8), consent/suppression client and Playbook client, on a real test Postgres.
- Engine behaviour through the clock: a due Step sends once; a reply event before the due time stops the Enrollment; a suppression added after enrollment stops the next send; a retried message does not send twice; a paused Campaign sends nothing; sending outside the window is deferred to the next window.
- Isolation: a second Organization cannot list, read, enroll into, pause or see the audit of the first's Campaigns, and the sweep for one never selects the other's Enrollments.
- Variants: assignment is stable across retries; weights are respected over a large synthetic audience within tolerance; stats show "not enough data" below the minimum sample.
- Plays: a seeded candidate cites only items the Playbook search returned; with an empty Playbook the result says no evidence.
- Launch: refused without preview, without a healthy mailbox, with an empty audience.
- Benchmark: `bench/` due-selection and branch evaluation with budgets as above; part of `bun run verify`.
- Prior art: playbook sweep and work-hint tests, core invitation limit tests, kit queue consumer tests.

## Out of Scope

- LinkedIn, SMS, WhatsApp and phone Steps (M11, M14, ADR 0003/0004); the Rep task Step is the only non-email Step.
- A free-form drag-and-drop canvas; the first builder is a structured list.
- Reply handling, approvals inbox and classification (M9); this module only consumes their events.
- Meeting booking and routing (M10).
- Account-based multi-threading across several Prospects of one company.
- Cross-Campaign learning dashboards (M15).

## Further Notes

**Proposed GLOSSARY terms.**
- **Campaign**: a run of the Outbound Agent that contacts a chosen set of Prospects through one Sequence. _Avoid_: blast, drip, outreach project
- **Sequence**: the ordered Steps, waits and branches the Outbound Agent follows for each Prospect in a Campaign. _Avoid_: cadence, flow, sequencer
- **Step**: one action in a Sequence, such as an email or a task for a Rep. _Avoid_: touch, node
- **Enrollment**: a Prospect's place in one Campaign, with its current Step and how it ended. _Avoid_: assignment, membership (taken)
- **Play**: a reusable Sequence for a stated goal, built in or proposed from an Organization's won Deals. _Avoid_: template, playbook (taken)
- **Variant**: one of two to four versions of a Step compared against each other. _Avoid_: test, split

**ADRs needed.** Outbound background work discovery (extends ADR 0017); the rule that a Prospect is in one active Campaign by default; the choice of default branch signals and open tracking off by default; seeded plays and their evidence labelling.

**11x rows reached.** R9 and R10 (audience and strategy help via proposed plays), R27, R28, R30 (A/B, which 11x lacks), R31 (plays), R32 (event follow-up plays are built-in plays whose audiences come from a Prospect list; registration data arrives with M4). R69 and R70 in M9; R29 with M8.

**Dependencies.** M02 (Prospect lists), M03 (decision API), M06, M08, M09 (approval and reply events).
