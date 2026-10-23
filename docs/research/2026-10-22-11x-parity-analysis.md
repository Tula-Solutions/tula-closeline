# Closeline against 11x: where we are and what parity takes

Date: 2026-10-22. Builds on [the 11x reverse-engineering report](2026-10-22-11x-reverse-engineering.md)
(its checklist rows are cited as `R<n>`) and an inventory of every Closeline repo taken the same day.

## 1. The short version

11x sells two Agents. **Alice** runs outbound email and LinkedIn: audiences, research, sequences,
replies and booking. **Julian** handles voice, chat, SMS and WhatsApp, mostly inbound speed-to-lead.
Both sit on a document knowledge base, CRM sync and managed deliverability. 11x sells them as
annual, demo-gated contracts with heavy services.

Closeline has finished most of phase 1. It has sign-in (password and Google), Organizations,
Teams, Invitations, and a Playbook that ingests Documents, Call Transcripts and Deal Outcomes and
searches Moments from won Deals. A portal covers all of it. None of the selling surface exists yet:
no Prospects, Contact Consent, CRM connection, email sending, campaigns, voice, Copilot or Agents,
and no marketing page.

Parity takes about fourteen modules over phases 2 to 5. "Better" comes from four things 11x does
not have:

1. **The Playbook learns from the Organization's own won and lost Deals.** Every message, Copilot
   card and Agent reply cites the Moments it came from (R67: 11x has no evidence of this).
2. **AI and human selling together.** The Copilot advises a Rep live on a Call (R93: 11x has no
   evidence of it). The Agents hand off to Reps with the full context. The Tula mark is a balance
   scale, with a solid pan for AI and an open pan for the human, and that is the positioning.
3. **Trust by construction.** Contact Consent per channel, plus AI and recording disclosure on
   every Call (ADR 0003; R90, R91: 11x is silent). A visible approval queue, an audit trail for
   every send, data export, and a public OpenAPI (R80, R92).
4. **Honest commercial terms.** Published pricing and monthly terms (R96). The opposite of the
   lock-in and the "logos we didn't earn" story (report section 6).

## 2. What exists today (2026-10-22)

