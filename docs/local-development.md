# Local development

One command runs the Closeline stack on your machine: Postgres 18, two local stand-ins and a local
mailbox in Docker, then core, auth, the playbook, voice, outbound and the portal from their sibling clones. This is plan step 1.19
(hub issue 20); the mailbox and the end-to-end smoke test are hub issue 38.

```bash
bun run dev           # compose up, migrate, start core, auth, the playbook, voice, outbound and the portal; Ctrl-C stops the six
bun run dev:smoke     # in another terminal: signs up and checks the running stack over HTTP
bun run dev --down    # stop the running stack (SIGTERM to its bun run dev, SIGKILL after 20 s), then the compose containers (keeps the data)
bun run dev --down --volumes   # also delete the database and storage data
bun run dev:smoke --strict     # as dev:smoke, but a skipped step is an error (meant for CI, see below)
# read the emails the services send: open http://127.0.0.1:8026
```

After a change, run the `run-check` skill (`shared/.claude/skills/run-check/SKILL.md`): it uses this
stack, the smoke test and, for the portal, `agent-browser` to run the change for real.

## Before the first run

- Docker Compose 2.17.0 or newer (the release that added `up --wait-timeout`; developed on 5.5.1)
  and Bun. Docker must be local: the script refuses any Docker endpoint that is not a unix socket
  (it checks `DOCKER_HOST` and, when that is unset, `docker context inspect`; if `docker` is not
  installed or not on `PATH` it says so and exits 1, with no stack trace), so it cannot start
  containers or change database roles on a remote host. `DOCKER_HOST`, `DOCKER_CONTEXT` and
  `DOCKER_CONFIG` are passed to the compose commands only, so Colima, Rancher and Podman sockets
  work; no other process gets them. `--down` and `--down --volumes` go through the same check
  before any Docker command, so they cannot delete volumes on a remote host. The check accepts any
  `unix://` socket: it cannot tell a daemon on this machine from a remote one reached through a
  forwarded socket (for example `ssh -L /tmp/docker.sock:/var/run/docker.sock`), so do not point
  `DOCKER_HOST` or a context at such a socket.
- Clone `tula-closeline-db`, `-auth`, `-core`, `-playbook`, `-voice`, `-outbound` and `-portal` next to this repo (or point
  `CLOSELINE_SIBLINGS_DIR` at the folder that holds them) and run `bun install` in each. The git
  dependencies are private; if you have no SSH key on GitHub, do the one-time `gh auth setup-git`
  and `git config --global url...insteadOf` step in any clone's `README.md` ("Getting started").
- `tula-closeline-voice` is started too, for its Lines routes (see "Voice" below). It never talks to Twilio here.
- The script reads the clones, it never edits them: it does not switch branches, write files or
  run `drizzle-kit push`. Each clone runs whatever branch it has checked out. The script also
  refuses to migrate or change a role unless the database address it built is a loopback address.

The script stops with a message, before starting anything, if a clone is missing, is not the repo
it should be, has no `node_modules`, or a port is taken.

## What runs

| Part | Where | Notes |
| --- | --- | --- |
| Postgres 18.6 (`postgres:18.6-alpine`) | `127.0.0.1:5440` | database `closeline`; roles from `tula-closeline-db`'s own `docker/postgres/init.sh` |
| Mailbox: Mailpit v1.31.5 (web UI and HTTP API) | `http://127.0.0.1:8026` | in memory, so `--down` or a restart empties it; its update check is off (`MP_DISABLE_VERSION_CHECK`), so it makes no outbound call; the SMTP port (1025) is not published; auth and core send to it through `MAIL_LOCAL_URL` |
| Queue stand-in: ElasticMQ 1.7.1 (SQS API) | `http://127.0.0.1:9324` | queues `closeline-dev` and `closeline-dev-dlq` (placeholder names); its `/data` is a tmpfs, so no anonymous volume is left behind |
| Object storage stand-in: Adobe S3Mock 5.2.3 (S3 API) | `http://127.0.0.1:9090` | bucket `closeline-dev`; any credentials; path-style addressing |
| core | `http://127.0.0.1:3100` | `bun src/server.ts` in `tula-closeline-core` |
| auth | `http://127.0.0.1:3001` | `bun src/server.ts` in `tula-closeline-auth` |
| playbook | `http://127.0.0.1:3003` | `bun src/server.ts` in `tula-closeline-playbook`: the API, the ingestion job loop (documents, Calls, Recordings, Deal imports) and the sweeps, all in this one process (see "The playbook" below) |
| outbound | `http://127.0.0.1:3005` | `bun src/server.ts` in `tula-closeline-outbound`; connects a Gmail Mailbox through the fake Google provider (see "Gmail Mailbox" below) |
| voice | `http://127.0.0.1:3004` | `bun src/server.ts` in `tula-closeline-voice` with `TELEPHONY_PROVIDER=memory` (see "Voice" below) |
| portal | `http://127.0.0.1:3002` | Vite dev server in `tula-closeline-portal` |
| fake Google | `http://127.0.0.1:3010` | `bun scripts/dev-fake-google.ts` in this repo, started only when no `GOOGLE_*` is set in your shell (see "Sign in with Google" below) |

