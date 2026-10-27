Phase: 2 · Repos: hub, contract, db, kit, core, portal · Parity rows: R36 (instant unsubscribe plus CRM flag), R63 (do-not-call handling), R72 (consent-only calling), R90 (TCPA statement), R91 (AI and recording disclosure; 11x has no evidence of either)

# M3 Contact Consent and suppression

## Problem Statement

ADR 0003 says an Agent may call or text a Prospect only with a Contact Consent, and that the rule cannot be switched off. Nothing implements it. There is nowhere to store a consent with the evidence needed to defend a claim (source, time, the wording shown), nowhere to record that someone said stop, and no single check that every channel calls before it sends. If each future module (voice, outbound email, SMS, WhatsApp, LinkedIn) builds its own check, one will be wrong. The competitor offers partial do-not-call handling and consent-only calling (R63, R72) and is silent on the TCPA and on disclosure (R90, R91).

## Solution

Core owns a **consent ledger** and a **suppression list**, and one **contact check** that every channel must call before it contacts a Prospect.

- **Ledger.** Append-only events (granted, withdrawn) per Prospect and channel, each with evidence: the source (hosted form, verbal on a Call, import with attestation, CRM), when, the exact wording shown (immutable, versioned), who recorded it, and a reference to the artefact (form submission, Call). Current state is derived from the ledger, never edited.
- **Suppression list.** Per Organization, by hashed normalised address (email, phone, LinkedIn address). Entries come from unsubscribes, STOP replies, bounces and complaints, manual adds, CRM opt-outs and erasure. A suppressed address is refused on every channel and cannot be overridden by any setting or role; only a new granted consent with new evidence lifts a consent-based entry, and only an Admin can remove a manual one, with a reason.
- **Contact check.** An internal call with a Prospect or address, a channel and the purpose (`agent_initiated`, `rep_initiated`, `reply`). It returns allowed or denied with a reason code and writes an audit row. It fails closed: no answer in time means no contact. Agent-initiated phone, SMS and WhatsApp need a granted consent and no suppression; email needs no suppression and an unsubscribe path; a Rep's own cold call needs no consent (ADR 0003) but is still refused for a suppressed number; a reply to a Prospect who wrote first needs no consent on that channel.
- **Capture.** A hosted consent page with versioned wording, a one-click email unsubscribe, an endpoint for inbound STOP, and manual recording by a Rep or Admin with evidence.
- **Evidence export.** Per Prospect, so an Organization can answer a claim.

The kit gets a small `ContactGuard` helper so the voice and outbound services call the check the same way.

## User Stories

1. As an Admin, I want every Agent contact refused unless a Contact Consent exists for that Prospect and channel, so that we comply with ADR 0003.
2. As an Admin, I want no setting, role or API key to disable that rule, so that nobody can break it by mistake.
3. As a Rep, I want to record that a Prospect agreed to be contacted by text, with how and when, so that the Agents may use that channel.
4. As a Rep, I want to be asked for the source and the wording when I record consent, so that the record would stand up later.
5. As an Admin, I want to publish a hosted consent page with specific wording, so that Prospects can opt in themselves.
6. As an Admin, I want wording to be versioned and immutable once used, so that each consent shows exactly what the Prospect saw.
7. As a Prospect, I want to tick one box saying I agree to be texted or called by an Organization's AI, and see what that means, so that my agreement is informed.
8. As a Prospect, I want to withdraw consent by replying STOP, so that the messages end.
9. As a Prospect, I want to unsubscribe from email in one click without signing in, so that I am not made to work for it.
10. As a Prospect, I want withdrawal honoured at once, on every channel of that Organization, so that I am not contacted again.
11. As a Rep, I want to see a Prospect's consent per channel and suppression state on their page, so that I know what is open.
12. As a Rep, I want my own cold call from the softphone to be allowed when no suppression exists, so that human selling is not blocked by a rule meant for Agents.
13. As a Rep, I want a suppressed number to be refused even for my call, with the reason shown, so that I do not call someone who said stop.
14. As a Manager, I want to see the consent state of my Team's Prospects, so that I can coach on compliance.
15. As an Admin, I want a suppression list screen with search, reason and date, so that I can audit it.
16. As an Admin, I want to add an address to suppression by hand or by CSV, so that I can apply a do-not-contact list I hold.
17. As an Admin, I want to remove only a manual entry, with a reason that is recorded, so that mistakes can be fixed without a loophole.
18. As an Admin, I want a bounced or complained email address suppressed automatically, so that deliverability is protected.
19. As an Admin, I want CRM opt-outs to become suppressions, so that a flag in HubSpot is honoured here (R36).
20. As an Admin, I want a CRM "consented" flag never to become a Contact Consent without recorded evidence, so that a checkbox is not mistaken for proof.
21. As an Admin, I want an audit row for every contact check, with the result and reason, so that I can show what the system refused.
22. As an Admin, I want to export a Prospect's consent evidence, so that I can answer a regulator or a claim.
23. As an Admin, I want consent evidence kept after a Prospect is erased only as a hashed suppression entry, so that we remember to stay away without keeping their data.
24. As an Agent (later), I want one fast call that tells me whether I may contact, so that I never guess.
25. As a developer of the voice or outbound service, I want a guard in the kit that fails closed on timeout, so that an outage cannot cause an illegal contact.
26. As an Owner, I want every check and ledger entry unreadable to other Organizations, so that my Prospects stay private.
27. As an Admin, I want a Prospect's consent withdrawn on one channel to leave other channels' consents alone unless it came from a STOP-all, so that scope is exact.
28. As a Rep, I want verbal consent captured on a Call with the Call linked as evidence, so that spoken agreement counts.
29. As an Admin, I want a clear message when an Agent was blocked, shown on the Prospect and in the inbox later, so that I understand why nothing was sent.
30. As an Admin, I want the system to state that Calls open with AI and recording disclosure and cannot be changed, so that I do not look for a switch.

