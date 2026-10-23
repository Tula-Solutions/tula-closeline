# 11x (11x.ai) reverse-engineering report

Date: 2026-10-22. Public sources only; nothing behind a login was accessed. Evidence grades: **verified** = on 11x's own pages or a primary talk; **third-party** = review/aggregator/competitor claim; **unverified** = inferred or conflicting. Much of the web copy is vendor marketing; competitor blogs (ZoomInfo, Abmatic, Artisan, Salesforge, Dashly) are biased and are flagged where used.

**Limits of this research:** the app UI is not publicly documented (no help center, docs site, changelog or public API docs were found), so section 4 is thin by necessity. The LangChain Interrupt 2025 talk was not watched or transcribed; its content comes from a ZenML summary.

## 1. Summary

1. 11x sells "digital workers" / "agents that drive revenue" (current homepage headline) for B2B revenue teams: **Alice** (outbound: prospecting, research, email + LinkedIn sequences, reply handling, meeting booking) and **Julian** (voice, plus chat/SMS/WhatsApp, mainly inbound speed-to-lead, qualification, routing, and expansion/upsell calls). Older "Mike" was renamed Julian (third-party).
2. Buyers: mid-market and enterprise sales, marketing, growth and RevOps teams with CRM (Salesforce, HubSpot, Pipedrive) and enough volume to commit to annual contracts. Case studies skew to biotech, compliance, HR tech, PropTech, construction, media, education.
3. Pricing: not published; demo-gated. Third-party estimates conflict and are unverified: about $3,750 to $5,000+/month for Alice, Julian Voice about $5,333/month and Chat about $2,417/month (billed annually), annual deals roughly $30k to $90k+. ZoomInfo (competitor) says credit-based, quarterly invoicing, annual, non-cancellable, no trial.
4. Positioning has moved from "replace your SDR" (2024 to 2025) to a multi-channel "platform" with "one shared brain", configurable control levels, and a services layer (Forward Deployed Engineers, Customer Success managers).
5. Moat claimed: 400M+ contact database plus 21+ data providers, live web search ("Deep Research"), six-source context, bi-directional CRM sync, deliverability management for email and phone numbers, SOC 2 Type II.
6. Funding: about $75M total (Series A $24M Benchmark, Series B about $50M a16z, late 2024; reported valuation about $350M, third-party). Founder-CEO Hasan Sukkar stepped down May 2025; CTO Prabhav Jain is CEO.
7. Reputation: TechCrunch (2025-03-24) reported unauthorized customer logos, ARR counted on cancellable contracts, and employee-reported 70 to 80% early churn; 11x says retention is 79% and it reports contracted ARR. G2 about 4.4/5 on about 30 reviews.
8. Offices: San Francisco and London. Case-study metrics are self-reported.
9. Strategic read: broad surface, shallow documented depth. Opaque AI behaviour, annual lock-in, no public API docs and no export are the openings for Closeline.
10. Biggest gap to exploit: 11x has no documented learning loop from a customer's own won/lost deals and no live-call Copilot for a human Rep (see section 6).

## 2. Website teardown

### 2.1 Page inventory (all fetched 2026-10-22)

| Page | URL path | Notes |
| --- | --- | --- |
| Home | `/` | see 2.2 |
| Alice / outbound | `/outbound` (also `/worker/alice`) | see 2.3 |
| Julian / inbound | `/inbound` | see 2.4 |
| Expansion | `/expansion` | Julian outbound to existing customers |
| Platform | `/platform` | see 2.5; 25+ sub-pages under `/platform/<group>/<feature>` |
| Plays (10) | `/products/julian/*`, `/products/alice/*` | speed-to-lead, automated meeting scheduling, customer onboarding operations, customer expansion, lead nurture, lead reactivation, retargeting website visitors, closed lost, competitive takeout, PLG conversion; also event registration / follow-up / no-show, outbound lead generation, inbound lead qualification |
| Solutions | `/solutions/{marketing,sales,growth,revops,enterprise}` | persona landing pages |
| Customers | `/customers` | logo wall, G2 and Trustpilot badges, filterable story grid (12 stories) |
| About | `/about-us` | no founders/execs named; claims $75M raised; "200 Years" saved, "100s" of digital workers; offices SF (677 Harrison St) and London; careers anchor `#opportunities` |
| Blog | `/blog` | product launches, engineering, news, plus SEO "guides" (`/guides/ai-voice-agents*`) and `/tips/ai-sdr-tools` |
| Comparisons | `/comparison/11x-vs-artisan`, `/compare/11x-vs-outreach`, `/comparison/11x-vs-qualified` | SEO conquesting pages |
| Demo | `/demo` | form only; no pricing page |
| Security | `/security` | see 3.5 |
| Legal | `/legal/privacy-policy`, `/legal/terms` | |