Ports 5434 to 5437 are the repos' own test databases and 5432 is left for whatever else you run, so
the dev Postgres is on 5440. Mailpit's usual port 8025 is often taken by another project's mailbox,
so this one is on 8026. Override any port with `CLOSELINE_DEV_POSTGRES_PORT`,
`CLOSELINE_DEV_QUEUE_PORT`, `CLOSELINE_DEV_STORAGE_PORT`, `CLOSELINE_DEV_MAIL_PORT`,
`CLOSELINE_DEV_AUTH_PORT`, `CLOSELINE_DEV_CORE_PORT`, `CLOSELINE_DEV_PLAYBOOK_PORT`, `CLOSELINE_DEV_VOICE_PORT` (3004), `CLOSELINE_DEV_OUTBOUND_PORT` (3005), `CLOSELINE_DEV_PORTAL_PORT` and `CLOSELINE_DEV_FAKE_GOOGLE_PORT` (3010). Every port binds to `127.0.0.1` only.
Every image is pinned to an exact version and digest in `compose.dev.yaml`.

Why these stand-ins: ADR 0001 gives each Region its own queues, and the plan (steps 1.10, 1.12 and
1.18) builds the queue port with an AWS adapter and the object storage port with an S3 adapter.
ElasticMQ speaks the SQS API and S3Mock the S3 API; each is one small container that needs no
account and starts in seconds, and both publish amd64 and arm64 images.

**The mailbox.** Mailpit catches mail and never delivers it: nothing sent to it leaves your
machine. auth (verification codes) and core (Invitation emails) get `MAIL_LOCAL_URL=http://127.0.0.1:<mailbox port>`,
which their local mail adapters accept only for `ENVIRONMENT=local` and only for a loopback address
(`http://127.0.0.1`, `http://[::1]` or `http://localhost`). The sender address is left to each
service's default (`MAIL_LOCAL_FROM` is not set). Sign-up codes and Invitation links appear in the
mailbox's web UI; both are secrets, so open it only on your own machine. The portal and the
migration get no mail setting.

**Core's queues.** core gets `JOBS_QUEUE_URL` (queue `core-jobs`, dead letters to `core-jobs-dlq`)
and `AUDIT_QUEUE_URL` (queue `core-audit`, dead letters to `core-audit-dlq`), both defined in
`scripts/dev/elasticmq.conf`, plus `QUEUE_ENDPOINT` and dummy AWS credentials. Without them core falls
back to in-memory queues, which hide a broken queue wiring. No other dev service publishes
`audit.recorded`, so nothing else is pointed at `core-audit`.

**The playbook** is the first service to use the queue and object storage stand-ins. It runs with
`ENVIRONMENT=local` and gets: the `closeline_playbook` database role; `QUEUE_URL` and
`QUEUE_ENDPOINT` for ElasticMQ (the queue `closeline-playbook`, defined in
`scripts/dev/elasticmq.conf`, dead letters to `closeline-dev-dlq`); `STORAGE_BUCKET` and
`STORAGE_ENDPOINT` for S3Mock (bucket `closeline-dev`); placeholder AWS credentials, because the
SDK will not sign a request without some (both stand-ins ignore them); the same `AUTH_JWKS_URL`,
`AUTH_ISSUER` and `AUTH_AUDIENCE` core uses; and its own internal secret
(`INTERNAL_API_TOKENS`, generated each run and different from the one auth and core share, followed
by the one voice presents). Its
polling loops are set to 1 s (`INGESTION_POLL_INTERVAL_MS`, `TRANSCRIBE_POLL_INTERVAL_MS`) so a
test does not wait on the 5 s defaults. The vector store, embedder, OCR reader and transcriber have
no real adapter yet; the playbook runs in-process stand-ins for them and allows that only when
`ENVIRONMENT=local`. So a Recording is "transcribed" by a scripted stand-in (four turns, two
speakers, no Rep), not by listening to the audio, and the vectors are lost when the process stops.
API and workers are one process: `WORKERS_ENABLED` defaults to true for `local`, and the job loop
and the sweeps start after the server listens. To run an API-only playbook, run it by hand with
`WORKERS_ENABLED=false`.

**Voice** runs with `ENVIRONMENT=local`, the `closeline_voice` database role (after the migrations) and
`TELEPHONY_PROVIDER=memory`: numbers for a new Line come from voice's in-memory number provisioner,
so no real Twilio account, number or charge is involved, and Lines disappear when voice restarts
(their rows stay in the database). It gets the auth JWKS settings and no queue, storage or vendor
setting.

