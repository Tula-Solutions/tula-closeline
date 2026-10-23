Phase: 5 (instructions and audit may be pulled forward to phase 3 for the Inbound Agent) · Repos: contract, db, kit, auth, core, playbook, portal, hub · Parity rows: R70, R71 (instructions only, no editor assistant), R80, R82 (audit logs; SSO later), R84, R92

## Problem Statement

An Organization that lets an AI sell for it needs to say what the Agent may do, see everything it did, take its data out, and connect its own systems. Today roles exist, but there is nowhere to write an Agent's instructions, no way to dial how much freedom an Agent has, no record of Agent actions, no export of the Organization's data, and no way for another program to call Closeline. 11x offers instructions, three control levels, SSO and audit logs on its enterprise tier (R70, R71, R82, R84), a partial public API (R80) and no evidence of data export (R92).

## Solution

Five features in core, plus small pieces elsewhere. **Agent instructions**: per Agent kind (Inbound, Outbound), written in plain text by an Admin, saved as immutable numbered versions with a diff, publish and rollback; every Agent action records the version it ran under. Instructions sit beneath fixed rules (Contact Consent, disclosure, suppression) that no text can override. **Control levels**: three presets per Agent and channel (Supervised, Assisted, Autonomous) that set the M9 approval policy, send windows and escalation rules, with per-channel overrides; the hard limits never move. **Audit log**: an append-only, hash-chained record of every Agent action and every settings change, written by all services, readable by Admins with filters and CSV. **Data export**: an Admin requests a bounded, asynchronous export; each service contributes its slice; the result is a time-limited download. **Public API**: Admins create API keys with scopes; a key is exchanged for a short-lived token carrying Organization, scopes and an `api_key` actor, so every service verifies it the same way; the routes marked public are published as one OpenAPI document and a developer page. SSO is recorded as a later decision.

## User Stories

1. As an Admin, I want to write instructions for the Inbound Agent and the Outbound Agent separately, so that each behaves as I intend.
2. As an Admin, I want every save to create a numbered version I can read, so that I know what changed.
3. As an Admin, I want to compare two versions line by line, so that I see exactly what changed.
4. As an Admin, I want to publish a version and roll back to an earlier one in one click, so that a bad edit is easy to undo.
5. As an Admin, I want to save a draft version without publishing it, so that I can work safely.
6. As a Manager, I want to read the published instructions, so that I understand why an Agent did something.
7. As a Rep, I want to see which instruction version produced a Draft, so that I can tell the Admin what to fix.
8. As an Admin, I want a banner stating that instructions cannot override Contact Consent, disclosure and suppression, so that nobody believes they can.
9. As an Owner, I want an instruction like "do not disclose that you are an AI" to have no effect, so that we cannot break the rules by accident.
10. As an Admin, I want to choose Supervised, Assisted or Autonomous per Agent, so that I match the freedom to my trust in it.
11. As an Admin, I want each level explained in plain words, including what still needs a person at that level, so that I choose knowingly.
12. As an Admin, I want to override the level for one channel, so that email can be Autonomous while LinkedIn stays Supervised.
13. As an Admin, I want send windows by weekday and time zone, so that Agents write only when I allow.
14. As an Admin, I want escalation rules that name when an Agent must hand over, so that sensitive replies reach a person.
15. As an Admin, I want a one-click "pause all Agents" for the Organization, so that I can stop everything in an emergency.
16. As an Admin, I want a log of every Agent action: draft, approval, send, Call, takeover, escalation, with the instruction version, so that I can reconstruct any event.
17. As an Admin, I want the log to record every settings change with who made it, so that I can answer "who turned that on".
18. As an Admin, I want to filter the log by actor, action, Prospect and date, so that I find an event fast.
19. As an Admin, I want to download the filtered log as CSV, so that I can give it to an auditor.
20. As an Owner, I want to verify that the log has not been altered, so that I can rely on it.
21. As an Owner, I want the log to hold ids and labels but never Message text, recordings or secrets, so that the log is not a new leak.
22. As a Manager, I want to see Agent actions on my Team's Prospects, so that I can supervise.
23. As an Owner, I want to export all my Organization's data, so that I can leave or keep a copy.
24. As an Owner, I want the export to arrive as a download link that expires, so that it cannot be shared forever.
25. As an Owner, I want the export to leave out password hashes, tokens and API keys, so that it is safe to keep.
26. As an Owner, I want to know the export finished or failed, with a reason, so that I am not left waiting.
27. As an Admin, I want to create an API key with a name, scopes and an optional expiry, so that an integration gets only what it needs.
28. As an Admin, I want the key shown once and stored only as a hash, so that a database leak does not expose it.
29. As an Admin, I want to see each key's last use and revoke it immediately, so that a leaked key is contained.
30. As an Admin, I want API actions to appear in the audit log as the key, not as a person, so that I know what was automatic.
31. As a developer using an Organization's key, I want a documented OpenAPI for the public routes and a page to read it, so that I can integrate without asking.
32. As a developer, I want stable `/v1` routes and clear errors, so that my integration does not break.
33. As an Admin, I want a key to be limited in how fast it can call, so that a runaway script cannot take the service down.
34. As an Owner, I want to know SSO is planned and what it will need, so that I can plan an enterprise rollout.

## Implementation Decisions

**Ownership.** Core owns Organization-level instructions, control levels, audit log, exports orchestration and API keys, as the brief proposes: it already holds roles and Teams. The auth service's existing `api_keys` and `audit_logs` tables belong to the vendored tula-auth project model (project and environment scoped), not to an Organization; they stay untouched and new core tables are used. Auth gains one route to exchange a key for a token. Each service owns its own export slice and its own audit emission.

