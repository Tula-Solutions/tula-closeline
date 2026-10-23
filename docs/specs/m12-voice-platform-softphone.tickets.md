# M12 tickets: Voice platform and softphone

Order: libraries (T2, T3, T4, T5), the service (T6 to T10), the Playbook consumer (T11), the portal (T12 to T14), then the stack (T15, T16). T1 and T2 to T4 start in parallel.

### T1: Create the voice repository
Repo: hub
Blocked by: none

## What to build
`tula-closeline-voice` exists, made with `scripts/new-repo.sh` from `templates/service` with label `repo:voice`, shared setup synced, CI green, branch protection like its siblings, and listed in `COMMON.md`, `AGENTS.md` and `docs/local-development.md`.

## Acceptance criteria
- [ ] `bun run verify` is green in the new repo on `develop` and CI runs.
- [ ] `bun run sync:check` in the hub reports no drift for voice.
- [ ] The repo table in the shared `COMMON.md` names what voice owns.

### T2: Contract `voice` area, v1
Repo: contract
Blocked by: none

## What to build
Schemas, routes and error codes for Lines, Calls, Transcripts, Recording playback, wrap-up and softphone token, plus the `voice.call.started` and `voice.call.ended` events, as listed in the spec. Tag a release.

## Acceptance criteria
- [ ] Every route has a Zod request and response schema, role list and OpenAPI description; list routes use the cursor schema with a page size of at most 100.
- [ ] Error codes `call.number_invalid`, `call.disclosure_failed`, `call.not_found`, `line.not_found` exist and are `area.reason`.
- [ ] The place-a-Call request requires an idempotency key; schema tests reject its absence.
- [ ] Event schemas carry the contract event envelope and no Transcript text or phone number in clear.
- [ ] Rebuilt `dist/` committed and tag pushed.

### T3: `voice` schema and migration
Repo: db
Blocked by: none

## What to build
The `voice` schema with `lines`, `calls`, `call_events`, `recordings` and the voice database role, with fail-closed row-level security on every table.

## Acceptance criteria
- [ ] Migration generated, applied and checked with `db:check`; no `drizzle-kit push`.
- [ ] RLS harness test: a session for Organization B reads zero rows of Organization A in all four tables and cannot insert rows for A.
- [ ] `call_events` has a unique key on provider event id per Organization (used for idempotent webhooks).
- [ ] Tag a release.

### T4: Telephony port and memory adapter
Repo: kit
Blocked by: none

## What to build
`TelephonyPort` (place, answer and ring, play Disclosure, bridge, record, fork tracks, hang up, fetch and delete provider Recording, verify webhook, mint browser token) with a scripted memory adapter and a shared behaviour suite.

## Acceptance criteria
- [ ] The behaviour suite runs against the memory adapter and covers every method including timeouts and a failing provider.
- [ ] The memory adapter can script: a Prospect who answers, does not answer, hangs up, and a carrier failure.
- [ ] Signature verification uses constant-time comparison and has a test with a wrong signature.
- [ ] Exported with JSDoc; `dist/` rebuilt; tag pushed.

### T5: Twilio telephony adapter
Repo: kit
Blocked by: T4

## What to build
The Twilio implementation of `TelephonyPort` (Voice, Voice SDK token, dual-channel recording, Media Streams fork, Ireland region option). Blocked on credentials; the memory adapter keeps everyone else moving. Includes a short written check that a Voice SDK leg yields two separate tracks.

## Acceptance criteria
- [ ] The T4 behaviour suite passes against Twilio when credentials are set and is skipped, named, when they are not.
- [ ] Every outbound call to Twilio has a timeout and a bounded, jittered retry; no secret or number is logged.
- [ ] The two-track check result is recorded in the PR, or the PR says it could not be verified.

### T6: Voice service skeleton and Lines
Repo: voice
Blocked by: T1, T2, T3, T4

## What to build
Container, env schema (`REGION`, queue, storage, telephony), token middleware, OpenAPI, and the Lines routes: an Admin adds a Line (memory adapter), lists, assigns to a Rep or Team, releases.

## Acceptance criteria
- [ ] Add, list, assign and release a Line over HTTP; a Rep gets 403 on add.
- [ ] A second Organization's Admin cannot list, assign or release the first one's Lines.
- [ ] Lists are cursor-paginated with a maximum page size.
- [ ] `bun run verify` green; `/healthz` and readiness work.

### T7: A Rep places a Call; Disclosure; recording; wrap-up
Repo: voice
Blocked by: T6

## What to build
A Rep places a Call (idempotent), the Call walks `ringing → connecting → disclosing → live → ended`, the Disclosure plays before the legs are bridged, recording starts after it, and the Rep can wrap up and list or read their Calls.