For real calls, set `TELEPHONY_PROVIDER=twilio` and the `TWILIO_*` keys in Infisical dev `/voice` and
start with `--tunnel`: voice then uses Twilio and `WEBHOOK_BASE_URL` is the tunnel origin. Without
`--tunnel` Twilio could not reach the webhooks, so voice keeps its stand-in and the script says so.

**The portal reaches the playbook through its dev server.** The portal calls only its own origin; its
dev server proxies `/v1/client` to auth, `/v1/organization`, `/v1/members`, `/v1/invitations` and
`/v1/teams` to core, `/v1/playbook` to the playbook and `/v1/lines` to voice. The script gives it the four targets the
portal reads (`AUTH_PROXY_TARGET`, `CORE_PROXY_TARGET`, `PLAYBOOK_PROXY_TARGET`, `VOICE_PROXY_TARGET`, see the portal's
`.env.example`) and no other service setting. Nothing in the portal needs to change.

## Sign in with Google

Auth's Sign in with Google (ADR 0019) needs an OpenID provider. `bun run dev` gives it one of two:

**The fake provider (the default).** With none of `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and
`GOOGLE_REDIRECT_URI` set in the shell you run `bun run dev` from, the script starts
`scripts/dev-fake-google.ts` on `127.0.0.1:3010` (first of the processes, stopped with the stack,
including by `--down`) and gives:

- auth: `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (fixed development values),
  `GOOGLE_REDIRECT_URI=http://127.0.0.1:3002/v1/client/google/callback` (the portal's own origin and
  port, so the portal's proxy serves the callback) and `GOOGLE_ISSUER_URL=http://127.0.0.1:3010`
  (auth accepts it only with `ENVIRONMENT=local`);
- the portal: `VITE_GOOGLE_FAKE_ISSUER_HOST=127.0.0.1:3010`, the one host the browser may be sent to
  besides Google.

"Continue with Google" then opens a plain HTML page on the fake: type any email (or arrive with a
`login_hint`) and submit. The fake checks the client id and secret, the redirect URI and PKCE (S256)
and returns an RS256 ID token with `iss`, `aud`, `nonce`, `email`, `email_verified: true` and a `sub`
that is the same for the same email, so signing in again is recognised. No Google account, no
network and no secret is involved; nothing is stored beyond the running process.

The fake binds `127.0.0.1` only. **With a tunnel (`CLOSELINE_DEV_PUBLIC_ORIGIN`) and the fake
provider, the Google flow works only from the machine running the stack**: the authorization page
and the redirect back are on loopback addresses, which another device cannot reach. Use real Google
for a flow from another device.

**Real Google.** Set all three in the shell before `bun run dev` and no fake is started and no
issuer override is passed:

```bash
GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... \
GOOGLE_REDIRECT_URI=http://127.0.0.1:3002/v1/client/google/callback bun run dev
```

Create an OAuth client of type "Web application" in the Google Cloud Console (APIs and Services,
Credentials) and add these under "Authorized redirect URIs", exactly:

- `http://127.0.0.1:3002/v1/client/google/callback` (this machine; change the port if you moved the
  portal);
- `https://<tunnel-host>/v1/client/google/callback` (when you use a tunnel).

With `CLOSELINE_DEV_PUBLIC_ORIGIN` set, you choose which one `GOOGLE_REDIRECT_URI` is: the tunnel one
to sign in through the tunnel, the loopback one to sign in on this machine. The script refuses any
other value (it must be the callback path on the portal origin or on the tunnel origin), and refuses
a mix (only some of the three set) naming the missing variable, never a value. The client secret is
scrubbed from the services' output like the generated secrets. `GOOGLE_ISSUER_URL` in your shell is
ignored.

**Switching between the fake and real Google.** A user created through the fake is linked to the
fake's `sub`, not Google's. Signing in later with the same email through real Google is refused
(ADR 0019 section 3: an account is matched by its `sub`, never by email). To switch, use a different
email, or reset the local data with `bun run dev --down --volumes`.

### Gmail Mailbox

The same fake also plays Google for outbound's Gmail Mailbox, so a Mailbox can be connected, refreshed,
revoked and sent through with no Google account. Besides the sign-in endpoints it serves, on loopback:

- `POST /token` with `grant_type=refresh_token` (client id and secret checked; `invalid_grant` for an
  unknown token). With `access_type=offline` at `/authorize` the code exchange also returns a refresh
  token; without it, none;
- `POST /revoke` (200 for a known token, 400 `invalid_token` otherwise; revoking a refresh token also
  ends its access tokens);
- `POST /gmail/v1/users/me/messages/send` (Bearer must be a live access token, body `{raw, threadId?}`).
  The message is kept in memory, headers only (never the body);
- `GET /fake/sent` lists what was sent (`from`, `to`, `subject`, `id`, `threadId`, `at`, `bytes`).

With the fake, `bun run dev` gives outbound `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (fixed,
not-for-deploys values), `GOOGLE_AUTH_URL`, `GOOGLE_TOKEN_URL` and `GOOGLE_REVOKE_URL` on the fake,
`GMAIL_API_BASE_URL` (the fake's origin) and `MAIL_OAUTH_REDIRECT_URI`
(`http://127.0.0.1:3002/mailboxes/connect/callback`, on the portal origin). The fake accepts that
redirect URI as well as the sign-in one (`FAKE_GOOGLE_MAIL_REDIRECT_URI`). With real Google none of
these is passed, so outbound keeps its in-memory Mailbox provider.

`bun run dev:smoke` covers the fake provider (see below) and skips the Google steps, with the
reason, when the stack uses real Google or has Google off.

## Order of a start

1. Checks the clones, `docker compose`, and that the ports are free. A compose container that is already running keeps its port; every one that is not (for example the mailbox, when the stack was started by an older version of this file) has its port checked, and a clash is reported before anything starts.
2. `docker compose up -d --wait` on `compose.dev.yaml` (project `closeline-dev`), until all four
   containers are healthy, then waits for the mailbox to answer `GET /livez` on the host port. A
   mailbox that does not answer stops the start (exit 1) before any role is touched.
3. Asks the database which roles can log in (`rolcanlogin`) and stops if any is not in the
   rotation list (`ROLES` in `scripts/dev-lib.ts`), then gives each of the six login roles
   (`postgres`, `closeline_owner`, `closeline_auth`, `closeline_core`, `closeline_playbook`,
   `closeline_voice`) a new random password. The password is sent as a SCRAM-SHA-256 verifier, never as clear text, so a
   failed statement cannot put it in the Postgres log. The compose file's values only create the
   database once, and a test fails if a `*_PASSWORD` there has no role in the list.
4. Creates any NOLOGIN role of the db clone's `docker/postgres/init.sql` (`NOLOGIN_ROLES` in
   `scripts/dev-lib.ts`) that a volume made before a migration needed it lacks, and grants it to the owner role.
   `init.sql` runs only on a fresh volume; this keeps an older one migrating without a reset. A test
   fails if `init.sql` has a NOLOGIN role the list does not.
   Then runs `scripts/migrate.ts` of the `tula-closeline-db` clone as the owner role (the script its
   `db:migrate` runs, started directly with `--no-env-file`).
