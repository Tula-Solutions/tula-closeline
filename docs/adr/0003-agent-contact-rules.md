# ADR 0003 — Agents contact only with consent, and always disclose

**Status:** Accepted
**Date:** 2026-10-12

## Context

In the US, an AI-generated voice is an "artificial voice" under the TCPA, so a call or text an Agent initiates needs the Prospect's prior consent, with statutory damages per violation. Several US states require every party's consent to record a call. EU rules and the terms of the voice-cloning vendors require telling people they are speaking to an AI. An Agent using a Voice Profile sounds like a real person, which raises the stakes of each rule.

## Decision

Two rules are enforced by the system and cannot be switched off by any Organization:

1. An Agent may call or text a Prospect only when a Contact Consent exists for that Prospect on that channel (phone, SMS or WhatsApp). Without one, the system refuses to place the contact.
2. Every call an Agent handles opens by stating that the caller is an AI and that the call is recorded. Every call a Rep takes with the Copilot announces recording and AI assistance.

## Considered options

- **Leaving the rules to each Organization**, with responsibility assigned through terms of service. Closeline would still be the platform placing the calls.
- **Disclosing only where the Prospect's location requires it.** Fewer announcements, but it needs a per-jurisdiction rules engine and is wrong whenever location is misjudged.

## Consequences

- The Outbound Agent cannot cold-call or cold-text. Its phone, SMS and WhatsApp steps reach only Prospects who opted in, for example through a form.
- A Rep may still cold-call from the softphone, because the consent rule covers AI-initiated contact; the announcement still plays.
- Email is governed by unsubscribe rules, and website chat needs no Contact Consent because the visitor starts it.
- Contact Consent must be captured with enough evidence (source, time, wording shown) to defend a claim.