## Acceptance criteria
- [ ] On the memory adapter, the event log shows `disclosure.played` before `bridged` and `recording.started`; a Disclosure failure ends the Call `failed` and never `live`.
- [ ] The same idempotency key places exactly one Call.
- [ ] An exhaustive state-transition test fails if `live` is reachable without a stored Disclosure version.
- [ ] Rep sees own Calls, Manager the Team's, Admin all; Organization B sees none of them (second-Organization test).
- [ ] A number that is not valid E.164 answers `call.number_invalid`.

### T8: Inbound Calls ring Reps; missed Calls
Repo: voice
Blocked by: T7

## What to build
An inbound Call to a Line rings the assigned Rep or the Team's online Reps; the first to answer gets it after the Disclosure; unanswered Calls are recorded as `missed` with the caller number.

## Acceptance criteria
- [ ] Two Reps ring, one answers, the other's ring stops; the answered Call has a Disclosure before bridge.
- [ ] No answer within the ring time yields `missed`, listed for the assigned Reps only.
- [ ] A Line of Organization A never rings a Rep of Organization B.

### T9: Recording copy, `voice.call.ended`, internal fetch
Repo: voice
Blocked by: T7

## What to build
When a Call ends, a queued, idempotent job copies the dual-channel Recording to Region storage, deletes the provider copy, publishes `voice.call.ended`, and serves the Recording to the Playbook over the internal route. An Admin can delete a Recording.

## Acceptance criteria
- [ ] Re-delivering the job does not duplicate the Recording or the event.
- [ ] The internal route rejects a request without the shared secret and never serves another Organization's Recording.
- [ ] Deleting a Recording removes the file after the purge time and answers idempotently.
- [ ] A signed playback URL expires and is scoped to the caller's visible Calls.

### T10: Twilio webhooks and softphone token
Repo: voice
Blocked by: T5, T7

## What to build
Real provider events: signed status and recording webhooks, inbound routing webhook and the browser access token route, wired to the Twilio adapter.

## Acceptance criteria
- [ ] A webhook with a bad signature answers 403 and changes nothing; a duplicate event id changes nothing.
- [ ] Handler p95 within the budget in `bench/webhook.bench.test.ts` with the measured number in a comment.
- [ ] The token is short-lived and carries only the Rep and Organization.

### T11: Playbook ingests ended Calls
Repo: playbook
Blocked by: T9

## What to build
A consumer of `voice.call.ended` that fetches the Recording, treats channel 1 as the Rep, transcribes it and creates a Call (`source=live`) linked to the Deal identifier from wrap-up; held out of search until the Deal is won.

## Acceptance criteria
- [ ] An ended Call becomes a Call with Moments; search does not return it until its Deal is won, then returns it.
- [ ] Redelivery is idempotent through the consumed-message table.
- [ ] A Call of Organization A never appears in Organization B's search.
- [ ] A Call with no Deal identifier waits in a named state and is listed for an Owner or Admin.

### T12: Softphone in the portal
Repo: portal
Blocked by: T10

## What to build
A persistent Softphone panel: microphone check, dial pad and number field, ring, answer, mute, hold, hang up, and a visible Disclosure state ("playing", "played v3").

## Acceptance criteria
- [ ] With the memory adapter, a Rep dials and the panel shows Disclosure then live, then ended.
- [ ] An inbound ring shows the caller number and Answer.
- [ ] A denied microphone shows a plain message and a retry.
- [ ] Verified with `agent-browser`; the real microphone path is listed as not verified.

### T13: Call history, Transcript and playback
Repo: portal
Blocked by: T9

## What to build
Call history and detail with filters, Transcript, wrap-up form (Deal identifier, note) and Recording playback, shown by role.

## Acceptance criteria
- [ ] Rep sees own, Manager Team, Admin all; the list pages by cursor.
- [ ] An Admin can delete a Recording with confirmation.
- [ ] Playback uses the signed URL and stops when it expires.

### T14: Lines admin in the portal
Repo: portal
Blocked by: T6

## What to build
Admin page to add, assign and release Lines.

## Acceptance criteria
- [ ] Add, assign to Team or Rep, release; errors show their `area.reason` message.
- [ ] A Rep does not see the page.

### T15: Voice in the local stack and `dev:smoke`
Repo: hub
Blocked by: T10, T11

## What to build
`bun run dev` starts voice on the memory adapter; `dev:smoke` places a Call, checks Disclosure order, ends it and sees it in the Playbook.

## Acceptance criteria
- [ ] `bun run dev:smoke --strict` passes with the new steps, including an Organization isolation check on Calls.
- [ ] `docs/local-development.md` documents voice.

### T16: Voice service on ECS
Repo: infra
Blocked by: T10

## What to build
Voice deployed in each Region with a load balancer that allows WebSockets and long idle timeouts, Twilio webhook ingress, and its queue and bucket.

## Acceptance criteria
- [ ] The dev environment serves `/healthz` and accepts a signed test webhook.
- [ ] Idle timeout is longer than the longest allowed Call; a deploy drains Calls without dropping them (or the PR says how it does not).