5. Starts core, then auth (which calls core), then the playbook, then voice, then the portal, waiting for each to answer 2xx (`/readyz`; the playbook's checks its database).
6. Checks the wiring: core accepts the shared internal secret and refuses a wrong one.

Each child's output is prefixed (`[core]`, `[auth]`, `[playbook]`, `[voice]`, `[portal]`) and scrubbed of this run's
secrets. If one exits, or any step after the first spawn fails, the others are stopped and the
script exits 1. On Ctrl-C, SIGTERM or SIGHUP it stops the six services and leaves compose
running, so the next start is quick. A second signal while a start-up step is still stopping kills
that step's process (SIGKILL) instead of waiting for it, and says so; a third does nothing. Once
the services run, signals belong to the supervisor, and a signal during shutdown prints no
start-up message. A signal during `docker compose up`, the role rotation or the
migration stops that step's process, starts no service and exits 130. The docker, psql and
migrate steps each have a timeout. Stopping a step kills the client, not the work it asked for: a
`docker compose exec psql` that times out or is interrupted may still finish inside the container.
That is harmless here, because the rotation is idempotent (it sets the same five roles to a
password the next start replaces) and runs again on every start.
A SIGKILL of the script itself cannot be caught and leaves the services running; the next start's
port check names them (`port 3001 (auth) is already in use`), and you stop them by hand.

## Secrets

Generated with a secure random source each run, kept in memory and in the children's environment,
never written to a file and never printed (output is also scrubbed of their values):

- the passwords of the five Postgres login roles above, and
- the internal secret auth presents to core (`CORE_INTERNAL_TOKEN` in auth, `INTERNAL_API_TOKENS`
  in core), and
- the playbook's own internal secret (`INTERNAL_API_TOKENS` in the playbook only), and
- the internal secret voice presents to the playbook (`PLAYBOOK_INTERNAL_TOKEN` in voice, listed
  after the playbook's own in its `INTERNAL_API_TOKENS`); voice's `PLAYBOOK_INTERNAL_URL` is the
  playbook's origin (a voice build without those settings ignores them), and
- the internal secret voice presents to core's internal directory (`CORE_INTERNAL_TOKEN` in voice,
  listed after auth's in core's `INTERNAL_API_TOKENS`); voice's `CORE_INTERNAL_URL` is core's origin, and
- the internal secret core presents to voice's internal routes (`VOICE_INTERNAL_TOKEN` in core, voice's
  `INTERNAL_API_TOKENS`); core's `VOICE_INTERNAL_URL` is voice's origin.