## Implementation Decisions

- **Core owns** new modules `consent`, `suppression` and `contact-check`. All tenant tables carry `organization_id` under fail-closed row-level security.
- **Contract area `consent`**: channels (`phone`, `sms`, `whatsapp`, `email`, `linkedin`), consent event, wording version, suppression entry and reason (`unsubscribe`, `stop`, `bounce`, `complaint`, `manual`, `crm`, `erased`), contact check request and result, evidence export. Codes: `consent.missing`, `consent.withdrawn`, `consent.suppressed`, `consent.wording_locked`, `consent.invalid_token`, `consent.entry_not_removable`. A denial is a normal 200 result with a code, not an HTTP error; errors are for bad requests.
- **Schema**: `contact_consent_event` (append-only, a trigger refuses update and delete), `consent_wording` (immutable once referenced), `suppression_entry` (hash of normalised value, channel scope, reason, source ref, added by, removable flag), `contact_check_log` (retention bounded, ninety days), `consent_form` (wording ref, hosted token). Hashes are salted per Organization with a core-held secret.
- **Public routes** (unauthenticated, rate-limited in Postgres): one-click email unsubscribe using a signed token (RFC 8058 `List-Unsubscribe-Post` compatible), and consent form submission. **Internal route** (shared secret, ADR 0013): the contact check and `record-withdrawal` for inbound STOP from channel adapters.
- **Fail closed everywhere**: the check returns denied when the Prospect is unknown; the kit guard returns denied on timeout (default 500 ms), retries once with jitter, and logs.
- **Events**: `consent.granted`, `consent.withdrawn`, `suppression.added`, `suppression.removed` via the queue so voice and outbound can cancel scheduled work.
- **Kit**: `ContactGuard` port with an HTTP adapter and a memory adapter that tests can configure.
- **Portal**: consent panel on a Prospect, suppression screen for Admins, consent form builder, and a signed-out hosted consent page. Disclosure is stated read-only on the Agents screens (later modules).
- **Evidence** includes IP address and user agent for hosted submissions, kept as personal data with the retention in Further Notes.
- **Rep-initiated vs agent-initiated** is an explicit parameter of the check, set by the caller service, never by a client request body from outside.
- **No vendors.** Channel adapters (M8, M12, M14) call this module.

## Testing Decisions

- Highest seam: the internal contact-check HTTP route in core with memory adapters, as table-driven cases over channel, purpose, consent state and suppression state, including every denial code. Ledger tests assert history is append-only and current state derives correctly from grant, withdraw, grant.
- Property: a suppressed address is never allowed, on any channel or purpose; a test runs the whole matrix.
- The db harness proves the append-only trigger and row-level security. Cross-Organization isolation: a second Organization cannot read events, suppression or check logs, and its suppression of an address does not affect the first.
- Public routes: unsubscribe with a valid, a tampered and an expired token; replay is idempotent; consent form submission stores the exact wording version shown.
- Kit: `ContactGuard` tests for allowed, denied, timeout (fails closed), and retry with the memory server.
- Prior art: invitation token tests (hashing, expiry), idempotency store tests, and the db library's row-level-security harness. `/run-check`: unsubscribe from a Mailpit email, submit the hosted form in `agent-browser`, then run the check.

## Out of Scope

- The channels themselves (voice M12, email M8, SMS and WhatsApp M14, LinkedIn M11) and the disclosure announcement on Calls (M12); this module supplies the check.
- Platform-wide or national do-not-call registry scrubbing (needs a vendor and a legal decision).
- Preference centres, consent for marketing email as a product, and double opt-in flows.
- Legal wording of consent text; a lawyer reviews the template before real use.
- Automatic jurisdiction rules; ADR 0003 chose one strict rule for all.

## Further Notes

- **Proposed GLOSSARY terms.**
  - **Suppression**: an Organization's record that an address must not be contacted on any channel, made on a Prospect's request or by a bounce or complaint. _Avoid_: blocklist, DNC list, opt-out list.
  - **Contact Check**: the question every channel asks before contacting a Prospect, answered allowed or denied with a reason. _Avoid_: permission check, compliance check.
  - **Consent Wording**: the exact text a Prospect was shown when agreeing, kept unchanged. _Avoid_: disclaimer, terms.
- **ADR needed (M03-T1):** the ledger, suppression scope (per Organization, all channels), fail-closed contact check, and retention of evidence. It builds on ADR 0003 and ADR 0007.
- **Retention (lead decision to confirm):** consent events and wording kept for the life of the Organization plus five years after withdrawal; check logs ninety days; hosted-form IP kept with the event.
- **Open question:** per-Organization suppression follows tenant isolation. A cross-Organization "global" list would let one customer learn about another's Prospects; we do not build it. Confirm with the lead.
- **Parity:** R36, R63 and R72 matched or exceeded; R90 and R91 are our differentiators (11x shows no evidence).
