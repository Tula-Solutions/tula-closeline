# ADR 0021 — A consent ledger, per-Organization Suppression and a fail-closed Contact Check

**Status:** Accepted as built in core, the db library and the kit (`docs/specs/m03-contact-consent-and-suppression.md`). The retention periods below are still proposed and await the lead's confirmation.
**Date:** 2026-10-22

## Context

ADR 0003 requires a Contact Consent before an Agent calls or texts a Prospect, and a defensible record of it (source, time, wording shown). Nothing yet stores that record, records a Prospect saying stop, or gives voice and outbound one place to ask. If each channel built its own check, one would be wrong. Core is the only writer of its schema (ADR 0007), so the answer lives in core and other services ask it over HTTP.

## Decision

**Ledger.** Contact Consent is derived from an append-only ledger of events (granted, withdrawn) per Prospect and channel. Each event carries its evidence: the source (hosted form, verbal on a Call, import with attestation, CRM), the time, the version of the Consent Wording shown, who recorded it, and a reference to the artefact (form submission or Call). A database trigger refuses every update, and refuses a delete unless the Prospect the event belongs to is already gone (erasing a Prospect or an Organization removes its events through the foreign key; nothing else can); another refuses TRUNCATE. Current state is computed from the ledger and never edited. A Consent Wording is immutable once any event references it; a change is a new version. A CRM "consented" flag is never a granted event without recorded evidence.

**Suppression.** Suppression is kept per Organization, by salted hash of the normalised address (email, phone, LinkedIn address). Entries come from unsubscribes, STOP replies, bounces, complaints, manual adds, CRM opt-outs and erasure. A suppressed address is refused on every channel for that address. No setting, role or API key overrides it. A consent-based entry is lifted only by a new granted consent with new evidence; only an Admin can remove a manual entry, with a recorded reason; the others are not removable. There is no cross-Organization list: it would let one customer learn about another's Prospects.

**Contact Check.** Every channel calls core's Contact Check before contacting a Prospect, with the address or Prospect, the channel (`phone`, `sms`, `whatsapp`, `email`, `linkedin`) and the purpose (`agent_initiated`, `rep_initiated`, `reply`), set by the calling service and never by an outside request body.
- Agent-initiated phone, SMS and WhatsApp need a granted consent on that channel and no Suppression.
- Email needs no Suppression and an unsubscribe path.
- A Rep's own call needs no consent (ADR 0003) but is refused for a suppressed number.
- A reply to a Prospect who wrote first needs no consent on that channel, and is still refused for a suppressed address.

The check **fails closed**: an unknown Prospect, an error or a timeout is a denial. The kit's `ContactGuard` returns denied after a 500 ms timeout (a timeout, network error or 5xx is tried once more after a jittered pause) and logs it. A denial is a normal typed result, not an HTTP error, carrying one of `consent.missing`, `consent.withdrawn`, `consent.suppressed` or `consent.unavailable`. The last is never answered by core: the kit's client synthesises it when the check fails or times out, and it carries no check id. Other `consent.*` codes (`not_found`, `wording_locked`, `invalid_token`, `entry_not_removable`) are errors for bad requests. Core writes an audit row, with no address in it, before it answers; if the row cannot be written the answer is `consent.unavailable`, so nothing is allowed without a record.

**Purposes of the data.** Consent events, wording and Suppression exist only to decide whether contact is allowed and to answer a claim; they are exported per Prospect as evidence and are not used for targeting. Hosted-form submissions also keep IP address and user agent as part of the evidence.

**Evidence keeps the raw submission IP address and user agent (lead decision, #379).** For `hosted_form` events the ledger stores and returns the raw IP address and user agent, as the contract's `evidenceEventSchema` already requires; they are the proof that a person submitted the form. Only an Owner or Admin can read evidence. Masking (a network prefix plus a keyed hash) was rejected because it weakens the proof the ledger exists to keep. How long the IP and user agent are kept comes under ADR 0024 and is an open question with the product owner; no number is fixed here. They are excluded from the Organization data export (ADR 0024).

**Retention (proposed, awaiting the lead's confirmation).** Consent events and wording are kept for the life of the Organization plus five years after withdrawal; Contact Check logs for 90 days; hosted-form IP with its event. After erasure of a Prospect only the hashed Suppression entry remains. Built so far: the 90-day log retention (core purges one bounded batch of expired rows on about one check in sixteen) and erasure through the foreign key. No code purges consent events or wording on the five-year rule yet.

**What no setting can change.** No Agent contacts a Prospect on phone, SMS or WhatsApp without a Contact Consent for that channel, and every Call discloses AI and recording (ADR 0003). The Contact Check enforces the first; the second is the Call's own opening (M12) and is shown read-only.

## Considered options

- **Each channel checks for itself.** Fewer calls, but one channel will eventually be wrong.
- **A global, cross-Organization suppression list.** Stronger protection for a Prospect, but it leaks which addresses other Organizations hold. Not built.
- **Fail open on timeout.** Keeps sending during an outage and risks an unlawful contact; rejected.

## Consequences

- Voice, outbound and the channel adapters (M8, M11, M12, M14) depend on core being reachable; during an outage they send nothing.
- A STOP on one channel withdraws that channel's consent only, unless it is a STOP-all; a Suppression entry still refuses the address on every channel.
- Hashing is HMAC-SHA-256 under a key derived from a core-held secret and the Organization, so it needs that secret, and exports re-derive state from the ledger.
- Consent text is a lawyer's decision before real use; this ADR stores the wording but does not supply it.
