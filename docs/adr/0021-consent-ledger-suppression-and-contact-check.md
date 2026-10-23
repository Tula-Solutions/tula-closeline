# ADR 0021 — A consent ledger, per-Organization Suppression and a fail-closed Contact Check

**Status:** Proposed. The retention periods below await the lead's confirmation; everything else follows `docs/specs/m03-contact-consent-and-suppression.md`.
**Date:** 2026-10-22

## Context

ADR 0003 requires a Contact Consent before an Agent calls or texts a Prospect, and a defensible record of it (source, time, wording shown). Nothing yet stores that record, records a Prospect saying stop, or gives voice and outbound one place to ask. If each channel built its own check, one would be wrong. Core is the only writer of its schema (ADR 0007), so the answer lives in core and other services ask it over HTTP.

## Decision

**Ledger.** Contact Consent is derived from an append-only ledger of events (granted, withdrawn) per Prospect and channel. Each event carries its evidence: the source (hosted form, verbal on a Call, import with attestation, CRM), the time, the version of the Consent Wording shown, who recorded it, and a reference to the artefact (form submission or Call). A database trigger refuses update and delete. Current state is computed from the ledger and never edited. A Consent Wording is immutable once any event references it; a change is a new version. A CRM "consented" flag is never a granted event without recorded evidence.

**Suppression.** Suppression is kept per Organization, by salted hash of the normalised address (email, phone, LinkedIn address). Entries come from unsubscribes, STOP replies, bounces, complaints, manual adds, CRM opt-outs and erasure. A suppressed address is refused on every channel for that address. No setting, role or API key overrides it. A consent-based entry is lifted only by a new granted consent with new evidence; only an Admin can remove a manual entry, with a recorded reason; the others are not removable. There is no cross-Organization list: it would let one customer learn about another's Prospects.

**Contact Check.** Every channel calls core's Contact Check before contacting a Prospect, with the address or Prospect, the channel (`phone`, `sms`, `whatsapp`, `email`, `linkedin`) and the purpose (`agent_initiated`, `rep_initiated`, `reply`), set by the calling service and never by an outside request body.
- Agent-initiated phone, SMS and WhatsApp need a granted consent on that channel and no Suppression.
- Email needs no Suppression and an unsubscribe path.
- A Rep's own call needs no consent (ADR 0003) but is refused for a suppressed number.
- A reply to a Prospect who wrote first needs no consent on that channel, and is still refused for a suppressed address.

The check **fails closed**: an unknown Prospect, an error or a timeout is a denial. The kit's `ContactGuard` returns denied after a 500 ms timeout (one jittered retry) and logs it. A denial is a normal typed result, not an HTTP error, carrying one of `consent.missing`, `consent.withdrawn` or `consent.suppressed`. Other `consent.*` codes (`wording_locked`, `invalid_token`, `entry_not_removable`) are errors for bad requests. Each check writes an audit row.

**Purposes of the data.** Consent events, wording and Suppression exist only to decide whether contact is allowed and to answer a claim; they are exported per Prospect as evidence and are not used for targeting. Hosted-form submissions also keep IP address and user agent as part of the evidence.

**Retention (proposed, awaiting the lead's confirmation).** Consent events and wording are kept for the life of the Organization plus five years after withdrawal; Contact Check logs for 90 days; hosted-form IP with its event. After erasure of a Prospect only the hashed Suppression entry remains.

**What no setting can change.** No Agent contacts a Prospect on phone, SMS or WhatsApp without a Contact Consent for that channel, and every Call discloses AI and recording (ADR 0003). The Contact Check enforces the first; the second is the Call's own opening (M12) and is shown read-only.

## Considered options

- **Each channel checks for itself.** Fewer calls, but one channel will eventually be wrong.
- **A global, cross-Organization suppression list.** Stronger protection for a Prospect, but it leaks which addresses other Organizations hold. Not built.
- **Fail open on timeout.** Keeps sending during an outage and risks an unlawful contact; rejected.

## Consequences

- Voice, outbound and the channel adapters (M8, M11, M12, M14) depend on core being reachable; during an outage they send nothing.
- A STOP on one channel withdraws that channel's consent only, unless it is a STOP-all; a Suppression entry still refuses the address on every channel.
- Hashing needs a core-held per-Organization salt secret, and exports re-derive state from the ledger.
- Consent text is a lawyer's decision before real use; this ADR stores the wording but does not supply it.