One value is fixed: auth's `AUTH_MASTER_KEY` is left unset, so auth uses its built-in development
key, which it refuses outside `ENVIRONMENT=local`. It seals the signing keys stored in the
database, so a new one each run would lock them out. All services run with `ENVIRONMENT=local`.
The environment a child gets is built from a short allowlist, so a `DATABASE_URL` or
`ENVIRONMENT` exported in your shell cannot leak in. No `.env` file is read: `bun run dev` and
`bun run dev:smoke` start Bun with `--no-env-file` (run `bun scripts/dev.ts` directly and you must
pass it yourself), the services and the migration run with `--no-env-file` (the migration as a
script file, because a nested `bun run` would load one), and the compose commands run with
`--env-file /dev/null`, which stops compose loading a `.env` from the hub. That isolation ends at
the services' own code: nothing here stops a service reading a file itself.

The bootstrap passwords in `compose.dev.yaml` are placeholders for the first start only; the
script replaces the password of every login role on every start, so none stays valid.

## Secrets from Infisical

The owner keeps sandbox vendor credentials in Infisical (project Tula-Closeline, environment `dev`),
one folder per repo: `/hub`, `/auth`, `/core`, `/playbook`, `/voice`, `/outbound`, `/portal`. The
keys exist with empty values until someone fills them in.

When the hub has `.infisical.json` (committed; it holds only the project id) `bun run dev` runs
`infisical export --env=dev --path=/<folder> --format=json` for each folder and parses it in memory:

- Only non-empty values are used, so an empty key keeps the fake or memory adapter.
- A value joins its service's environment after the allowlist. It never replaces a value the script
  generates or fixes: `DATABASE_URL`, `INTERNAL_API_TOKENS`, `AUTH_MASTER_KEY`, `ENVIRONMENT`, the
  `*_INTERNAL_TOKEN` / `*_INTERNAL_SECRET` keys and anything else the script already sets are
  ignored, with a line naming the key.
- `/hub` feeds the script itself (`CLOSELINE_DEV_PUBLIC_ORIGIN`). `/auth` may hold the three
  `GOOGLE_*` keys: all three select real Google and turn the fake provider off, a partial set is
  refused as in "Sign in with Google". A variable set in your shell wins over Infisical.
- Every value is scrubbed from output like the generated secrets, never written to a file and never
  logged; messages name keys only. At start the script prints which keys are real and which are
  faked, by name.
- Callback URLs differ between this stack and the AWS dev stage that shares the `dev` environment, so
  Infisical's `GOOGLE_REDIRECT_URI`, `CALENDAR_REDIRECT_URI`, `MAIL_OAUTH_REDIRECT_URI` and
  `WEBHOOK_BASE_URL` are never used. Where the matching key is filled in, the script derives the
  value: from `CLOSELINE_DEV_PUBLIC_ORIGIN` (shell or `/hub`) when set, else the portal's local
  origin (`WEBHOOK_BASE_URL` has no local default and is left unset). Real Google needs the client
  id and secret from Infisical; the redirect URI alone does not turn it on.
- If the export fails (not logged in, no network, no access) one line says so and the stack starts
  with its fakes, exactly as without Infisical.

Log in with `infisical login`, then `infisical init` once in the hub to write `.infisical.json`; or
set `INFISICAL_TOKEN` to a machine identity token. `bun run dev -- --no-infisical` turns it off.
`bun run dev:smoke` prints the same real/faked report (from Infisical, so it does not know a stack
started with `--no-infisical`).

## What the smoke test covers

`bun run dev:smoke` calls the running stack over HTTP (every call with a timeout and a bounded
retry; a sign-up, sign-in, verification or refresh is sent once, never retried) and prints PASS,
FAIL or `skipped: <reason>` per step. It exits 1 if a step fails; with `--strict` it also exits 1
if any step is skipped. In a healthy stack nothing is skipped, so `--strict` is the mode for CI. No workflow runs the
stack yet: `.github/workflows/verify.yml` runs the hub's own checks only. Until a workflow starts
the stack and runs `bun run dev:smoke --strict`, a person runs it.