| Area | State |
| --- | --- |
| Identity | auth: email and password with verification, sessions, refresh cookie, JWKS, Sign in with Google |
| Organization | core: Organizations with Region, Members, roles (Owner, Admin, Manager, Rep), Teams, Invitations with limits, idempotency keys |
| Playbook | playbook: Document upload, parse, chunk and embed; Call upload (WebVTT/SRT Transcripts, Recordings); Deal import (CSV) with Outcomes; Moment and Document search; rights confirmation |
| Libraries | contract (auth, core and playbook areas), db (auth, core and playbook schemas, migrations 0000–0020), kit (logger, errors, token verification, queue, storage, reporting with Sentry, a transcribe port with a memory adapter, and a vector port with a memory adapter) |
| Portal | Vite and React 19, TanStack Router, Tailwind v4 in the editorial ink-and-paper direction (Newsreader, Inter Tight, JetBrains Mono): sign-in and sign-up, Home, Members, Invitations, Teams, Playbook, Sales history |
| Infra | Repository and CI only; no infrastructure as code yet (#19) |
| Missing | a real transcription adapter, a real vector store (#48), production email, HubSpot (#17), and everything in section 3 |

## 3. Parity matrix by module

The columns give what 11x has, what Closeline has today, and our twist on it. The `M` numbers are
the modules specified in section 4.

| M | Module | 11x (rows) | Closeline today | Our twist |
| --- | --- | --- | --- | --- |
| M1 | Marketing site | Space-themed site, demo form, voice demo (report 2.2) | none | Editorial ink-and-paper site with the balance-scale story, a public pricing page, and a "hear the Copilot" sample |
| M2 | Prospects and Accounts | CRM leads, 400M DB (R1, R8) | none | Prospects with source and lineage; every field shows where it came from |
| M3 | Contact Consent and suppression | partial (R36, R63, R72) | ADR 0003 only | Consent ledger with evidence (source, time, wording); a global suppression list checked before every send; no setting can switch it off |
| M4 | CRM sync | Salesforce, HubSpot, Pipedrive bidirectional (R42–R45) | HubSpot ticket open (#17) | Deals and Outcomes flow into the Playbook automatically, so the CRM teaches the Agents |
| M5 | Enrichment and signals | 21+ providers, intent, web research (R2–R7) | none | An enrichment port with a provider waterfall; signals as typed events; cost per Prospect shown |
| M6 | Research and messaging | Deep research brief, per-Prospect writing, tone, preview (R12–R19) | Moment search exists | Every draft cites the won-Deal Moments and Documents it used; preview on sample Prospects before launch |
| M7 | Campaigns and sequences | Sequence builder, branching, plays, limits (R27–R32) | none | Plays seeded from what won in the Organization's own history, with A/B tests built in |
| M8 | Email channel and deliverability | Managed mailboxes, warm-up, rotation, health (R46–R49) | mail port (Mailpit only) | Connected Rep mailboxes (Gmail, Outlook), per-mailbox limits, bounce and complaint handling, a health score |
| M9 | Inbox, replies and approvals | Reply classification, objection handling, escalation, thresholds (R33–R37, R69) | none | One inbox for Agent and Rep threads; an approval queue with a reason for every draft; the Rep takes over in one click |
| M10 | Meetings and routing | Booking, routing rules, Chili Piper, transfer (R38–R41) | none | Calendar connections, routing rules (round-robin, territory, Team), and booking links |
| M11 | LinkedIn channel | yes (R21) | ADR 0004 only | Through a provider, with written risk acceptance and low daily limits per account |
| M12 | Voice platform and softphone | Twilio and Cartesia, sub-second turn latency, recording, human dialer (R26, R53–R63) | transcribe port only | Disclosure on every Call, Recording and Transcript into the Playbook, a softphone for Reps |
| M13 | Copilot | none (R93) | Moment search is the foundation | Live cards during a Call showing what won in similar Moments, with evidence counts; objection and next-step prompts |
| M14 | Inbound Agent | Speed-to-lead under 60 s, chat, qualification, transfer, SMS and WhatsApp (R22–R25, R54, R61) | none | Same coverage, gated by Contact Consent; qualification questions drawn from won Deals; warm transfer to a Rep with the Copilot attached |
| M15 | Analytics, assessments and learning | Dashboards, Smart Outcomes, hallucination checks (R68, R73–R76) | none | Outcome attribution back to the message or Moment; an assessment on every Agent turn; won Deals re-train the Playbook |
| M16 | Agent controls, audit and openness | Instructions, approvals, three control levels, SSO (R70, R71, R82, R84) | roles exist | Agent instructions with version history, an audit log of every Agent action, data export, a public API and keys |

Out of reach for parity and not pursued: an owned 400M-contact database (R1; we use providers
behind a port), CASA and SOC 2 certification (process work, not code), the IBM partnership (R81),
and forward-deployed services (R83).

## 4. Modules and order

The order keeps the plan in `docs/plans/phase-1.md`: the Copilot (phase 2), the Inbound Agent
(phase 3), the Outbound Agent (phase 4) and the extra channels (phase 5). It adds a few
foundations that every Agent needs, plus the marketing site, which has no dependencies.

| Phase | Modules | Why here |
| --- | --- | --- |
| 1 (finish) | #17 HubSpot, #19 infra, #48 vector store, M1 marketing site | Close phase 1; the site is independent |
| 2 | M2 Prospects, M3 Contact Consent, M12 voice and softphone, M13 Copilot, M4 Salesforce | The differentiator first; consent before any contact |
| 3 | M14 Inbound Agent, M10 meetings and routing, M9 inbox and approvals (Calls, chat) | Speed-to-lead parity with Julian |
| 4 | M5 enrichment, M6 research and messaging, M7 campaigns, M8 email and deliverability, M9 (email replies) | Parity with Alice |
| 5 | M11 LinkedIn, SMS and WhatsApp in M14, M15 analytics and learning, M16 controls and API | Remaining channels; closing the loop |

Each module is specified as a hub issue labelled `spec`, and each spec is broken into tickets as
sub-issues with native blocking edges, following `docs/agents/issue-tracker.md`.

## 5. Lead decisions recorded here

- **The marketing site lives in the portal**, shown at `/` to signed-out visitors, not in a new
  repository. It reuses the brand system and fonts and needs no new deploy target. Revisit this
  when the site needs SEO-grade server rendering.
- **The phase order is unchanged.** The Copilot comes before outbound, even though outbound email
  is the larger half of 11x.
- **No owned contact database.** Enrichment goes through a port with provider adapters (M5).
- **LinkedIn waits until phase 5**, under ADR 0004's conditions.
