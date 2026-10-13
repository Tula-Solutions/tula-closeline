# Local development

One command runs the Closeline stack on your machine: Postgres 18, two local stand-ins and a local
mailbox in Docker, then core, auth and the portal from their sibling clones. This is plan step 1.19
(hub issue 20); the mailbox and the end-to-end smoke test are hub issue 38.

```bash
bun run dev           # compose up, migrate, start core, auth and the portal; Ctrl-C stops the three
bun run dev:smoke     # in another terminal: signs up and checks the running stack over HTTP
bun run dev --down    # stop the compose containers (keeps the data)
bun run dev --down --volumes   # also delete the database and storage data
bun run dev:smoke --strict     # as dev:smoke, but a skipped step is an error (for CI, below)
# read the emails the services send: open http://127.0.0.1:8026
```

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
- Clone `tula-closeline-db`, `-auth`, `-core` and `-portal` next to this repo (or point
  `CLOSELINE_SIBLINGS_DIR` at the folder that holds them) and run `bun install` in each. The git
  dependencies are private; if you have no SSH key on GitHub, do the one-time `gh auth setup-git`
  and `git config --global url...insteadOf` step in any clone's `README.md` ("Getting started").
- The script reads the clones, it never edits them: it does not switch branches, write files or
  run `drizzle-kit push`. Each clone runs whatever branch it has checked out. The script also
  refuses to migrate or change a role unless the database address it built is a loopback address.

The script stops with a message, before starting anything, if a clone is missing, is not the repo
it should be, has no `node_modules`, or a port is taken.

## What runs

| Part | Where | Notes |
| --- | --- | --- |
| Postgres 18.6 (`postgres:18.6-alpine`) | `127.0.0.1:5440` | database `closeline`; roles from `tula-closeline-db`'s own `docker/postgres/init.sh` |
| Mailbox: Mailpit v1.31.5 (web UI and HTTP API) | `http://127.0.0.1:8026` | in memory, so `--down` or a restart empties it; the SMTP port (1025) is not published; auth and core send to it through `MAIL_LOCAL_URL` |
| Queue stand-in: ElasticMQ 1.7.1 (SQS API) | `http://127.0.0.1:9324` | queues `closeline-dev` and `closeline-dev-dlq` (placeholder names) |
| Object storage stand-in: Adobe S3Mock 5.2.3 (S3 API) | `http://127.0.0.1:9090` | bucket `closeline-dev`; any credentials; path-style addressing |
| core | `http://127.0.0.1:3100` | `bun src/server.ts` in `tula-closeline-core` |
| auth | `http://127.0.0.1:3001` | `bun src/server.ts` in `tula-closeline-auth` |
| portal | `http://127.0.0.1:3002` | Vite dev server in `tula-closeline-portal` |

Ports 5434 to 5437 are the repos' own test databases and 5432 is left for whatever else you run, so
the dev Postgres is on 5440. Mailpit's usual port 8025 is often taken by another project's mailbox,
so this one is on 8026. Override any port with `CLOSELINE_DEV_POSTGRES_PORT`,
`CLOSELINE_DEV_QUEUE_PORT`, `CLOSELINE_DEV_STORAGE_PORT`, `CLOSELINE_DEV_MAIL_PORT`,
`CLOSELINE_DEV_AUTH_PORT`, `CLOSELINE_DEV_CORE_PORT` and `CLOSELINE_DEV_PORTAL_PORT`. Every port binds to `127.0.0.1` only.
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

**The queue and object storage are provisioned but nothing uses them yet.** The queue port and
object storage port in `tula-closeline-kit` (steps 1.10 and 1.12) are not built, so no service
has a setting for either. They are here so the first service that needs one has it.

## Order of a start

1. Checks the clones, `docker compose`, and that the ports are free.
2. `docker compose up -d --wait` on `compose.dev.yaml` (project `closeline-dev`), until all four
   containers are healthy, then waits for the mailbox to answer `GET /livez` on the host port. A
   mailbox that does not answer stops the start (exit 1) before any role is touched.
3. Asks the database which roles can log in (`rolcanlogin`) and stops if any is not in the
   rotation list (`ROLES` in `scripts/dev-lib.ts`), then gives each of the five login roles
   (`postgres`, `closeline_owner`, `closeline_auth`, `closeline_core`, `closeline_playbook`) a new
   random password. The password is sent as a SCRAM-SHA-256 verifier, never as clear text, so a
   failed statement cannot put it in the Postgres log. The compose file's values only create the
   database once, and a test fails if a `*_PASSWORD` there has no role in the list.
