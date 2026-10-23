# M11 LinkedIn channel: tickets

### T1: Hub: decision record for the LinkedIn provider
Repo: hub
Blocked by: none

## What to build
An ADR choosing the provider behind the port (proposal: Unipile) with price per account, data location, webhook signing, restriction signals, exit plan, and the starting daily and weekly ceilings with their source. It references ADR 0004 as the policy.

## Acceptance criteria
- [ ] Alternatives and the cost per connected account are stated
- [ ] The ceilings (20 requests, 40 messages a day, 80 requests a week) are recorded or corrected
- [ ] `bun run verify` is green

### T2: Contract: the linkedin area
Repo: contract
Blocked by: none

## What to build
Schemas, routes and error codes for accounts, the risk statement (versioned wording), acceptance, channel settings and usage, plus the events `linkedin.invitation_accepted`, `linkedin.account_paused`, `linkedin.channel_disabled`. Tag a release.

## Acceptance criteria
- [ ] Error codes `linkedin.channel_disabled`, `risk_not_accepted`, `account_not_connected`, `limit_reached`, `not_account_owner`, `limit_above_ceiling` exist
- [ ] The ceilings are exported constants and a schema rejects limits above them
- [ ] The risk wording has a version string; `dist/` rebuilt and committed

### T3: Database: LinkedIn tables in the outbound schema
Repo: db
Blocked by: T2, M07-T2

## What to build
`linkedin_accounts`, `linkedin_risk_acceptances`, `linkedin_channel_settings`, `linkedin_usage` in the outbound schema. Tag a release.

## Acceptance criteria
- [ ] All tables pass the row-level security harness with `organization_id`
- [ ] One account per Rep per Organization is a database constraint
- [ ] Usage rows are unique per account and day; counters cannot go negative
- [ ] Acceptances cannot be updated except to set the revoked time

### T4: Outbound: provider port, memory adapter and account connection
Repo: outbound
Blocked by: T2, T3, M07-T3

## What to build
The `LinkedInProvider` port, the memory adapter, and routes for a Rep to start a connection, read its status and disconnect. Only the account's own Rep can act on it.

## Acceptance criteria
- [ ] A Rep connects, sees `connected`, disconnects; a second Rep cannot disconnect it (`linkedin.not_account_owner`)
- [ ] An Admin cannot create a connection for a Rep
- [ ] A second Organization cannot read or act on the account
- [ ] No provider credential or profile data appears in logs

### T5: Outbound: risk acceptance, channel switch and kill switch
Repo: outbound
Blocked by: T4

## What to build
Read the current risk wording, accept it (Admin, typed name), revoke it, and switch the channel on or off. Enabled only with a current acceptance and the switch on. Publishes `linkedin.channel_disabled`.

## Acceptance criteria
- [ ] A new wording version makes the old acceptance insufficient
- [ ] Revoking or switching off stops queued LinkedIn jobs from sending within one job cycle; email jobs are unaffected (test)
- [ ] Only Admin and Owner can accept; the acceptance shows who and when
- [ ] A second Organization cannot read or use the acceptance

### T6: Outbound: send guard, limits and pacing
Repo: outbound
Blocked by: T5, M03-T6

## What to build
The idempotent LinkedIn send job: guard order (enabled, connected, suppression, quota), atomic quota reservation in Postgres, pacing inside working hours with jitter, connection request and message sends via the port, status pause on restricted results. Admin can lower limits per account.

## Acceptance criteria
- [ ] The 21st request in a day is deferred, not dropped; concurrent workers cannot exceed quota (test with parallel runs)
- [ ] A retried job sends once; a suppressed Prospect is skipped and the step marked skipped
- [ ] A restricted result pauses that account only and publishes `linkedin.account_paused`
- [ ] Raising a limit above the ceiling returns `linkedin.limit_above_ceiling`
- [ ] A second Organization's quota and usage are independent
- [ ] Timeouts and bounded, jittered retries on provider calls; a benchmark covers quota reservation with a budget

### T7: Outbound: webhooks, replies and acceptances
Repo: outbound
Blocked by: T6, M09-T3

## What to build
A signature-verified webhook route turning provider events into inbox Messages (M9 ingest) and `linkedin.invitation_accepted`. A "stop" reply suppresses the Prospect on LinkedIn.

## Acceptance criteria
- [ ] A forged signature is rejected in constant time; a replayed event is a no-op
- [ ] A reply appears once in the inbox for the owning Rep
- [ ] An acceptance event advances the sequence step in a test with the memory queue
- [ ] An event for an unknown account is ignored without revealing existence

### T8: Outbound: Unipile adapter
Repo: outbound
Blocked by: T1, T7

## What to build
The real `LinkedInProvider` adapter, passing the same behaviour suite as the memory adapter. Blocked on credentials.

## Acceptance criteria
- [ ] Shared suite green against both adapters; live test gated on credentials
- [ ] Every call has a timeout and bounded, jittered retry
- [ ] Provider errors map to the typed results; unknown errors do not pause accounts

### T9: Portal: LinkedIn settings, accounts and usage
Repo: portal
Blocked by: T7

## What to build
A LinkedIn screen: the Rep's connect, status and disconnect; the Admin's risk statement, acceptance, revoke, channel switch and limit editor; per-account usage today for Managers and Admins.

## Acceptance criteria
- [ ] The Rep sees the risk notice before connecting
- [ ] The Admin cannot enable until acceptance is recorded; the UI shows who accepted and when
- [ ] A Rep sees only their own account; a Manager sees their Team's usage
- [ ] agent-browser run on the local stack with the memory provider