| Step | What it checks |
| --- | --- |
| auth ready, core ready, portal served, playbook ready, voice ready, the mailbox ready, auth publishes EdDSA signing keys | each answers |
| core refuses a request with no token and with a malformed one | `401 auth.unauthenticated` and `401 auth.token_invalid` |
| sign up | `POST /v1/client/sign-ups` with a fresh `smoke-<random>@closeline-smoke.test` address (a reserved domain), a random password and an Organization name |
| read the verification code | looks the email up in the mailbox (bounded wait) and takes the six-digit code from it. Only a message whose `To` is exactly this run's address counts (Mailpit's `to:` search is a substring match); one message holding two codes, two links or none is an error; a late email is waited for until the deadline; a mailbox that answers 5xx or not as Mailpit does is reported as a mailbox failure, not as a missing email |
| verify the email code, sign in | the code is accepted; sign-in with the password gives a session |
| core `GET /v1/organization` and `GET /v1/members` | with the access token: the Organization in the token, and exactly one member, the Owner |
| refresh the session | the refresh token rotates and the new access token works at core; the spent refresh token is not reused here (the next row does that on its own session). The access token may be the same string as the last (it holds the session id and a one-second issue time), so only the refresh token is compared |
| refresh through the portal with its Origin | `POST /v1/client/sessions/refresh` through the portal's dev server with the portal's `Origin`; auth must allow it (`SESSION_ALLOWED_ORIGINS` is set to the portal origin, port override included), or the portal shows "not set up correctly for this address" |
| create an Invitation | `POST /v1/invitations` for a new address, role `rep`, with an `Idempotency-Key` |
| the Invitation email and its link | the email reaches the mailbox and its link points at the portal's `/sign-up` page |
| create a Team | `POST /v1/teams` as the first user, for the isolation checks |
| core: a bulk assignment of more than 500 Prospects is queued and completes | a Rep joins the first Organization through their own Invitation (sign-up with the emailed token); the Owner creates a Prospect (`POST /v1/prospects`) and sends 501 ids (it and 500 that do not exist) to `POST /v1/prospects/assign` with the Rep as new owner: `202` `queued`. Core has no job-status route and the queued answer has no counts, so it polls `GET /v1/prospects/{id}` until the owner is the Rep, within 60 s. This proves core reads `JOBS_QUEUE_URL` and its worker applies the job from the ElasticMQ queue |
| a second sign-up cannot read the first Organization | a second, different user gets a different Organization id. Reads: `GET /v1/organization`, `/v1/members`, `/v1/invitations` and `/v1/teams` with their token return nothing of the first (its Organization id, address, user and membership ids, Invitation and Team ids). The first Organization id sent in an `x-organization-id` header or an `organizationId` query with the second token is ignored or refused. Writes by id with the second token against the first Organization (`DELETE /v1/invitations/{id}`, `PATCH` and `DELETE /v1/teams/{id}`, `POST /v1/teams/{id}/members`, `PATCH /v1/members/{id}`, `POST /v1/invitations` with its `teamId`) each answer `404` with the documented code (`invitation.not_found`, `team.not_found`, `member.not_found`), and the first Organization is unchanged. Positive control: the first user then renames and deletes their own Team and revokes their own Invitation, so a route that answers `404` to everyone fails |
| **Sales history** (below): confirm the rights wording; upload a Transcript; the first Call created its Deal, open; the Transcript is processed into Moments; upload a Recording; the Recording is transcribed; import a three-row Deal CSV; the import is applied; the Outcome reaches the Moments; a second Organization cannot see any of it; delete the Call and it is gone | the playbook, as the Owner, through its public routes only |
| **Sign in with Google** (nine steps, `google: ...`): `auth-options` says Google is on; `start` returns an authorization URL on the fake provider; the provider's page is served; approving a fresh email redirects to the portal's callback; the callback through the portal sends a new person to `/sign-up/google?attempt=`; `complete` with an Organization name (sending the attempt cookie and the portal's `Origin`) gives a session and a refresh cookie; `/v1/client/me` shows the person; a second sign-in with the same email goes straight to the app with a refresh cookie; a replayed callback goes to `/sign-in?error=oidc.state_invalid` | auth's Google routes end to end against `scripts/dev-fake-google.ts`, playing the browser. Only a URL on the fake provider's own address is followed. If Google is off, or the stack uses real Google (which needs a person), the steps are skipped with the reason, so `--strict` fails |
| **Mailbox** (two steps, `mailbox: ...`): connecting a Gmail Mailbox through the fake provider (`POST /v1/mailboxes/connect`, approve at the fake, the redirect goes to the portal, `connect/complete` gives a Mailbox); a test message sent through it (`POST /v1/mailboxes/{id}/test-send`) shows up in `GET /fake/sent` | outbound's Mailbox routes against the fake Gmail. Skipped with the reason when outbound or the fake is not in use (real Google). The send is skipped, so `--strict` fails, while outbound answers 404 on the test-send route (it ships after the Mailbox change) |
| **Voice Lines** (`voice: ...`): an Owner buys a Line (`POST /v1/lines`, `Idempotency-Key`) and finds it in `GET /v1/lines`; a second Organization lists none of the first's Lines and gets `404 line.not_found` reading one by id | voice, through its public routes only, with the tokens from the earlier steps (skipped if the second Organization was not created) |
| **Booking** (eight steps, `booking: ...`): the Rep connects core's local calendar (`POST /v1/calendar-connection/start`, then `complete` with the local code) and it reads `healthy`; the Rep sets weekly hours (`PUT /v1/availability`); the Owner makes a Booking Type and a default routing rule that targets the Rep; the public slots by the link token return times and name no Rep; a public booking answers `201`, and the same `Idempotency-Key` again `200` with the same Booking; the Owner lists it as `confirmed`, origin `public`; the same time with a new key is `409 booking.slot_taken`; a second Organization lists none, reads it as `404 booking.not_found`, and the first Organization cannot book with the second one's Booking Type and Prospect | core's public Booking routes and the signed-in list, over HTTP. Core shows nothing of the calendar event, so the event itself is not checked. Skipped with the reason if the Rep or the second Organization was not created |
| a replayed refresh token is refused and ends its session | last, on a throwaway sign-in: refresh twice, replay the first token, expect `401 session.reuse_detected`, then expect the newest token to be refused too (the contract says reuse ends the whole session) |

A step whose earlier step failed or was skipped is skipped as `blocked by "<step>" (failed)`, so one
failure does not bury the rest in noise; the run still exits 1. A stack started without a mailbox
(auth answers `503 mail.unavailable` to the sign-up) skips the sign-up and everything that needs
it, with that reason.

The report never contains a code, token, password, link or email address, and neither do error
messages: every value the run has seen is replaced with `[hidden]` before anything is printed, in its raw, URL-encoded and JSON-escaped forms. An error code from a service is printed only if it has the contract's `area.reason` shape; otherwise it shows as `(not a contract error code)`.
Each run creates two users, a Team that is deleted again and a revoked Invitation in the dev database, and leaves them there;
`bun run dev --down --volumes` removes them. The test only talks to the services' public HTTP
routes and the mailbox, so it needs no back door in any service.

### The sales-history steps

They run after the isolation step, as the first user (the Owner), and sign in again before each
phase because an access token lasts 60 s and a wait can be longer. Waits are bounded
(`playbookWaitMs`, 90 s by default) and say what they were waiting for. In order:

1. **Rights.** `GET /v1/playbook/rights-confirmation` shows the Organization unconfirmed; a Call
   upload is refused `403 rights.confirmation_required`; `PUT` with the current wording version
   confirms it.
2. **A Deal** is not created by a route of its own: the first Call under a customer deal id creates
   it, open. The smoke test uploads a small `.txt` Transcript (six turns, Rep label `Rep`), looks the
   Deal up by `POST /v1/playbook/deals/lookup` (open) and lists the Calls of that Deal.
3. **Moments.** It waits for the Call to reach `ready`. A Call is in search only when it is ready
   and its Deal is won (the contract), so at this point `inSearch` must still be false.
4. **A Recording.** A generated one-second, 8 kHz mono WAV of silence is uploaded under a second
   Deal with no Rep, and must reach `awaiting_rep` (or `ready`). The stand-in transcriber does not
   read the audio.
5. **A Deal CSV** of three rows (the Transcript's Deal as won, the Recording's Deal as lost, one new
   Deal as won) is imported. The import must complete with 3 rows, 3 applied, 0 rejected, a 3-row
   report and three Deals; the Transcript's Deal is now won, and then (a bounded wait for the re-tag
   job) its Call is in search.