No public pricing page, docs/help center, API reference, status page or changelog was found. The blog shows no changelog posts.

### 2.2 Homepage structure

1. **Hero**: headline "agents that drive revenue"; sub-copy about converting inbound, running outbound playbooks and expanding accounts across every channel; channel chips Voice, Chat, Email, Social, SMS; CTAs "Get a demo" and "Try Voice AI" (anchors to a live voice demo). Animated space scene (planets, stars, satellite, live coordinate read-out).
2. **Social proof carousel**: 11 customer cards with named executive quotes (Mapped, The Lab Group, Brainsuite, Workera, Leica Biosystems, Cofenster, MMB Networks, Checkr, Unitech, Canibuild, Questex) and headline numbers ($4M pipeline, 7K+ inbound calls automated, under-20-minute speed-to-lead, "99% reduction", 80 SDR hours reallocated monthly).
3. **Interactive voice demo ("Meet Julian")**: scenario picker (Receptionist, Speed-to-Lead, Upsell), seven voice styles (Confident, Energetic, Supportive, Professional, Gentle, Down to Earth, British), demo agent "Nina", and a short lead form (name, business email, CRM, referral source). This is a product-led conversion hook: the visitor gets called.
4. **Channel tabs**: Voice, Email, Chat, Social, SMS and WhatsApp, Human Dialer; maps Julian to inbound/expansion and Alice to email/social outbound.
5. **Three jobs**: Inbound (respond, qualify, route), Outbound (find accounts, research, multi-channel sequences), Expansion (CRM and usage data trigger upsell/cross-sell).
6. **"One shared brain"**: Context (CRM + knowledge base + third-party signals), Intelligence (coordinated specialist agents), Omnichannel (two-way conversations).
7. **By function**: Sales, Marketing, Growth, RevOps.
8. **Integrations/trust**: HubSpot, Salesforce, Pipedrive, LinkedIn, G2, Slack, Gmail, Outlook, Google Calendar; partners IBM and Pavilion; security badges to `/security`.
9. **Closing CTA**: "T-MINUS 30-MINUTES / Ready for launch?" with "Book a Live Demo" and "Try Voice AI".
10. **Footer**: quicklinks, comparison pages, LinkedIn and X, legal, offices, "(c) 2026 11x AI Inc."

**Core claims/themes (paraphrased):** speed (inbound response under 60 seconds, 24/7), coverage (every channel, 105 languages claimed on the platform page), signals ("why now": funding, hiring, job moves, tech stack), "agents open the conversation, people build relationships and close" (about page), measurable pipeline over vanity metrics.

**Visual direction:** dark "mission control" / space-exploration metaphor; large bold sans headlines; monochrome white logos; bracketed bullet markers; countdown/telemetry copy; animated hero; card carousels. Exact typefaces and hex values were not extractable from the fetched text (unverified).

**Conversion funnel:** nav "Book a Demo" and hero "Get a demo" lead to `/demo`: 3 required fields (first/last name, business email), CRM dropdown (Salesforce, HubSpot, Other), "how did you hear" dropdown (web search, AI search, LinkedIn, advertisement, partner/customer referral, word of mouth, other); success message promises a reply "shortly". Secondary funnel: "Try Voice AI" demo call. No self-serve signup, no free trial, no pricing page. The demo page copy has a visible typo ("Grow W 11x faster") and the Artisan comparison page had Lorem-ipsum FAQ filler, so quality control is uneven.

### 2.3 Alice page (`/outbound`)

