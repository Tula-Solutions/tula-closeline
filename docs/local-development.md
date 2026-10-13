# Local development

One command runs the Closeline stack on your machine: Postgres 18 and two local stand-ins in
Docker, then core, auth and the portal from their sibling clones. This is plan step 1.19 (hub
issue 20).

```bash
bun run dev           # compose up, migrate, start core, auth and the portal; Ctrl-C stops the three
bun run dev:smoke     # in another terminal: checks the running stack over HTTP
bun run dev --down    # stop the compose containers (keeps the data)
bun run dev --down --volumes   # also delete the database and storage data
bun run dev:smoke --strict     # as dev:smoke, but a skipped step is an error (for CI, below)
```

## Before the first run

- Docker Compose 2.17.0 or newer (the release that added `up --wait-timeout`; developed on 5.5.1)
  and Bun. Docker must be local: the script refuses any Docker endpoint that is not a unix socket
  (it checks `DOCKER_HOST` and, when that is unset, `docker context inspect`), so it cannot start
  containers or change database roles on a remote host. `DOCKER_HOST`, `DOCKER_CONTEXT` and
  `DOCKER_CONFIG` are passed to the compose commands only, so Colima, Rancher and Podman sockets
  work; no other process gets them.
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
| Queue stand-in: ElasticMQ 1.7.1 (SQS API) | `http://127.0.0.1:9324` | queues `closeline-dev` and `closeline-dev-dlq` (placeholder names) |
| Object storage stand-in: Adobe S3Mock 5.2.3 (S3 API) | `http://127.0.0.1:9090` | bucket `closeline-dev`; any credentials; path-style addressing |
| core | `http://127.0.0.1:3100` | `bun src/server.ts` in `tula-closeline-core` |
| auth | `http://127.0.0.1:3001` | `bun src/server.ts` in `tula-closeline-auth` |
| portal | `http://127.0.0.1:3002` | Vite dev server in `tula-closeline-portal` |

Ports 5434 to 5437 are the repos' own test databases and 5432 is left for whatever else you run, so
the dev Postgres is on 5440. Override any port with `CLOSELINE_DEV_POSTGRES_PORT`,
`CLOSELINE_DEV_QUEUE_PORT`, `CLOSELINE_DEV_STORAGE_PORT`, `CLOSELINE_DEV_AUTH_PORT`,
`CLOSELINE_DEV_CORE_PORT` and `CLOSELINE_DEV_PORTAL_PORT`. Every port binds to `127.0.0.1` only.
Every image is pinned to an exact version and digest in `compose.dev.yaml`.

Why these stand-ins: ADR 0001 gives each Region its own queues, and the plan (steps 1.10, 1.12 and
1.18) builds the queue port with an AWS adapter and the object storage port with an S3 adapter.
ElasticMQ speaks the SQS API and S3Mock the S3 API; each is one small container that needs no
account and starts in seconds, and both publish amd64 and arm64 images.

**The queue and object storage are provisioned but nothing uses them yet.** The queue port and
object storage port in `tula-closeline-kit` (steps 1.10 and 1.12) are not built, so no service
has a setting for either. They are here so the first service that needs one has it.

## Order of a start

1. Checks the clones, `docker compose`, and that the ports are free.
2. `docker compose up -d --wait` on `compose.dev.yaml` (project `closeline-dev`), until all three
   containers are healthy.
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
running, so the next start is quick. The docker, psql and migrate steps each have a timeout.
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
`ENVIRONMENT` exported in your shell cannot leak in. The script's own processes read no `.env`
file: the services and the migration run with `--no-env-file` (the migration as a script file,
because a nested `bun run` would load one), and the compose commands run with
`--env-file /dev/null`, which stops compose loading a `.env` from the hub. That isolation ends at
the services' own code: nothing here stops a service reading a file itself.

The bootstrap passwords in `compose.dev.yaml` are placeholders for the first start only; the
script replaces the password of every login role on every start, so none stays valid.

## What the smoke test covers

`bun run dev:smoke` calls the running services over HTTP (every call with a timeout and a bounded
retry) and prints PASS, FAIL or `skipped: <reason>` per step. It exits 1 only if a step fails;
with `--strict` it also exits 1 if any step is skipped. `--strict` is the mode CI will use once
the services have a local mail stand-in (hub issue #38, which also gives the skipped steps their
code), so that a skip can no longer hide a gap.

| Step | Status today |
| --- | --- |
| auth ready, core ready, portal served, auth publishes EdDSA signing keys | runs |
| core refuses a request with no token and with a malformed one (401) | runs |
| sign up with an Organization name | **skipped**: auth has no mail provider; it answers `503 mail.unavailable` |
| verify the email code, sign in, core `GET /v1/organization` and `GET /v1/members`, refresh, create an Invitation, a second user cannot read the first Organization | **skipped**: they need the account above |

There is no local mail stand-in to read a verification code from: auth wires an unconfigured
mailer (`tula-closeline-auth` `src/container.ts` `mailer: createUnconfiguredMailer()`) and core wires
an unconfigured Invitation mailer (`tula-closeline-core` `src/container.ts` `invitationMailer`),
so creating an Invitation would fail and be revoked even with an account. No service has a
back door and the smoke test adds none. When a mail adapter that has a local mailbox lands, replace
the skipped steps in `scripts/dev-smoke.ts` with the real flow.

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