**Instructions.** Tables: `agent_instruction_versions` (Organization, Agent kind, number, text, author, state draft or published, created time) immutable once saved; `agent_instruction_pointer` names the published version. Agent services fetch the published text and version number over the internal client with a short cache; the version number is stamped on every Draft, Call turn and audit event. Text is capped (20,000 characters). Prompt layering is fixed: fixed rules, then instructions, then Playbook, then Prospect text as data; a test fixture proves an instruction that contradicts a fixed rule has no effect.

**Control levels.** `agent_settings` per Organization, Agent kind and channel: level, approval policy, send windows, escalation rules. Supervised: every Draft approved. Assisted: auto-release only grounded, assessment-passing Drafts on low-risk labels, others approved. Autonomous: auto-release except fixed holds (ungrounded, failed assessment, first message). These map onto M9's approval policy so there is one enforcement point. A kill switch `agents_paused` per Organization is checked by every sender.

**Audit log.** Table `audit_events` (Organization, sequence, time, actor kind member, agent, api_key or system, actor id, action in `area.verb` form, subject type and id, instruction version, request id, metadata of ids and labels, previous hash, hash). Append-only: the service role has insert and select only; each row's hash covers its content and the previous hash per Organization, so tampering is detectable by a verify route. Writers: core directly; other services through a kit `AuditRecorder` port (queue adapter, memory adapter) publishing `audit.recorded`, consumed idempotently by core. Retention: 24 months by default, in an ADR. Reads are Admin and Owner for all, Manager for their Team's Prospects, cursor paged.

**Export.** `POST /exports` (Admin or Owner; one running per Organization; at most two a day) creates a job and publishes `export.requested`. Each service writes its slice as newline-delimited JSON plus files to object storage under an export prefix and publishes `export.part_ready`; core builds a manifest and issues a download link valid for 24 hours. Excludes credentials, token and key hashes, and other Organizations' rows. Recordings are included on request as links, not copied inline. Export and its download are audited. Deleting an Organization is separate.

**API keys.** Table `api_keys` in core: Organization, name, prefix (shown), SHA-256 of a 256-bit secret, scopes (`<area>:read|write`), role ceiling (never above the creating Admin's), expiry, last used, revoked. The secret is shown once. `POST /v1/token` on auth takes the key, asks core over the internal call to verify it, and mints a token of 10 minutes with `actor: api_key`, the Organization, scopes and no Membership. Kit's token verification exposes actor and scopes and a `requireScope` guard; routes marked public declare a scope. Per-key rate limit counters live in Postgres. Revocation takes effect at the next exchange, at most 10 minutes. This extends ADR 0005 and needs an ADR.

**Public OpenAPI.** Routes tagged public in each service's OpenAPI are merged by a hub script into one `public-openapi.json` under `/v1`, published by the portal's developer page. Breaking changes require a new version prefix.

**Contract areas.** `agent` (instructions, settings), `audit`, `export`, `apikey`. Errors e.g. `agent.version_not_found`, `agent.instruction_too_long`, `audit.range_too_large`, `export.already_running`, `apikey.scope_not_allowed`, `apikey.revoked`.

**Schema.** Core: `agent_instruction_versions`, `agent_settings`, `audit_events`, `export_jobs`, `export_parts`, `api_keys`, `api_key_usage`. All with `organization_id` and row-level security.

**SSO.** Not built; a decision record states the approach to evaluate (SAML and OIDC through the auth service, tied to ADR 0019's linking model) and that SSO members still carry one Membership role.

## Testing Decisions

Highest seam: core HTTP routes with memory queue, storage and clock; the auth exchange route against core's real route in the dev smoke. Behaviours: saving never mutates an old version; rollback re-points; a contradicting instruction cannot weaken a fixed rule (fixture); Autonomous still holds ungrounded Drafts; pause stops senders; audit rows cannot be updated or deleted (database test) and a broken chain is reported by verify; no Message body or secret appears in audit metadata (property test over writers); export excludes secrets and arrives complete in an integration run with playbook; a key works only for its scopes, once revoked cannot be exchanged, and is shown once; rate limit returns `429`-class error with an `area.reason` code. Cross-Organization test: a second Organization cannot read the first one's instructions, settings, audit rows, exports or keys, cannot use its key, and an export contains none of its rows. Prior art: core idempotency tests, auth token tests, db catalog check for privileges, kit queue suite, playbook sales-history export-shaped data.

## Out of Scope

SSO and SCIM (decision record only); the instruction editor assistant (R71 parity is partial); per-Rep instructions; outgoing webhooks; OAuth apps for third parties; SIEM streaming; legal-hold retention; deleting an Organization's data; billing of API usage.

## Further Notes

New GLOSSARY terms proposed:

- **Agent instructions**: the written guidance an Admin gives an Agent, kept as numbered versions. _Avoid_: Prompt, script, persona.
- **Control level**: how much an Agent may do without a person's approval (Supervised, Assisted, Autonomous). _Avoid_: Autonomy mode, trust level.
- **Audit event**: one immutable record of who or what did what to which subject. _Avoid_: Log line, activity.
- **API key**: a secret an Admin creates so a program can call Closeline for the Organization. _Avoid_: Token (a token is short-lived), access key.

ADRs needed: API keys exchanged for short-lived tokens (extends ADR 0005); audit log design and retention; data export format and expiry; SSO approach. Open: whether Managers should read audit events (assumed yes for their Team's Prospects); retention of 24 months is a proposal.