Structure: hero (you set audience and goal, platform picks the play) -> voice agents block (reused) -> proof (Leica $4M, LAB Group 57x ROI, Mapped +75% pipeline) -> core capabilities (detect in-market buyers, research, reach on every channel) -> workflow (find accounts, research, sequence, rep prep before calls, deliverability) -> play library (cold, signal-based, event follow-up, nurture, website visitor identification, inactive reactivation, closed-lost, experimentation) -> platform feature list with "show more" -> "traditional outbound vs 11x" comparison table -> demo CTA. Claims: 400M-contact database, G2 buying signals, "optimized for meetings booked, not opens or replies", sensitive replies escalated.

### 2.4 Julian page (`/inbound`)

Structure: hero -> voice demo -> results (Checkr 7,000+ calls, CanIBuild 99% speed-to-lead cut, Unitech 35% of pipeline in 3 months) -> "never miss a qualified lead" -> lead journey (visitor chat, form-fill call under 60 s, qualification, routing, booking or live transfer) -> five inbound plays (speed-to-lead, ICP scoring, omnichannel re-engagement, after-hours/international, PLG engagement) -> playbook controls -> "inbound today vs with 11x" table -> CTA.

### 2.5 Platform page (`/platform`)

Sections: sales agents (voice) -> unified context (six sources: CRM, knowledge base, website activity, past 11x conversations, real-time third-party signals, account/contact data) -> conversational intelligence -> audience intelligence -> campaign strategy ("copilot" turns goals into a plan) -> deep research (cited brief with suggested angle) -> campaign preview and Smart Outcomes -> campaign performance -> automated assessments (hallucination and script-deviation flags) -> "your agents, your rules" (3 control levels) -> agent instructions and approvals -> deliverability -> support model (FDEs, CSMs) -> integrations.

## 3. Product functionality

### 3.1 Alice (AI SDR, outbound)

| Aspect | What is public | Grade |
| --- | --- | --- |
| Data | Built-in "real-time company and lead database" (400M+ profiles claimed), 21+ data providers (Artisan comparison page), live web search/news/10-K, G2 intent, CRM leads. Providers not named. The Alice 2.0 talk says 2M leads were sourced in the first launch window. | verified (claims), providers unverified |
| ICP and audiences | Audience Intelligence matches ICP; campaign "copilot"/Campaign Strategist builds a plan from goal + industry + ICP; audience creation was a separate agent in Alice 2.0 | verified |
| Signals | funding, hiring spikes, job changes, tech-stack shifts, website visits (visitor tracking), G2 buyer signals, past CRM engagement | verified (claims) |
| Research | Deep Research: public signals + CRM + KB, cited brief with suggested angle; "positioning report generator" sub-agent in Alice 2.0 | verified |
| Writing | per-contact messages (not merge-field), tone adapts to channel, brand-voice guidelines; "personalization waterfalls" (comparison page) | verified (claims); quality disputed (section 6) |
| Channels | email, LinkedIn (social), power/human dialer. SMS/WhatsApp are listed for follow-ups on the Julian side | verified |
| Sequencing | Sequence Builder: steps, timing, channels, fallbacks; branch on opens/clicks/replies/outcomes; contact activity log; per-mailbox sending limits, warm-up, throttling. A/B testing not mentioned | verified |
| Replies | Smart Replies classify intent (interested, objection, needs info, unsubscribe), handle pricing/timing/competitor objections from the playbook and KB, hand off with full thread + research + qualification | verified |
| Meetings | agent books with the right rep (routing rules); scheduler/calendar tooling not named beyond Google Calendar/Outlook | verified (partial) |
| CRM | bi-directional sync Salesforce, HubSpot, Pipedrive (Zoho per ZoomInfo, unverified); unsubscribes flagged in CRM | verified |
| Deliverability | managed domains and mailboxes, auto warm-up (about 2 weeks), mailbox cycling, health monitoring; blog advises dedicated outbound domains and rotating fresh inboxes | verified |
| Languages | multilingual outreach; "105 languages" platform page (ZoomInfo says Alice 105+, Julian 30+; 11x guides say 100+ or 105+; inconsistent) | partial/unverified |
| KB / training | Knowledge Base from PDFs, docs, URLs, call transcripts, battle cards; campaign-scoped entries; change history; rollback; applies "instantly" | verified |
| Guardrails | configurable approval thresholds, escalation rules, send windows; visible agent instructions + assistant to refine them; automated hallucination/deviation assessments. How the approval queue works is not described | partial |
| Analytics | replies, positive replies, meetings booked, calls handled; per-campaign and cross-region; angles/audiences that convert; Smart Outcomes conversation summaries | verified |
| Onboarding | demo-led; 2 to 3 weeks, about 25% of a person's time (ZoomInfo, third-party); Day-1 campaigns, domains warmed about 2 weeks; FDE/CSM-assisted | partial |
| Compliance | immediate unsubscribe; SOC 2 Type II etc. (3.5) | verified |

