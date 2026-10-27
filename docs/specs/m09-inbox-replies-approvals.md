Phase: 3 (chat, Calls as read-only entries) and 4 (email replies) · Repos: contract, db, core, playbook, portal, hub · Parity rows: R33, R34, R35, R36, R37, R69 (and R67 by citation)

## Problem Statement

Once an Agent sells, Prospects answer. Today nothing receives those answers, nothing says what a reply means, and nobody can see or steer what the Agent says next. Reps need one place to see every Conversation they own, whether an Agent or a person is writing, on every channel. Admins need to trust what goes out: every Agent draft must show why it was written and which Playbook sources it used, and be approvable before it is sent. When a Prospect wants a person, the Rep must take over in one click and the Agent must stop. 11x classifies replies, handles objections and escalates (R33 to R35), but shows approval only as thresholds (R37, R69) and no evidence for its wording (R67).

## Solution

One **inbox** in the portal over a new **Conversation** model owned by core. Channel services (outbound for email and LinkedIn, the Inbound Agent for chat) post every inbound and outbound **Message** to core through an idempotent internal call and consume `message.approved` events to send. Core classifies each inbound Message (positive, question, objection, not now, wrong person, unsubscribe, out of office, bounce, negative, other), and for objections and questions asks the Playbook for similar Moments from won Deals and writes a **Draft** grounded in them. Each Draft carries a structured reason and its cited sources with their Outcome and evidence count. An **approval policy** decides whether a Draft goes to the **approval queue** or is released automatically; the default is that everything waits for a person. A Rep takes over a Conversation in one click, which voids pending Drafts and pauses the Agent until the Rep hands it back. Escalation rules route Conversations that need a person to the right Rep and notify them. Visibility follows roles: a Rep sees their own, a Manager their Team's, an Admin all.

## User Stories

1. As a Rep, I want one inbox listing my Conversations across email, LinkedIn and chat, so that I do not check three tools.
2. As a Rep, I want each Conversation to show who is writing now (the Agent or me), so that I never answer over the Agent.
3. As a Rep, I want to filter by channel, state and classification, so that I handle positive replies first.
4. As a Rep, I want to see only Conversations I own, so that other Reps' Prospects stay private.
5. As a Manager, I want to see the Conversations of the Reps on my Team, so that I can coach and step in.
6. As an Admin, I want to see every Conversation in the Organization, so that nothing is lost when a Rep is away.
7. As a Rep, I want every inbound reply labelled with what it means (positive, objection, question, not now, wrong person, unsubscribe, out of office, bounce), so that I know what it needs at a glance.
8. As a Rep, I want to correct a wrong label, so that the mistake is recorded and does not mislead reports.
9. As an Admin, I want an unsubscribe reply to stop all further sends to that Prospect on that channel at once, so that we obey the Prospect's request.
10. As an Admin, I want a bounce or wrong-person reply to pause the sequence for that Prospect, so that the Agent does not keep writing to a dead address.
11. As a Rep, I want an Agent Draft for an objection that is written from what won in similar Moments, so that the answer rests on our own history.
12. As a Rep, I want each Draft to say why it was written (the reply it answers, its label, the strategy), so that I can judge it in seconds.
13. As a Rep, I want each Draft to list its cited sources with the Deal Outcome and how many Moments support them, so that I can check the evidence.
14. As a Rep, I want to open a cited source and read the Moment or Document passage, so that I can see what the Agent relied on.
15. As a Manager, I want a Draft with no sources to be marked ungrounded and always held for approval, so that unsupported claims do not go out.
16. As a Rep, I want to edit a Draft before approving it, so that the final words are mine.
17. As a Rep, I want to approve, edit and approve, or reject a Draft with a short note, so that the Agent can learn what I refused.
18. As an Admin, I want a queue of Drafts waiting for approval, oldest first, with who can approve each, so that nothing sits unseen.
19. As an Admin, I want to set whether Drafts need approval always, or only below a confidence level, or never for named classifications, so that I trade speed against risk.
20. As an Admin, I want the system to refuse to release automatically any Draft that failed a check, so that a setting cannot send known-bad text.
21. As a Rep, I want to take over a Conversation with one click, so that I can answer a Prospect myself.
22. As a Rep, I want taking over to cancel the Agent's pending Drafts and stop its follow-ups, so that the Prospect hears from one voice.
23. As a Rep, I want to hand the Conversation back to the Agent, so that I do not babysit routine replies.
24. As a Rep, I want the full history, labels and cited sources visible when I take over, so that I never ask the Prospect to repeat anything.
25. As a Rep, I want to be notified when a Conversation is escalated to me, so that a hot Prospect does not wait.
26. As an Admin, I want escalation rules (asks for a person, pricing or legal topics, angry tone, low confidence), so that the Agent hands over what it should not handle.
27. As an Admin, I want an escalation with no matching Rep to go to the Admin queue, so that it is never dropped.
28. As a Rep, I want to reply myself from the inbox and have it sent through the Conversation's channel, so that I never copy text between tools.
29. As an Admin, I want every approval, rejection, edit, takeover and hand-back recorded with who and when, so that I can review decisions later.
30. As a Prospect, I want my unsubscribe or "stop" to be honoured immediately, so that I am not contacted again.
31. As an Admin, I want Message text kept out of logs and error reports, so that a Prospect's words never leak.
32. As an Admin, I want text from Prospects treated as data, never as orders, so that a reply saying "ignore your rules" changes nothing.

## Implementation Decisions

**Ownership.** Core owns the inbox. Visibility depends on Teams and roles, which core already holds in its schema, and services never read another service's schema (ADR 0007). Putting it in outbound would also delay chat (phase 3) until outbound exists (phase 4). Channel services are senders and receivers only. The classifier and writer are core modules behind ports; grounding calls the playbook service over the internal client (ADR 0013).