4. Runs `scripts/migrate.ts` of the `tula-closeline-db` clone as the owner role (the script its
   `db:migrate` runs, started directly with `--no-env-file`).
5. Starts core, then auth (which calls core), then the portal, waiting for each to answer 2xx.
6. Checks the wiring: core accepts the shared internal secret and refuses a wrong one.

Each child's output is prefixed (`[core]`, `[auth]`, `[portal]`) and scrubbed of this run's
secrets. If one exits, or any step after the first spawn fails, the others are stopped and the
script exits 1. On Ctrl-C, SIGTERM or SIGHUP it stops the three services and leaves compose
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
  in core).

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

## What the smoke test covers

`bun run dev:smoke` calls the running stack over HTTP (every call with a timeout and a bounded
retry; a sign-up, sign-in, verification or refresh is sent once, never retried) and prints PASS,
FAIL or `skipped: <reason>` per step. It exits 1 if a step fails; with `--strict` it also exits 1
if any step is skipped. In a healthy stack nothing is skipped, so CI uses `--strict`.

| Step | What it checks |
| --- | --- |
| auth ready, core ready, portal served, the mailbox ready, auth publishes EdDSA signing keys | each answers |
| core refuses a request with no token and with a malformed one | `401 auth.unauthenticated` and `401 auth.token_invalid` |
| sign up | `POST /v1/client/sign-ups` with a fresh `smoke-<random>@closeline-smoke.test` address (a reserved domain), a random password and an Organization name |
| read the verification code | looks the email up in the mailbox (bounded wait) and takes the six-digit code from it |
| verify the email code, sign in | the code is accepted; sign-in with the password gives a session |
| core `GET /v1/organization` and `GET /v1/members` | with the access token: the Organization in the token, and exactly one member, the Owner |
| refresh the session | the new tokens work at core; the spent refresh token is never reused |
| create an Invitation | `POST /v1/invitations` for a new address, role `rep`, with an `Idempotency-Key` |
| the Invitation email and its link | the email reaches the mailbox and its link points at the portal's `/sign-up` page |
| a second sign-up cannot read the first Organization | a second, different user gets a different Organization id; `GET /v1/organization`, `/v1/members` and `/v1/invitations` with their token return nothing of the first (its Organization id, address, user ids, Invitation id), and `DELETE /v1/invitations/{id}` of the first Organization's Invitation answers `404`, leaving it pending |

A step whose earlier step failed or was skipped is skipped as `blocked by "<step>" (failed)`, so one
failure does not bury the rest in noise; the run still exits 1. A stack started without a mailbox
(auth answers `503 mail.unavailable` to the sign-up) skips the sign-up and everything that needs
it, with that reason.

The report never contains a code, token, password, link or email address, and neither do error
messages: every value the run has seen is replaced with `[hidden]` before anything is printed.
Each run creates two users and one pending Invitation in the dev database, and leaves them there;
`bun run dev --down --volumes` removes them. The test only talks to the services' public HTTP
routes and the mailbox, so it needs no back door in any service.

## Reset

```bash
bun run dev --down --volumes    # removes only the closeline-dev containers, network and volumes
```

The next `bun run dev` recreates the database, roles, queues and bucket.

## Known gaps in the stack (found wiring it up)

- **No CORS.** The portal (`:3002`) calls auth (`:3001`) and core (`:3100`) from the browser, a
  different origin, and neither sets CORS headers: `OPTIONS /v1/client/password-policy` on auth
  answers `404 request.not_found`, and `OPTIONS /v1/organization` on core `401
  auth.unauthenticated`, with no `Access-Control-Allow-Origin`. The portal's `README.md` says so;
  until the services allow the portal's origin or a proxy serves all three on one origin, the
  portal can be served and loaded, but its calls will be blocked by the browser.
- **Issuer defaults disagree.** With no `PUBLIC_URL`, auth issues tokens with
  `iss=http://localhost:<PORT>` (`tula-closeline-auth` `src/env.ts` `publicUrl`); core's default
  `AUTH_ISSUER` is `http://127.0.0.1:3001` (`tula-closeline-core` `src/env.ts` `LOCAL_AUTH_ORIGIN`).
  This script sets both to `http://127.0.0.1:3001`.
- **Port conventions disagree.** Every `.env.example` says `PORT=3000`; auth's example puts core on
  `3100`, core's defaults put auth on `3001` and the portal on `3002`, and the portal's example
  puts core on `3002`. This script uses auth 3001, core 3100, portal 3002.