### 3.2 Julian (AI voice/phone agent)

| Aspect | What is public | Grade |
| --- | --- | --- |
| Directions | Inbound (form-fill callback, receptionist, after-hours, PLG stalls) and outbound to existing customers/consented contacts ("consented outbound calling", expansion) | verified |
| Speed | calls inbound leads within 60 seconds (page); "about 20 s" in ZoomInfo text; 24/7 | verified |
| Scenarios and voices | Receptionist, Speed-to-Lead, Upsell; seven voice styles; Cartesia supplies voice cloning, Sonic TTS, voice conversion, 200+ voices, controllable speed/emotion | verified |
| Latency | Cartesia: under 100 ms TTS. 11x blog (2026-10-21): end-to-end turn was about 950 ms, target 300 to 700 ms with 95% under 700 ms; fixed a TTS WebSocket re-handshake delay | verified |
| Voice architecture | "split-voice": main audio-native model hears the caller, separate voice model speaks; parallel "co-drivers" (fast models) for email capture, pronunciation, safety, noise; speculative drafting; filler lines; room-tone track | verified (blog) |
| Languages | "multiple"; 30+ (ZoomInfo) vs 100+/105 (11x guides) | unverified |
| Qualification | configurable required questions, conditional follow-ups, skip logic; discovery on timeline, use case, team size, buying committee, budget | verified |
| Routing/transfer | territory, round-robin, named-account, seniority; works with Chili Piper; warm transfer with context; book on rep calendar | verified |
| Chat / SMS / WhatsApp / email | chat agent on pricing/product pages; omnichannel re-engagement; matches buyer's channel | verified |
| Number health | rotating numbers, local area code, spam-flag detection, number-health monitoring, branded caller ID, built-in DNC handling | verified (claims) |
| Audit | recording, transcript, assessment breakdown per call; hallucination-risk flags; agent-vs-team qualification comparison | verified |
| CRM | outcomes and insights written to CRM fields; post-call summary and sentiment (ZoomInfo) | verified |
| Consent | "only contacts customers who opted in"; TCPA/DNC not named on the page | partial |
| AI/recording disclosure | not found in public copy | unverified |

### 3.3 Other workers/plays

- Nothing beyond Alice and Julian is sold as a named "worker" today; a Dec 2024 report (tech.eu) said 11x planned up to 20 digital workers in 2025. Chat is sold as a Julian sub-product (priced separately by third parties).
- Plays (all built on Alice or Julian): lead nurture, lead reactivation, retargeting site visitors, closed lost, competitive takeout, PLG conversion, customer expansion, customer onboarding operations, event registration / follow-up / no-show, automated meeting scheduling.
- Integrations: IBM watsonx Orchestrate and Agent Connect partnerships (2025); Slack; G2; API (documentation not public; ZoomInfo found only a JS browser SDK).

### 3.4 Control levels and services

"Managed by 11x", "Built to your spec" (most customers, per page) and "Fully self-configured". Forward Deployed Engineers plus CSMs (dedicated CSM, Slack + email support per comparison page). This is a services-heavy model; admin/team features (SSO, audit logs) are Enterprise-only per the Artisan comparison page. RBAC/Teams/multi-org details are not public.

### 3.5 Security and compliance (from `/security`)

SOC 2 Type II (report on request), CASA Tier 3, GDPR (DPAs for EU customers), CCPA, penetration tests (comparison page), AWS hosting, TLS in transit, AES-256 at rest (RDS), clustered DBs, centralized logging. Not addressed: TCPA, LLM-provider data handling, breach notification, subprocessor names, data residency/regions, data export.

