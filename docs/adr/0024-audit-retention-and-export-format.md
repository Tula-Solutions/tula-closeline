# ADR 0024 — Audit log retention and the data export format

**Status:** Accepted for everything except the retention period, which is an open question for the owner.
**Date:** 2026-10-23
**Builds on:** ADR 0003, ADR 0007, ADR 0023

## Context

M16 adds an append-only **audit log** and an Organization **data export** (`docs/specs/m16-agent-controls-audit-openness.md`). The spec says "24 months by default, in an ADR" and, under Open, "retention of 24 months is a proposal". This record fixes the formats, which the contract and kit already define, and leaves the retention number to the owner.

## Decision

**Audit log.** Core holds `audit_events`. Each is an **Audit event**: Organization, a gap-free sequence per Organization, time, actor (kind member, agent, api_key or system, and id), an `area.verb` action, subject type and id, the Agent instruction version, request id, metadata of ids and labels and the hash fields. Metadata is flat, at most 20 keys, strings at most 200 characters, and refuses keys that carry content or credentials (body, content, text, message, transcript, token, secret, password, email). An event is at most 4,096 bytes. The log never holds Message text, recordings, Transcripts or secrets.
- Integrity: the service role may insert and select, not update or delete. Each event's SHA-256 hash covers its content and the previous hash for the Organization, so a change breaks every hash after it. A verify route checks at most 1,000 events per call and reports the first bad sequence.
- Writers other than core publish through the kit's audit recorder port; core consumes `audit.recorded` idempotently by event id.
- Reads are cursor paged, at most 100 events a page. A filtered read or CSV spans at most 366 days (`audit.range_too_large`). Owner and Admin read all events and may download and verify; a Manager reads events about Prospects owned by Reps on their Team; a Rep reads none. Reading, downloading and verifying are themselves audited.
- CSV export of the log: `text/csv`, oldest first, pages of at most 1,000 rows chained by an `x-next-cursor` header, the same filters as the list. A cell starting with `=`, `+`, `-` or `@` is escaped so a spreadsheet does not run it.

**Retention.** Audit events are kept until a retention rule removes them. Removal must not break verification: when events are removed from the start of the log, core stores the hash and sequence of the last removed event as the chain's anchor, so the remaining chain still verifies. Removal is done by a periodic job under a role other than the service's normal role, is bounded per run, and writes its own audit event (count and sequence range). **Open question for the owner: how long events are kept.** The spec proposes 24 months; no number is fixed here. Until the owner answers, nothing is removed. The owner also decides whether an Organization may choose a longer period, and whether legal hold is wanted (it is out of scope for M16).

**Data export.** `POST /exports` (Owner or Admin) creates a job: one running per Organization (`export.already_running`, 409), at most two in 24 hours (`export.daily_limit`, 429), an idempotency key. It answers 202; nothing is built on the request.
- Core publishes `export.requested`. Each service that holds a slice (core, playbook, voice, outbound) writes it under its export prefix and publishes `export.part_ready` with counts and the prefix, or `export.part_failed` (the job fails at once with a reason: `part_failed`, `timed_out`, `storage_unavailable`; a timeout is the backstop). A redelivery writes the same part once.
- A slice is newline-delimited JSON, one file per table, one JSON object per line, plus the files it owns. Each part has at most 10,000 files and 50 GB. Core writes the manifest listing parts, files and counts.
- Excluded: password hashes, tokens, API key secrets and hashes, consent evidence IP addresses and user agents, and any other Organization's rows. Recordings are included only on request and only as links.
- A separate `enriched_prospects` export is one CSV of enriched Prospect and Prospect Company data, each sourced field beside its Source, with no consent evidence, IP address, user agent, Transcript or Message body.
- The download link is HTTPS, valid 24 hours, issued per call and never stored on the job. Asking for it is audited. An export that has passed its 24 hours is `expired` and its files are removed.

## Considered options

- **Fix retention at 24 months now.** Rejected: the spec calls it a proposal and the owner has not chosen; a number we made up becomes a promise to customers and an auditor.
- **Keep audit events forever.** Easy, but it grows without bound and meets no deletion request; left to the owner's answer.
- **Delete rows with no anchor.** Rejected: the chain would stop verifying.
- **One archive file for an export.** Rejected: an Organization's size is unbounded and the work must be queued and resumable per service.

## Consequences

- Core's retention job and the chain anchor are built only after the owner sets the period; the verify route must already accept an anchor.
- Services must keep their slice writers idempotent and out of the audit log's metadata rules.
- Export links are the only place a signed storage URL appears; they are never logged.