6. **Isolation.** A third user in a new Organization (with its own Call, Deal and import) sees no rights confirmation it did not make, lists that hold its own items and none of the first, and
   `404`s with the documented code (`call.not_found`,
   `deal.not_found`, `deal_import.not_found`) for every read, delete, restore, Rep change and
   Outcome change by id, and for the Deal lookup; the first Organization's Call is unchanged.
7. **Delete.** `DELETE` of the Transcript's Call answers `200` with state `deleted` and out of
   search, it reads as `deleted`, it is gone from the default list, and deleting it again answers the
   same.

The report prints no Call, Deal or import id, and no customer deal id. Each run leaves its Calls,
Deals and objects in the dev database and bucket (the Call is soft-deleted and purged after 30 days);
`bun run dev --down --volumes` removes them.

## Open the stack from another device

### With Tailscale Funnel (`--tunnel`)

`bun run dev --tunnel` puts the portal and Twilio's webhooks on a fixed public `https` address for
as long as the stack runs. `bun run dev:smoke --strict --tunnel` signs in through that host and
checks that `POST /webhooks/twilio/status` reaches voice.

One-time owner setup:

1. Install Tailscale on this machine and sign in to the tailnet.
2. In the Tailscale admin console, turn on HTTPS certificates and approve Funnel for this machine
   (Access controls: the `funnel` node attribute; see <https://tailscale.com/kb/1223/funnel>).
3. Set `CLOSELINE_DEV_PUBLIC_ORIGIN=https://<machine>.<tailnet>.ts.net` in Infisical `dev`, folder
   `/hub` (or in the shell). It must equal this machine's name in `tailscale status --json`
   (`.Self.DNSName`); never put the real host in a repo or an issue.

With `--tunnel` the script checks all of that first and stops with one line if Tailscale is stopped,
Funnel is not enabled or the host differs. It then maps `/webhooks/twilio` to voice and `/` to the
portal (which proxies to the services), waits until `https://<host>/` answers (the first public DNS
lookup can take a minute), and runs `tailscale serve reset` when the stack stops, however it
stops, so nothing stays public. `--tunnel` owns this machine's whole Serve and Funnel config: it clears
it at start and at stop, including mappings you made yourself. After a kill -9, run `tailscale serve reset` by hand. Without
`--tunnel` nothing changes.

Register these under the host:

| Vendor | URL |
| --- | --- |
| Google (OAuth redirect URI) | `https://<machine>.<tailnet>.ts.net/v1/client/google/callback` |
| Microsoft or Google, for the Mailbox (redirect URI) | `https://<machine>.<tailnet>.ts.net/mailboxes/connect/callback` |
| Microsoft or Google, for the calendar (redirect URI) | `https://<machine>.<tailnet>.ts.net/calendar/callback` |
| Twilio (status and voice webhooks) | `https://<machine>.<tailnet>.ts.net/webhooks/twilio/...` (the paths voice documents) |

### The public origin applies only with `--tunnel`

`CLOSELINE_DEV_PUBLIC_ORIGIN` is ignored without `--tunnel` (set in the shell or in Infisical), so
local sign-in and every derived callback stay on the portal's loopback address.

`CLOSELINE_DEV_PUBLIC_ORIGIN` must be exactly `https://<lower-case host>` with an optional port, no
path, query or trailing slash, and ASCII only (no punycode). An invalid value stops `bun run dev`
before anything starts. When it is set, auth also accepts that origin for sessions and the portal's
Vite dev server allows its host. When it is unset nothing changes.

Sign in with Google through the tunnel needs real Google with the tunnel's redirect URI; the fake
provider is loopback only (see "Sign in with Google").

The host is allowed through the portal's documented `PORTAL_DEV_ALLOWED_HOSTS` setting (see its
`.env.example`), which needs a portal clone that reads it (portal PR for issue 102); on an older portal
the tunnel fails as "Blocked request".