## 4. The product UI

What can be said with evidence: **very little**. No screenshots, docs or help center were fetched; a search for walkthroughs found nothing. What the marketing pages imply (all **unverified** as to layout):

- Campaign creation starts from goal + ICP; a "copilot" proposes the plan; a **live preview** generates research and messages for sample leads before send; the user adjusts audience, strategy, tone, sequence.
- A lead card shows the demo request, industry, size, "high fit" rating and a routing recommendation.
- Sequence Builder (visual steps/branches), contact-level activity log, per-mailbox sending settings.
- Knowledge Base with version history and rollback; per-agent instruction viewer with an assistant.
- Per-call recording, transcript and assessment breakdown; Smart Outcomes summaries; campaign performance (replies, positive replies, meetings).
- Alice 1.0 was criticised for "excessive button clicking" and manual offer entry (talk summary); Alice 2.0 moved to a chat-style, conversational setup with agent steps shown (ZenML summary; exact UI unverified). G2 users call the interface "easy to navigate".
- Inbox / reply review screen, admin settings and team management: not visible publicly.

Action: capture a screen-by-screen walkthrough only through a sanctioned demo or a customer, not by scraping.

## 5. Inferred architecture

**Verified from 11x/LangChain material (Interrupt 2025 talk summary via ZenML; 11x blog):**
- Alice 2.0 was rebuilt from scratch in about 3 months by a small team to migrate about 300 customers. Path: single ReAct agent with 10 to 20 tools (loops, recursion limits) -> 15-node fixed LangGraph workflow with interrupts for user input (rigid) -> **hierarchical multi-agent**: supervisor routing to researcher, positioning-report generator, LinkedIn writer, email writer; audience creation separate. TypeScript codebase, LangChain/LangGraph, LangSmith for observability. Reported launch numbers: about 2M leads sourced, 3M messages, 21k replies, about 2% reply rate.
- Voice: Cartesia (TTS/voice cloning); split-voice architecture with an audio-native main model plus co-driver models (blog). STT/LLM vendors not named.
- Internal tooling (2026-06 blog): Claude (Cowork, Skills, Code), LangSmith Fleet, Slack as control plane, MCP connectors, Notion, Granola, Cursor/Coder/Docker/Playwright. Shows Anthropic and LangChain as vendors; production model for customer-facing agents not stated.
- Job post (Greenhouse mirror, unverified board): TypeScript, Node.js, Next.js, Python, Twilio, Vercel, AWS. ZenML tags also list PostgreSQL, FastAPI, OpenAI, Anthropic, Google Cloud (unexplained).

**Likely pipeline (inference):** audience definition -> candidate pull from owned DB plus provider waterfall plus CRM -> email verification -> signal enrichment -> researcher agent (web search, KB, CRM) -> positioning brief -> channel writer agents -> sequence engine with branching -> send via managed domain/mailbox pool with warm-up -> reply classifier -> reply/objection agent -> escalation or booking -> CRM write-back -> analytics. Voice: Twilio (inferred) telephony -> STT/audio-native model -> TTS -> CRM tool calls and transfer. Evaluation layer: "automated assessments" for hallucination and script deviation, probably LLM-judge (inferred).

## 6. Weaknesses and complaints

Reliability of each is noted; many sources are competitors.