**Modules (core).** `conversation` (list, read, state machine, visibility), `message` (idempotent ingest, outbound release), `classification` (port `ReplyClassifier`: memory adapter, first real adapter Claude on Amazon Bedrock), `draft` (port `ReplyWriter`, same adapters; grounding; citation validation), `approval` (queue, decisions, policy), `takeover`, `escalation`. A small `checks` list runs on each Draft before release so M15 can add its assessment as one more check without changing the flow.

**Conversation model.** One Conversation per Prospect per channel per sequence context, with `controller` (agent or rep), `state` (agent, awaiting_approval, rep, escalated, closed), `owner` (a Membership), channel (email, linkedin, chat; extensible to sms and whatsapp), and the Prospect id from M02. Messages are append-only: direction, author kind (prospect, agent, rep), provider message id, body, sent time. Call entries (kind `call`) are reserved; M12 and M14 add them later.

**Ingest contract.** `POST /internal/messages` takes channel, provider message id, Prospect id, direction and body, and is idempotent on channel plus provider id. Outbound sends are released by event `message.approved` carrying the Draft id as the idempotency key; the channel service answers with `message.sent` or `message.failed`. Core never calls a vendor.

**Classification.** Output is validated against the closed label set with a confidence from 0 to 1; anything else becomes `other`. Labels `unsubscribe` and `bounce` publish `reply.classified`, which M03 consumes to add suppression and M07 consumes to stop the sequence; core also records the Prospect's request even if M03 is slow. The model sees the Message inside a fenced data block and cannot call tools.

**Drafts.** Fields: body, reason (trigger Message, label, strategy in one sentence, instruction version when M16 exists), sources (kind moment or document chunk, id, Outcome, evidence count), confidence, checks, status (pending, approved, rejected, sent, superseded, void). Every cited source id must be in the set the Playbook returned for this request; the rest are dropped, and a Draft left with no sources is marked ungrounded and forced to approval. The playbook service gains a batch "resolve sources" read that returns passages with Outcome and evidence count for display.

**Approval policy.** Per Organization, per channel: `always` (default), `below_confidence(x)`, or `except(labels)`. Ungrounded, failed-check, escalated and first-message-to-a-Prospect Drafts are always held; this is not configurable. M16's control levels are presets over this policy.

**Takeover and escalation.** Takeover is a state change that voids pending Drafts and publishes `conversation.taken_over` (M07 pauses the sequence) and `conversation.handed_back`. Escalation rules are data: trigger, target (Prospect owner, Team round-robin, Admin queue). Notifications use the mail port plus an in-app badge.

**Contract areas.** New `inbox` area: Conversation, Message, Draft, Source, Decision, Policy schemas, routes, error codes (`inbox.conversation_not_found`, `inbox.draft_not_pending`, `inbox.not_conversation_owner`, `inbox.draft_ungrounded`), and the events above. List routes are cursor paginated with a maximum page.

**Schema (db, core schema).** `conversations`, `messages`, `drafts`, `draft_sources`, `approval_decisions`, `approval_policies`, `escalation_rules`, all with `organization_id` and fail-closed row-level security. Visibility is applied in the service by role and Team, with a test per role.

**Hot paths.** Inbox list and queue are indexed by Organization, owner, state and recency; no Organization-sized work per request. Classification and drafting run from the queue.

## Testing Decisions

Highest seam: the core HTTP routes with memory adapters for the classifier, writer, Playbook client and queue. Tests assert external behaviour only: an ingested reply appears once however often it is posted; it is labelled; an objection yields a Draft with validated sources; an ungrounded Draft cannot auto-release; approving emits exactly one `message.approved`; takeover voids Drafts and emits one event; a Rep cannot read or act on another Rep's Conversation, a Manager sees only their Team, an Admin sees all. The cross-Organization test: a second Organization cannot list, read, approve or take over any Conversation or Draft. A prompt-injection fixture (a reply telling the model to approve itself or reveal instructions) must not change state. Prior art: core's Invitation and Team route tests and its cross-Organization suites; the playbook search tests for the source read. Portal: agent-browser run of inbox, queue and takeover against the local stack.

## Out of Scope

Sending (M07 and M08 for email, M11 for LinkedIn, M14 for chat); meeting booking (M10); Call entries in the inbox (M12 follow-up); SMS and WhatsApp; the assessment check itself (M15); control-level presets and instruction versions (M16); mobile notifications; shared drafts between Reps; learning from rejections.

## Further Notes

New GLOSSARY terms proposed:

- **Conversation**: all Messages between one Prospect and an Organization on one channel, with who is currently answering. _Avoid_: Thread, ticket, chat.
- **Message**: one piece of text sent or received in a Conversation. _Avoid_: Email, reply (as the record), DM.
- **Draft**: text an Agent has written for a Conversation and not yet sent. _Avoid_: Suggestion, proposal.
- **Approval**: a member's decision to release, edit or reject a Draft. _Avoid_: Review, sign-off.
- **Takeover**: a Rep taking a Conversation from an Agent until they hand it back. _Avoid_: Handoff, override.

ADRs needed: the reply model vendor and Region availability (Claude on Bedrock is the proposal; none exists); "core owns the inbox" (extends ADR 0005). Check ADR 0003: the first message to a Prospect is always held for approval, which is stricter than the ADR needs and is a lead decision to confirm. Open question: whether Owner sees every Conversation as Admin does (glossary says only Admin); this spec assumes yes. Cross-module ticket numbers (M02, M03, M07, M08) are assumed and must be reconciled when those tickets are written.