Anyone with the link reaches the portal's dev server and, through its proxy, auth, core and the
playbook, with sign-up open. Use test data only and stop the tunnel when you are done. The mailbox (`127.0.0.1:8026`) is not tunnelled: read the verification code on the machine
that runs the stack.

## Reset

```bash
bun run dev --down --volumes    # removes only the closeline-dev containers, network and volumes
```

The next `bun run dev` recreates the database, roles, queues and bucket.

## Known gaps in the stack (found wiring it up)

- **No CORS (a proxy removes the need).** The portal now calls only its own origin and its dev
  server proxies to the services (see "The portal reaches the playbook"), so this no longer blocks
  it. It is kept as found: the services still send no CORS headers. A browser on another origin
  (`:3002` calling auth `:3001` and core `:3100` directly) would be blocked: `OPTIONS /v1/client/password-policy` on auth
  answers `404 request.not_found`, and `OPTIONS /v1/organization` on core `401
  auth.unauthenticated`, with no `Access-Control-Allow-Origin`. The portal's `README.md` says so;
  until the services allow the portal's origin or a proxy serves all three on one origin, the
  portal can be served and loaded, but its calls will be blocked by the browser.
- **Issuer defaults disagree.** With no `PUBLIC_URL`, auth issues tokens with
  `iss=http://localhost:<PORT>` (`tula-closeline-auth` `src/env.ts` `publicUrl`); core's default
  `AUTH_ISSUER` is `http://127.0.0.1:3001` (`tula-closeline-core` `src/env.ts` `LOCAL_AUTH_ORIGIN`).
  This script sets both to `http://127.0.0.1:3001`.
- **The Deal's `callCount` is always 0** (`tula-closeline-playbook`, `src/modules/deal/schema.ts`
  `toDeal` sets `callCount: 0` with a comment that Calls do not exist yet). The smoke test lists
  the Deal's Calls instead of reading it.
- **Port conventions disagree.** Every `.env.example` says `PORT=3000`; auth's example puts core on
  `3100`, core's defaults put auth on `3001` and the portal on `3002`, and the portal's example
  puts core on `3002` and the playbook on `3003`. This script uses auth 3001, core 3100, playbook
  3003, portal 3002.

**One start at a time.** `bun run dev` takes a machine-wide lock (`closeline-dev-stack.lock` in the temp directory, holding its pid). A second start while the first lives refuses with "already running, reuse it" before touching Docker or any password, because a start replaces the database role passwords and would break the running stack. A lock left by a dead process is taken over. `bun run dev --down` signals the lock holder (SIGTERM, then SIGKILL of it and its children after 20 s), removes a stale lock, then stops compose.