1. **Trust and integrity (TechCrunch, 2025-03-24, primary reporting):** claimed customers that were not (ZoomInfo trial, Airtable never in production); ARR counted full contract value despite break clauses (about $14M reported vs about $3M past the 3-month mark per an employee); employee-reported 70 to 80% churn; former engineer said the product "barely works"; customers cited hallucinations and failures. 11x: contracted-ARR was disclosed to investors; retention now 79%; early cohorts worst.
2. **Contract lock-in:** annual commitments, 3-month break clause historically, non-cancellable/non-refundable per ZoomInfo (competitor); a May 2026 Trustpilot review alleged a pilot became a full annual commitment (via Salesforge, secondary).
3. **Opacity:** no public pricing, docs, API reference or data export; "limited visibility into AI logic" (Fritz, ZoomInfo). 11x's own page does not explain how approvals work.
4. **Quality:** reviews report generic personalization and misclassified replies (hands-on Medium review via search snippet; not fully read); polarized sentiment, deliverability damage and year-one churn (Tomba, 3rd-party blog). Artisan's rebuttal pages say the same of Artisan, so treat all of these as marketing.
5. **Deliverability:** reputation risk is real for any cold-email AI SDR; 11x's own blog says problems start at a few hundred sends a week and recommends dedicated domains, i.e. the customer carries much of the risk. CRM-sync complaints reported by a comparison page (unverified).
6. **Cost:** about $30k to $90k+/year per worker (unverified estimates); 25% of one person's time for setup; about 3 months to full performance.
7. **Scope/gaps:** no live Copilot for human reps (Alice prepares reps "before calls"; no real-time in-call advice found); no evidence of learning from the customer's own won/lost deal history to build a Playbook (their KB is documents you upload); no explicit AI+recording disclosure or per-channel Contact Consent model documented; TCPA unmentioned; no public data export.
8. **Support incident:** an account shut down without notice (Dashly summary of G2/Reddit; unverified).
9. **Org stability:** CEO change May 2025; workplace-culture allegations in TechCrunch.
10. **Messaging inconsistency:** language counts (30+, 100+, 105), latency claims (20 s vs 60 s), and site typos suggest marketing outpacing product accuracy.

**Where Closeline can be better:** a Playbook learned from each Organization's own won/lost deals; live Copilot plus autonomous agents on one platform; consent-gated contact and AI/recording disclosure as non-negotiables (ADR 0003); transparent pricing, short or monthly terms, data export, visible approval queue, public API/OpenAPI, per-reply audit trail with cited sources.

## 7. Feature checklist

Legend: yes = documented by 11x on its own pages; partial = mentioned without detail or conflicting; claimed = vendor assertion only in marketing/third-party.

| # | Area | Feature | 11x has it | Source |
| --- | --- | --- | --- | --- |
| 1 | Data | Built-in contact/company database (400M+) | claimed | S3, S8 |
| 2 | Data | Multiple third-party data providers (21+) | claimed | S8 |
| 3 | Data | Live web search / AI prospecting | yes | S2, S8 |
| 4 | Data | Email verification before send | yes | S12, S11 |
| 5 | Data | Website visitor identification | yes | S2, S8 |
| 6 | Data | G2 buyer-intent signals | yes | S3 |
| 7 | Data | Funding / hiring / job-change / tech-stack signals | yes | S2, S3 |
| 8 | Data | CRM leads as audience source | yes | S2 |
| 9 | Audience | ICP-based audience building | yes | S2 |
| 10 | Audience | Campaign strategist / plan copilot | yes | S2 |
| 11 | Audience | Lead scoring / ICP fit rating | yes | S2, S4 |
| 12 | Research | Deep research brief with citations | yes | S2 |
| 13 | Research | Positioning report per prospect | yes | S13 |
| 14 | Research | Rep pre-call prospect research | yes | S3 |
| 15 | Messaging | Per-contact generated email | yes | S3 |
| 16 | Messaging | LinkedIn message generation | yes | S3, S13 |
| 17 | Messaging | Brand-voice / tone controls | yes | S2 |
| 18 | Messaging | Multilingual outreach | partial | S2, S9 |
| 19 | Messaging | Live preview on sample leads before send | yes | S2 |
| 20 | Channels | Email | yes | S3 |
| 21 | Channels | LinkedIn | yes | S3 |
| 22 | Channels | Voice (outbound consented) | yes | S14 |
| 23 | Channels | SMS | yes | S4 |
| 24 | Channels | WhatsApp | yes | S4 |
| 25 | Channels | Website chat agent | yes | S4 |
| 26 | Channels | Human power dialer | yes | S1 |
| 27 | Sequencing | Multi-step multi-channel sequence builder | yes | S15 |
| 28 | Sequencing | Branching on open/click/reply/outcome | yes | S15 |
| 29 | Sequencing | Per-mailbox limits, throttling | yes | S15 |
| 30 | Sequencing | A/B testing of messages | partial | S3 (experimentation play only) |
| 31 | Sequencing | Play library (cold, nurture, closed-lost, etc.) | yes | S1, S3 |
| 32 | Sequencing | Event registration/follow-up/no-show flows | yes | S1 |
| 33 | Replies | Reply intent classification | yes | S16 |
| 34 | Replies | Autonomous objection handling | yes | S16 |
| 35 | Replies | Escalation to rep with full context | yes | S16 |
| 36 | Replies | Instant unsubscribe + CRM flag | yes | S3, S16 |
| 37 | Replies | Human approval of replies | partial | S2 (thresholds only) |
| 38 | Booking | Meeting booking with right rep | yes | S16 |
| 39 | Booking | Routing rules (territory, round-robin, named account) | yes | S4 |
| 40 | Booking | Chili Piper compatibility | yes | S4 |
| 41 | Booking | Live warm transfer | yes | S4, S14 |
| 42 | CRM | Salesforce bi-directional sync | yes | S2, S8 |
| 43 | CRM | HubSpot bi-directional sync | yes | S2, S8 |
| 44 | CRM | Pipedrive | yes | S2 |
| 45 | CRM | Zoho / Dynamics / LeadSquared | partial | S9, S6 |
| 46 | Deliverability | Mailbox warm-up | yes | S2 |
| 47 | Deliverability | Mailbox rotation / cycling | yes | S2 |
| 48 | Deliverability | Mailbox health monitoring | yes | S1 |
| 49 | Deliverability | Managed sending domains | partial | S3 |
| 50 | Deliverability | Phone number rotation | yes | S2, S4 |
| 51 | Deliverability | Spam-flag detection for numbers | yes | S2 |
| 52 | Deliverability | Local area-code dialing / branded caller ID | yes | S4 |
| 53 | Voice | Inbound call answering / receptionist | yes | S4 |
| 54 | Voice | Speed-to-lead callback under 60 s | yes | S4 |
| 55 | Voice | Selectable voice styles (7) | yes | S1, S4 |
| 56 | Voice | Voice cloning | claimed | S10 |
| 57 | Voice | Sub-second turn latency target | yes | S11 |
| 58 | Voice | Speculative drafting / filler / room tone | yes | S11 |
| 59 | Voice | Call recording + transcript | yes | S4 |
| 60 | Voice | Post-call summary and sentiment | claimed | S9 |
| 61 | Voice | Qualification flow with skip logic | yes | S4 |
| 62 | Voice | 100+ languages | claimed | S2, S9 |
| 63 | Voice | Built-in DNC handling | yes | S2 |
| 64 | Knowledge | Knowledge base from PDFs/docs/URLs/transcripts | yes | S17 |
| 65 | Knowledge | KB versioning and rollback | yes | S17 |
| 66 | Knowledge | Campaign-scoped KB entries | yes | S17 |
| 67 | Knowledge | Playbook learned from won/lost deals | no evidence | n/a |
| 68 | Guardrails | Hallucination / script-deviation assessments | yes | S2, S4 |
| 69 | Guardrails | Configurable approval thresholds | partial | S2 |
| 70 | Guardrails | Escalation rules / send windows | yes | S2 |
| 71 | Guardrails | Visible agent instructions + editor assistant | yes | S2 |
| 72 | Guardrails | Consent-only outbound calling | partial | S14 |
| 73 | Analytics | Replies / positive / meetings dashboards | yes | S2, S3 |
| 74 | Analytics | Per-campaign comparison | yes | S12 |
| 75 | Analytics | Conversation summaries (Smart Outcomes) | yes | S2 |
| 76 | Analytics | Pipeline/attribution reporting | partial | S3 |
| 77 | Integrations | Slack | yes | S1 |
| 78 | Integrations | Gmail / Outlook / Google Calendar | yes | S1 |
| 79 | Integrations | G2 | yes | S1 |
| 80 | Integrations | Public API / docs | partial | S1 nav only; S9 |
| 81 | Integrations | IBM watsonx Orchestrate | yes | S18 |
| 82 | Admin | SSO and audit logs (Enterprise) | claimed | S8 |
| 83 | Admin | Dedicated CSM + forward deployed engineers | yes | S2 |
| 84 | Admin | Three managed/self-serve control levels | yes | S2 |
| 85 | Onboarding | Day-1 campaigns, 2-week domain warm | claimed | S8 |
| 86 | Security | SOC 2 Type II | yes | S5 |
| 87 | Security | CASA Tier 3 | yes | S5 |
| 88 | Security | GDPR / CCPA | yes | S5 |
| 89 | Security | AES-256 / TLS | yes | S5 |
| 90 | Security | TCPA compliance statement | no evidence | S5 |
| 91 | Security | AI + recording disclosure on calls | no evidence | n/a |
| 92 | Security | Data export / portability | no evidence | S9 |
| 93 | Copilot | Live in-call advice to a human Rep | no evidence | n/a |
| 94 | Expansion | Upsell/cross-sell calls from CRM/usage signals | yes | S14 |
| 95 | Inbound | PLG stalled-user outreach | yes | S4 |
| 96 | Pricing | Published, self-serve pricing | no | S3, S9 |

Row count: 96 (rows marked "no evidence" are gaps useful for parity analysis).

## 8. Sources (accessed 2026-10-22)

1. https://www.11x.ai (homepage, nav/footer)
2. https://www.11x.ai/platform
3. https://www.11x.ai/outbound
4. https://www.11x.ai/inbound
5. https://www.11x.ai/security
6. https://www.11x.ai/customers
7. https://www.11x.ai/about-us
8. https://www.11x.ai/comparison/11x-vs-artisan
9. https://pipeline.zoominfo.com/sales/11x-review (competitor)
10. https://www.cartesia.ai/customers/11x
11. https://www.11x.ai/blog/why-timing-decides-if-an-ai-voice-agent-sounds-human
12. https://www.11x.ai/blog/outbound-doesnt-break-at-scale-it-breaks-in-four-predictable-ways
13. https://www.zenml.io/llmops-database/rebuilding-an-ai-sdr-agent-with-multi-agent-architecture-for-enterprise-sales-automation (summary of LangChain Interrupt 2025 talk; talk video: https://www.youtube.com/watch?v=fegwPmaAPQk, not watched)
14. https://www.11x.ai/platform/outreach-workflows/consented-outbound-calling
15. https://www.11x.ai/platform/outreach-workflows/sequence-builder
16. https://www.11x.ai/platform/outreach-workflows/smart-replies
17. https://www.11x.ai/platform/research-messaging/knowledge-base
18. https://www.11x.ai/blog (list incl. IBM partnership posts, 2026 posts)
19. https://www.11x.ai/demo
20. https://www.11x.ai/blog/i-showed-a16z-our-entire-agent-stack
21. https://techcrunch.com/2025/03/24/a16z-and-benchmark-backed-11x-has-been-claiming-customers-it-doesnt-have
22. https://www.11x.ai/platform/data-lead-generation/real-time-company-and-lead-database
23. https://abmatic.ai/blog/11x-strengths-and-weaknesses-2026 (competitor)
24. https://www.landbase.com/blog/11x-ai-pricing and https://www.salesforge.ai/blog/11x-ai-review (pricing estimates, third-party)
25. https://www.g2.com/products/11x (rating snippets via search), https://tomba.io/blog/11x-pricing-reviews-pros-and-cons, https://www.enginy.ai/blog/11x-reviews, https://fritz.ai/11x-ai-review/ (third-party reviews, via search snippets only)
26. https://tech.eu/2024/12/20/az16-backed-11x-set-to-launch-up-to-20-ai-sales-workers-in-2025-as-hunts-killer-engineering-teams/ (search snippet)
27. https://techcrunch.com/2024/09/30/11x-ai-a-developer-of-ai-sales-reps-has-raised-50m-series-b-led-by-a16z-sources-say (search snippet)
28. https://b2bsalesguru.medium.com/11x-ai-sdr-review-i-gave-it-200-leads-and-watched-what-happened-2026-45d14f2ca215 (snippet only; page returned 403)
29. Greenhouse job mirror (olympiacareers board) found via search: stack TypeScript/Node/Next.js/Python/Twilio/Vercel/AWS (unverified board)
