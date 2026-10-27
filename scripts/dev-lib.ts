// The logic behind `bun run dev` (scripts/dev.ts) and `bun run dev:smoke` (scripts/dev-smoke.ts)
// that can be tested without Docker: arguments, ports, secrets, environments, output handling.
import { spawnSync } from 'node:child_process'
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto'
import {
  existsSync,
  linkSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FAKE_GOOGLE_CLIENT_ID, FAKE_GOOGLE_CLIENT_SECRET } from './dev-fake-google.ts'

/** The compose project name; `docker compose -p` and every volume of the dev stack carry it. */
export const COMPOSE_PROJECT = 'closeline-dev'

/** The sibling clones the stack runs from, by short name. */
export const SIBLINGS = ['db', 'auth', 'core', 'playbook', 'voice', 'outbound', 'portal'] as const

/** The short name of a sibling clone (`tula-closeline-<short>`). */
export type Sibling = (typeof SIBLINGS)[number]

/** The host ports of the whole stack. */
export type Ports = {
  postgres: number
  queue: number
  storage: number
  mail: number
  auth: number
  core: number
  playbook: number
  voice: number
  outbound: number
  portal: number
  /** The fake Google OpenID provider (loopback only), used when no real Google is configured. */
  fakeGoogle: number
}

/** The ports used when no override is set. 5434 to 5437 belong to the repos' test databases. */
export const DEFAULT_PORTS: Ports = {
  postgres: 5440,
  queue: 9324,
  storage: 9090,
  mail: 8026,
  auth: 3001,
  core: 3100,
  playbook: 3003,
  voice: 3004,
  outbound: 3005,
  portal: 3002,
  fakeGoogle: 3010,
}

const PORT_VARIABLES: Record<keyof Ports, string> = {
  postgres: 'CLOSELINE_DEV_POSTGRES_PORT',
  queue: 'CLOSELINE_DEV_QUEUE_PORT',
  storage: 'CLOSELINE_DEV_STORAGE_PORT',
  mail: 'CLOSELINE_DEV_MAIL_PORT',
  auth: 'CLOSELINE_DEV_AUTH_PORT',
  core: 'CLOSELINE_DEV_CORE_PORT',
  playbook: 'CLOSELINE_DEV_PLAYBOOK_PORT',
  voice: 'CLOSELINE_DEV_VOICE_PORT',
  outbound: 'CLOSELINE_DEV_OUTBOUND_PORT',
  portal: 'CLOSELINE_DEV_PORTAL_PORT',
  fakeGoogle: 'CLOSELINE_DEV_FAKE_GOOGLE_PORT',
}

/** Reads the port overrides from the environment; throws naming the variable if one is invalid. */
export function resolvePorts(env: Record<string, string | undefined>): Ports {
  const ports = { ...DEFAULT_PORTS }
  for (const key of Object.keys(PORT_VARIABLES) as (keyof Ports)[]) {
    const name = PORT_VARIABLES[key]
    const raw = env[name]
    if (raw === undefined || raw === '') {
      continue
    }
    const value = Number(raw)
    if (!/^\d+$/.test(raw) || value < 1 || value > 65535) {
      throw new Error(`${name} must be a port between 1 and 65535`)
    }
    ports[key] = value
  }
  const seen = new Map<number, string>()
  for (const key of Object.keys(ports) as (keyof Ports)[]) {
    const clash = seen.get(ports[key])
    if (clash !== undefined) {
      throw new Error(
        `${PORT_VARIABLES[key]} and ${PORT_VARIABLES[clash as keyof Ports]} are both ${ports[key]}`
      )
    }
    seen.set(ports[key], key)
  }
  return ports
}

/** What the command line asked for. */
export type Args =
  | { kind: 'up' }
  | { kind: 'down'; volumes: boolean }
  | { kind: 'help' }
  | { kind: 'error'; message: string }

/** Parses `dev.ts` arguments: none (start), `--down`, `--down --volumes`, or `--help`. */
export function parseArgs(argv: readonly string[]): Args {
  let down = false
  let volumes = false
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      return { kind: 'help' }
    }
    if (arg === '--down') {
      down = true
    } else if (arg === '--volumes') {
      volumes = true
    } else {
      return { kind: 'error', message: `unknown argument: ${arg}` }
    }
  }
  if (volumes && !down) {
    return { kind: 'error', message: '--volumes only makes sense with --down' }
  }
  return down ? { kind: 'down', volumes } : { kind: 'up' }
}

/** Lower-case hex of `bytes` random bytes from the operating system's secure generator. */
export function randomHex(bytes: number, random: (size: number) => Buffer = randomBytes): string {
  return random(bytes).toString('hex')
}

/**
 * Every Postgres login role of the dev database, and the only list of them: their passwords are
 * replaced on every start. `compose.dev.yaml` names the same roles in its `*_PASSWORD` variables;
 * a test fails if one has no entry here, and `dev.ts` asks the database for its login roles and
 * stops if one is missing from this list.
 */
export const ROLES = [
  'postgres',
  'closeline_owner',
  'closeline_auth',
  'closeline_core',
  'closeline_playbook',
  'closeline_voice',
  'closeline_outbound',
] as const

/** One of the roles in {@link ROLES}. */
export type Role = (typeof ROLES)[number]

/** Everything secret about one run. Generated once per run, held in memory, never printed. */
export type Secrets = {
  passwords: Record<Role, string>
  /** The bearer secret auth presents to core's internal routes. */
  internalToken: string
  /** The bearer secret the playbook accepts on its internal routes. */
  playbookToken: string
  /** The bearer secret voice presents to core's internal directory; core lists it beside auth's. */
  voiceCoreToken: string
  /** The bearer secret voice presents to the playbook's internal routes; the playbook lists it too. */
  voicePlaybookToken: string
  /** The bearer secret outbound presents to core's internal Prospect routes; core lists it too. */
  outboundCoreToken: string
  /** The key core signs and checks unsubscribe tokens with. */
  unsubscribeTokenKey: string
}

/** Fresh secrets from a cryptographically secure generator (32 random bytes each). */
export function generateSecrets(random: (size: number) => Buffer = randomBytes): Secrets {
  const passwords = {} as Record<Role, string>
  for (const role of ROLES) {
    passwords[role] = randomHex(32, random)
  }
  return {
    passwords,
    internalToken: randomHex(32, random),
    playbookToken: randomHex(32, random),
    voiceCoreToken: randomHex(32, random),
    voicePlaybookToken: randomHex(32, random),
    outboundCoreToken: randomHex(32, random),
    unsubscribeTokenKey: randomHex(32, random),
  }
}

/** Every secret value, for {@link redact}. */
export function secretValues(secrets: Secrets): string[] {
  return [
    ...Object.values(secrets.passwords),
    secrets.internalToken,
    secrets.playbookToken,
    secrets.voiceCoreToken,
    secrets.voicePlaybookToken,
    secrets.outboundCoreToken,
    secrets.unsubscribeTokenKey,
  ]
}

const SCRAM_ITERATIONS = 4096

/**
 * The SCRAM-SHA-256 verifier Postgres stores for a password (RFC 7677, as Postgres formats it:
 * `SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>`). Sending the verifier instead of
 * the password means a failed or logged statement never contains the password.
 */
export function scramVerifier(
  password: string,
  salt: Buffer = randomBytes(16),
  iterations = SCRAM_ITERATIONS
): string {
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256')
  const clientKey = createHmac('sha256', salted).update('Client Key').digest()
  const storedKey = createHash('sha256').update(clientKey).digest()
  const serverKey = createHmac('sha256', salted).update('Server Key').digest()
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`
}

/**
 * The SQL that gives each role its password for this run, as a SCRAM verifier: the clear-text
 * password is never in the statement, so it cannot reach the Postgres log. Reads only hex.
 */
export function rotationSql(secrets: Secrets, salt: () => Buffer): string {
  return `${ROLES.map((role) => {
    const password = secrets.passwords[role]
    if (!/^[0-9a-f]{32,}$/.test(password)) {
      throw new Error(`refusing to build SQL from a password that is not hex (${role})`)
    }
    return `ALTER ROLE ${role} PASSWORD '${scramVerifier(password, salt())}';`
  }).join('\n')}\n`
}

/** A fresh 16-byte salt from the secure generator, one per role per run. */
export function freshSalt(): Buffer {
  return randomBytes(16)
}

/**
 * The NOLOGIN roles of `tula-closeline-db/docker/postgres/init.sql`, with the attributes it gives
 * them. That file runs only when the dev volume is first created, so a volume made before a
 * migration needed a new role would fail to migrate: {@link ensureRolesSql} creates the missing
 * ones on every start. A test compares this list with the db clone's init.sql.
 */
export const NOLOGIN_ROLES: readonly { name: string; attributes: string }[] = [
  {
    name: 'closeline_core_search',
    attributes: 'NOSUPERUSER NOCREATEROLE NOCREATEDB NOINHERIT BYPASSRLS',
  },
  {
    name: 'closeline_core_crm_lookup',
    attributes: 'NOSUPERUSER NOCREATEROLE NOCREATEDB NOINHERIT BYPASSRLS',
  },
  {
    name: 'closeline_core_key_lookup',
    attributes: 'NOSUPERUSER NOCREATEROLE NOCREATEDB NOINHERIT BYPASSRLS',
  },
  {
    name: 'closeline_core_outbox_drain',
    attributes: 'NOSUPERUSER NOCREATEROLE NOCREATEDB NOINHERIT BYPASSRLS',
  },
  {
    name: 'closeline_voice_purge_scan',
    attributes: 'NOSUPERUSER NOCREATEROLE NOCREATEDB NOINHERIT BYPASSRLS',
  },
]

/**
 * Login roles the db clone's init.sql does not create (yet), made here without a password: the
 * rotation gives each one its password on every start. Created only when missing.
 */
export const EXTRA_LOGIN_ROLES: readonly string[] = ['closeline_outbound']

/**
 * Idempotent SQL that creates each of {@link NOLOGIN_ROLES} when it is missing and grants it to the
 * owner role (`SET` only, no inheritance). Never touches a login role or a password; run as the
 * superuser before the migrations.
 */
export function ensureRolesSql(): string {
  return `${NOLOGIN_ROLES.map(
    ({ name, attributes }) =>
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${name}') THEN ` +
      `CREATE ROLE ${name} NOLOGIN ${attributes}; END IF; END $$;\n` +
      `GRANT ${name} TO closeline_owner WITH SET TRUE, INHERIT FALSE;`
  ).join('\n')}\n${EXTRA_LOGIN_ROLES.map(
    (name) =>
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${name}') THEN ` +
      `CREATE ROLE ${name} LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB; END IF; END $$;\n`
  ).join('')}`
}

/** The query `dev.ts` runs to list every role that can log in. */
export const LOGIN_ROLES_SQL = 'select rolname from pg_roles where rolcanlogin order by 1'

/** Login roles in `psql -At` output that {@link ROLES} does not replace the password of. */
export function unrotatedLoginRoles(output: string): string[] {
  const known: readonly string[] = ROLES
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !known.includes(line))
}

/** Loopback addresses: the only hosts the dev database may be reached at. */
const LOOPBACK_HOSTS = ['127.0.0.1', '::1', '[::1]', 'localhost']

/** Throws unless `url` is a Postgres URL whose host is a loopback address. */
export function assertLoopbackDatabaseUrl(url: string): void {
  let host: string
  try {
    host = new URL(url).hostname
  } catch {
    throw new Error('the database URL is not a valid URL')
  }
  if (!LOOPBACK_HOSTS.includes(host)) {
    throw new Error(
      `refusing to use a database at ${host || '(no host)'}: the dev stack only talks to a loopback address`
    )
  }
}

/** A connection string for one login on the dev Postgres; refuses a host that is not loopback. */
export function databaseUrl(
  role: Role,
  secrets: Secrets,
  ports: Ports,
  host = '127.0.0.1'
): string {
  const url = `postgres://${role}:${secrets.passwords[role]}@${host}:${ports.postgres}/closeline`
  assertLoopbackDatabaseUrl(url)
  return url
}

/** The Docker variables that pick an endpoint; they go to the compose commands only. */
const DOCKER_VARIABLES = ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG'] as const

/** Whether a Docker endpoint is a local unix socket. */
export function isLocalDockerHost(host: string): boolean {
  return host.startsWith('unix://')
}

/**
 * A message if the Docker endpoint in effect is not a local unix socket, else undefined.
 * `DOCKER_HOST` wins when set; otherwise `inspectContext` returns the host of the current
 * context (`docker context inspect`).
 */
export async function dockerEndpointProblem(
  parent: Record<string, string | undefined>,
  inspectContext: () => Promise<string | undefined>
): Promise<string | undefined> {
  const host = parent.DOCKER_HOST ? parent.DOCKER_HOST : await inspectContext()
  if (host === undefined || host === '') {
    return 'cannot tell which Docker endpoint is in use: `docker context inspect` failed (is Docker installed and on PATH?)'
  }
  return isLocalDockerHost(host)
    ? undefined
    : `the Docker endpoint (${host}) is not a local unix socket; the dev stack only runs on local Docker`
}

/** Variables a child process may inherit from this one; everything else is withheld. */
const INHERITED = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'TERM',
  'TZ',
  'SSH_AUTH_SOCK',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
]

/**
 * The environment every child starts from: a short allowlist of this process's variables, so a
 * `DATABASE_URL`, `PORT` or `ENVIRONMENT` exported in the developer's shell cannot leak in.
 */
export function baseChildEnv(parent: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const name of INHERITED) {
    const value = parent[name]
    if (value !== undefined) {
      env[name] = value
    }
  }
  return env
}

/** The queue the playbook reads, defined in `scripts/dev/elasticmq.conf`. */
export const PLAYBOOK_QUEUE = 'closeline-playbook'

/** The queue core reads its background jobs from, defined in `scripts/dev/elasticmq.conf`. */
export const CORE_JOBS_QUEUE = 'core-jobs'

/** The queue core publishes `audit.recorded` events to, defined in `scripts/dev/elasticmq.conf`. */
export const CORE_AUDIT_QUEUE = 'core-audit'

/** The bucket the object storage stand-in creates (`compose.dev.yaml`). */
export const STORAGE_BUCKET = 'closeline-dev'

/**
 * Reads the optional `CLOSELINE_DEV_PUBLIC_ORIGIN` (a tunnel in front of the portal). It must be
 * exactly `https://<lower-case host>` with an optional port; anything else throws. Returns the
 * origin and its host name (no port), or `undefined` when the variable is unset or empty.
 */
export function resolvePublicOrigin(
  env: Record<string, string | undefined>
): { origin: string; host: string } | undefined {
  const raw = env.CLOSELINE_DEV_PUBLIC_ORIGIN
  if (raw === undefined || raw === '') {
    return undefined
  }
  const match =
    /^https:\/\/([a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)*)(?::([0-9]{1,5}))?$/.exec(
      raw
    )
  // A browser omits the default port from its Origin header, and a port is 1 to 65535.
  const port = match?.[2]
  const badPort =
    port !== undefined && (!/^[1-9][0-9]*$/.test(port) || Number(port) > 65535 || port === '443')
  // The URL parser must agree, and an all-digit last label would be read as an IPv4 address.
  const host = match?.[1]
  const lastLabelNumeric = host !== undefined && /^[0-9]+$/.test(host.split('.').pop() ?? '')
  let urlAgrees = false
  try {
    urlAgrees = new URL(raw).origin === raw
  } catch {
    urlAgrees = false
  }
  if (!host || badPort || lastLabelNumeric || !urlAgrees) {
    throw new Error(
      `CLOSELINE_DEV_PUBLIC_ORIGIN must be https://<lower-case host> with an optional port, no path, query or trailing slash (got ${JSON.stringify(raw)})`
    )
  }
  return { origin: raw, host }
}

/** The origins the services are reached at, from the host. */
export function origins(ports: Ports): {
  auth: string
  core: string
  playbook: string
  voice: string
  outbound: string
  portal: string
  mail: string
  fakeGoogle: string
} {
  return {
    mail: `http://127.0.0.1:${ports.mail}`,
    auth: `http://127.0.0.1:${ports.auth}`,
    core: `http://127.0.0.1:${ports.core}`,
    playbook: `http://127.0.0.1:${ports.playbook}`,
    voice: `http://127.0.0.1:${ports.voice}`,
    outbound: `http://127.0.0.1:${ports.outbound}`,
    portal: `http://127.0.0.1:${ports.portal}`,
    fakeGoogle: `http://127.0.0.1:${ports.fakeGoogle}`,
  }
}

/** The path Google sends the browser back to; auth requires the redirect URI to end in it. */
export const GOOGLE_CALLBACK_PATH = '/v1/client/google/callback'

/** Where the portal receives the redirect back from the provider when a Mailbox is connected. */
export const MAIL_CALLBACK_PATH = '/mailboxes/connect/callback'

function mailRedirectUri(portal: string): string {
  return `${portal}${MAIL_CALLBACK_PATH}`
}

/** How auth is configured for Sign in with Google: the fake provider, or the developer's own. */
export type GoogleSetup =
  | { kind: 'fake'; redirectUri: string }
  | { kind: 'real'; clientId: string; clientSecret: string; redirectUri: string }

/**
 * Decides from the shell whether the stack uses the fake Google provider or real Google. None of
 * `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `GOOGLE_REDIRECT_URI` set means the fake; all
 * three means real; a mix throws (auth would refuse it at boot). A real redirect URI must be at the
 * callback path on the portal origin, or on the tunnel origin when one is set. Messages name the
 * variable and never print a value.
 */
export function resolveGoogle(
  env: Record<string, string | undefined>,
  ports: Ports,
  publicOrigin: { origin: string } | undefined
): GoogleSetup {
  const portalCallback = `${origins(ports).portal}${GOOGLE_CALLBACK_PATH}`
  const names = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI'] as const
  const value = (name: (typeof names)[number]) => {
    const raw = env[name]
    return raw === undefined || raw === '' ? undefined : raw
  }
  if (names.every((name) => value(name) === undefined)) {
    return { kind: 'fake', redirectUri: portalCallback }
  }
  const missing = names.filter((name) => value(name) === undefined)
  if (missing.length > 0) {
    throw new Error(
      `${missing.join(', ')} must be set too: set all of ${names.join(', ')} for real Google sign-in, or none for the fake provider`
    )
  }
  const redirectUri = value('GOOGLE_REDIRECT_URI') ?? ''
  const allowed = [
    portalCallback,
    ...(publicOrigin ? [`${publicOrigin.origin}${GOOGLE_CALLBACK_PATH}`] : []),
  ]
  if (!allowed.includes(redirectUri)) {
    throw new Error(
      `GOOGLE_REDIRECT_URI must be ${allowed.join(' or ')} (the portal's proxy serves the callback)`
    )
  }
  return {
    kind: 'real',
    clientId: value('GOOGLE_CLIENT_ID') ?? '',
    clientSecret: value('GOOGLE_CLIENT_SECRET') ?? '',
    redirectUri,
  }
}

/** The environment each part of the stack starts with. */
export type StackEnv = {
  /** `docker compose` itself: only the host ports and where the database clone is. */
  compose: Record<string, string>
  /** `bun run db:migrate` in the database clone. */
  migrate: Record<string, string>
  auth: Record<string, string>
  core: Record<string, string>
  playbook: Record<string, string>
  voice: Record<string, string>
  outbound: Record<string, string>
  portal: Record<string, string>
  /** The fake Google provider's process; undefined when real Google settings are in use. */
  fakeGoogle: Record<string, string> | undefined
}

/**
 * Builds the environment of every process from the ports, this run's secrets and the clone
 * locations. It is the only place a service's configuration is assembled. Every service runs with
 * `ENVIRONMENT=local`, the one environment in which these values mean anything.
 *
 * `AUTH_MASTER_KEY` is left unset on purpose: it seals the signing keys already in the database,
 * so a new one each run would orphan them. Auth's own development key, which it refuses outside
 * `local`, is used instead.
 */
export function buildStackEnv(options: {
  parent: Record<string, string | undefined>
  ports: Ports
  secrets: Secrets
  dbDir: string
  /** Where the database is reached; only a loopback address is accepted. */
  databaseHost?: string
  /** The text of `scripts/dev/elasticmq.conf`; its hash makes compose recreate a stale queue. */
  queueConfig?: string
}): StackEnv {
  const { parent, ports, secrets, dbDir } = options
  const host = options.databaseHost ?? '127.0.0.1'
  const publicOrigin = resolvePublicOrigin(parent)
  if (parent.DOCKER_HOST && !isLocalDockerHost(parent.DOCKER_HOST)) {
    throw new Error(
      `DOCKER_HOST (${parent.DOCKER_HOST}) is not a local unix socket; the dev stack only runs on local Docker`
    )
  }
  const dockerEnv: Record<string, string> = {}
  for (const name of DOCKER_VARIABLES) {
    const value = parent[name]
    if (value !== undefined) {
      dockerEnv[name] = value
    }
  }
  const base = baseChildEnv(parent)
  const where = origins(ports)
  const google = resolveGoogle(parent, ports, publicOrigin)
  const common = { ENVIRONMENT: 'local', REGION: 'us', LOG_LEVEL: 'info', SHUTDOWN_GRACE_MS: '0' }
  return {
    compose: {
      ...base,
      ...dockerEnv,
      CLOSELINE_DB_DIR: dbDir,
      CLOSELINE_DEV_POSTGRES_PORT: String(ports.postgres),
      CLOSELINE_DEV_QUEUE_PORT: String(ports.queue),
      CLOSELINE_DEV_STORAGE_PORT: String(ports.storage),
      CLOSELINE_DEV_MAIL_PORT: String(ports.mail),
      // A bind-mounted file is not part of the service definition, so compose would keep a queue
      // started from an older config. The hash, a label on the service, makes the change visible.
      ...(options.queueConfig === undefined
        ? {}
        : {
            CLOSELINE_DEV_QUEUE_CONFIG_SHA: createHash('sha256')
              .update(options.queueConfig)
              .digest('hex'),
          }),
    },
    migrate: { ...base, DATABASE_URL: databaseUrl('closeline_owner', secrets, ports, host) },
    auth: {
      ...base,
      ...common,
      PORT: String(ports.auth),
      DATABASE_URL: databaseUrl('closeline_auth', secrets, ports, host),
      PUBLIC_URL: where.auth,
      TOKEN_AUDIENCE: 'closeline',
      CORE_BASE_URL: where.core,
      CORE_INTERNAL_TOKEN: secrets.internalToken,
      MAIL_LOCAL_URL: where.mail,
      // The portal's origin: without it auth answers a browser session refresh 403 auth.forbidden.
      // A tunnel origin (CLOSELINE_DEV_PUBLIC_ORIGIN) is allowed as well when one is set.
      SESSION_ALLOWED_ORIGINS: publicOrigin
        ? `${where.portal},${publicOrigin.origin}`
        : where.portal,
      ...(google.kind === 'real'
        ? {
            GOOGLE_CLIENT_ID: google.clientId,
            GOOGLE_CLIENT_SECRET: google.clientSecret,
            GOOGLE_REDIRECT_URI: google.redirectUri,
          }
        : {
            GOOGLE_CLIENT_ID: FAKE_GOOGLE_CLIENT_ID,
            GOOGLE_CLIENT_SECRET: FAKE_GOOGLE_CLIENT_SECRET,
            GOOGLE_REDIRECT_URI: google.redirectUri,
            GOOGLE_ISSUER_URL: where.fakeGoogle,
          }),
    },
    core: {
      ...base,
      ...common,
      PORT: String(ports.core),
      DATABASE_URL: databaseUrl('closeline_core', secrets, ports, host),
      AUTH_JWKS_URL: `${where.auth}/.well-known/jwks.json`,
      AUTH_ISSUER: where.auth,
      AUTH_AUDIENCE: 'closeline',
      // Auth's, voice's and outbound's secrets, comma separated (core accepts several).
      INTERNAL_API_TOKENS: `${secrets.internalToken},${secrets.voiceCoreToken},${secrets.outboundCoreToken}`,
      PORTAL_BASE_URL: where.portal,
      MAIL_LOCAL_URL: where.mail,
      UNSUBSCRIBE_TOKEN_KEY: secrets.unsubscribeTokenKey,
      // The queue stand-in of the compose file; it ignores the credentials, but the AWS SDK will
      // not sign a request without some.
      AWS_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: 'local',
      AWS_SECRET_ACCESS_KEY: 'local',
      JOBS_QUEUE_URL: `http://127.0.0.1:${ports.queue}/000000000000/${CORE_JOBS_QUEUE}`,
      AUDIT_QUEUE_URL: `http://127.0.0.1:${ports.queue}/000000000000/${CORE_AUDIT_QUEUE}`,
      QUEUE_ENDPOINT: `http://127.0.0.1:${ports.queue}`,
    },
    playbook: {
      ...base,
      ...common,
      PORT: String(ports.playbook),
      DATABASE_URL: databaseUrl('closeline_playbook', secrets, ports, host),
      AUTH_JWKS_URL: `${where.auth}/.well-known/jwks.json`,
      AUTH_ISSUER: where.auth,
      AUTH_AUDIENCE: 'closeline',
      INTERNAL_API_TOKENS: `${secrets.playbookToken},${secrets.voicePlaybookToken}`,
      // The queue and object storage stand-ins of the compose file. They ignore the credentials,
      // but the AWS SDK will not sign a request without some.
      AWS_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: 'local',
      AWS_SECRET_ACCESS_KEY: 'local',
      QUEUE_URL: `http://127.0.0.1:${ports.queue}/000000000000/${PLAYBOOK_QUEUE}`,
      QUEUE_ENDPOINT: `http://127.0.0.1:${ports.queue}`,
      STORAGE_BUCKET,
      STORAGE_ENDPOINT: `http://127.0.0.1:${ports.storage}`,
      // Faster loops than the defaults, so the smoke test does not wait for a poll.
      INGESTION_POLL_INTERVAL_MS: '1000',
      TRANSCRIBE_POLL_INTERVAL_MS: '1000',
    },
    voice: {
      ...base,
      ...common,
      PORT: String(ports.voice),
      DATABASE_URL: databaseUrl('closeline_voice', secrets, ports, host),
      AUTH_JWKS_URL: `${where.auth}/.well-known/jwks.json`,
      AUTH_ISSUER: where.auth,
      AUTH_AUDIENCE: 'closeline',
      // The directory voice reads a caller's Membership from.
      CORE_INTERNAL_URL: where.core,
      CORE_INTERNAL_TOKEN: secrets.voiceCoreToken,
      // Where voice reads an Organization's Playbook evidence from; it sends its own secret.
      PLAYBOOK_INTERNAL_URL: where.playbook,
      PLAYBOOK_INTERNAL_TOKEN: secrets.voicePlaybookToken,
      // The in-process stand-in: no real telephony provider is ever called from a dev stack.
      TELEPHONY_PROVIDER: 'memory',
    },
    outbound: {
      ...base,
      ...common,
      PORT: String(ports.outbound),
      DATABASE_URL: databaseUrl('closeline_outbound', secrets, ports, host),
      AUTH_JWKS_URL: `${where.auth}/.well-known/jwks.json`,
      AUTH_ISSUER: where.auth,
      AUTH_AUDIENCE: 'closeline',
      // Where the enrichment waterfall reads a Prospect and writes enriched fields back.
      CORE_URL: where.core,
      CORE_INTERNAL_SECRET: secrets.outboundCoreToken,
      // Gmail Mailboxes go to the fake provider (loopback only); with real Google set for auth's
      // sign-in, outbound keeps its in-memory Mailbox provider, as its redirect URI is not Google's.
      ...(google.kind === 'fake'
        ? {
            GOOGLE_CLIENT_ID: FAKE_GOOGLE_CLIENT_ID,
            GOOGLE_CLIENT_SECRET: FAKE_GOOGLE_CLIENT_SECRET,
            GOOGLE_AUTH_URL: `${where.fakeGoogle}/authorize`,
            GOOGLE_TOKEN_URL: `${where.fakeGoogle}/token`,
            GOOGLE_REVOKE_URL: `${where.fakeGoogle}/revoke`,
            GMAIL_API_BASE_URL: where.fakeGoogle,
            MAIL_OAUTH_REDIRECT_URI: mailRedirectUri(where.portal),
          }
        : {}),
    },
    portal: {
      ...base,
      VITE_ENVIRONMENT: 'local',
      // The portal's dev server proxies /v1/... to these: the browser calls only its own origin.
      AUTH_PROXY_TARGET: where.auth,
      CORE_PROXY_TARGET: where.core,
      PLAYBOOK_PROXY_TARGET: where.playbook,
      VOICE_PROXY_TARGET: where.voice,
      // Vite blocks an unknown Host header; the portal reads this setting into `server.allowedHosts`.
      ...(publicOrigin ? { PORTAL_DEV_ALLOWED_HOSTS: publicOrigin.host } : {}),
      // The portal lets the browser follow a redirect to this host only (the fake provider).
      ...(google.kind === 'fake'
        ? { VITE_GOOGLE_FAKE_ISSUER_HOST: `127.0.0.1:${ports.fakeGoogle}` }
        : {}),
    },
    fakeGoogle:
      google.kind === 'fake'
        ? {
            ...base,
            FAKE_GOOGLE_PORT: String(ports.fakeGoogle),
            FAKE_GOOGLE_CLIENT_ID,
            FAKE_GOOGLE_CLIENT_SECRET,
            FAKE_GOOGLE_REDIRECT_URI: google.redirectUri,
            FAKE_GOOGLE_MAIL_REDIRECT_URI: mailRedirectUri(where.portal),
          }
        : undefined,
  }
}

/** Replaces every occurrence of every secret in `text`, so a log line cannot print one. */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text
  for (const secret of secrets) {
    if (secret !== '') {
      out = out.split(secret).join('[redacted]')
    }
  }
  return out
}

/**
 * Turns a stream of output chunks into whole lines, each written as `[name] line`. A line split
 * across chunks is joined; `flush` writes what is left when the stream ends. Secrets are redacted.
 */
export class LinePrefixer {
  private pending = ''

  constructor(
    private readonly name: string,
    private readonly write: (line: string) => void,
    private readonly secrets: readonly string[] = [],
    private readonly width = 8
  ) {}

  /** Adds a chunk and writes every line it completes. */
  push(chunk: string): void {
    this.pending += chunk
    const lines = this.pending.split(/\r?\n/)
    this.pending = lines.pop() ?? ''
    for (const line of lines) {
      this.emit(line)
    }
  }

  /** Writes the unfinished last line, if any. */
  flush(): void {
    if (this.pending !== '') {
      this.emit(this.pending)
      this.pending = ''
    }
  }

  private emit(line: string): void {
    this.write(`${`[${this.name}]`.padEnd(this.width + 2)} ${redact(line, this.secrets)}\n`)
  }
}

/** Whether something already accepts connections on `port` of this machine (IPv4 or IPv6). */
export async function isPortInUse(port: number, timeoutMs = 500): Promise<boolean> {
  const attempt = (host: string) =>
    new Promise<boolean>((resolve) => {
      const socket = connect({ port, host })
      const finish = (inUse: boolean) => {
        socket.destroy()
        resolve(inUse)
      }
      socket.setTimeout(timeoutMs, () => finish(false))
      socket.once('connect', () => finish(true))
      socket.once('error', () => finish(false))
    })
  const results = await Promise.all([attempt('127.0.0.1'), attempt('::1')])
  return results.some(Boolean)
}

/** Returns a message for every port in `wanted` that is already taken. */
export async function busyPorts(
  wanted: readonly { name: string; port: number }[],
  inUse: (port: number) => Promise<boolean> = isPortInUse
): Promise<string[]> {
  const problems: string[] = []
  for (const { name, port } of wanted) {
    if (await inUse(port)) {
      problems.push(
        `port ${port} (${name}) is already in use; stop what uses it or set its CLOSELINE_DEV_*_PORT`
      )
    }
  }
  return problems
}

/** The path of a sibling clone: `<root>/tula-closeline-<short>`. */
export function siblingDir(root: string, short: Sibling): string {
  return join(root, `tula-closeline-${short}`)
}

/**
 * Checks that each needed sibling clone exists, is the repo it should be and has its dependencies
 * installed. Returns one message per problem; empty means ready. Reads, never writes.
 */
export function checkSiblings(root: string, needed: readonly Sibling[] = SIBLINGS): string[] {
  const problems: string[] = []
  for (const short of needed) {
    const dir = siblingDir(root, short)
    const manifest = join(dir, 'package.json')
    if (!existsSync(manifest)) {
      problems.push(
        `${dir} is missing: clone Tula-Solutions/tula-closeline-${short} next to this repo, or set CLOSELINE_SIBLINGS_DIR`
      )
      continue
    }
    let name: unknown
    try {
      name = (JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown }).name
    } catch {
      problems.push(`${manifest} is not valid JSON`)
      continue
    }
    if (name !== `tula-closeline-${short}`) {
      problems.push(`${dir} is not tula-closeline-${short} (package name is ${String(name)})`)
      continue
    }
    if (!existsSync(join(dir, 'node_modules'))) {
      problems.push(
        `${dir} has no node_modules: run \`bun install\` there (see its README for the git setup)`
      )
    }
  }
  if (
    needed.includes('portal') &&
    !existsSync(join(siblingDir(root, 'portal'), 'node_modules/vite/bin/vite.js'))
  ) {
    if (!problems.some((problem) => problem.startsWith(siblingDir(root, 'portal')))) {
      problems.push(
        `${siblingDir(root, 'portal')} has no vite installed: run \`bun install\` there`
      )
    }
  }
  return problems
}

/** What the stack runs besides the compose services, in start order. */
export type ServiceDefinition = {
  name: 'fake-google' | 'auth' | 'core' | 'playbook' | 'voice' | 'outbound' | 'portal'
  /** The clone it runs from; undefined means the hub itself. */
  sibling?: Sibling
  /** The command, run from the clone. `--no-env-file` keeps a stray `.env` out of the process. */
  cmd: string[]
  env: keyof Pick<
    StackEnv,
    'fakeGoogle' | 'auth' | 'core' | 'playbook' | 'voice' | 'outbound' | 'portal'
  >
  /** The URL that answers 2xx when the service is ready. */
  readyUrl: string
}

/**
 * The processes `dev.ts` starts. `bun` is the path of the running Bun; `fakeGoogle` adds the fake
 * Google provider first, so it is up before auth is asked to sign anyone in.
 */
export function serviceDefinitions(
  bun: string,
  ports: Ports,
  fakeGoogle = false
): ServiceDefinition[] {
  const where = origins(ports)
  return [
    ...(fakeGoogle
      ? [
          {
            name: 'fake-google' as const,
            cmd: [bun, '--no-env-file', 'scripts/dev-fake-google.ts'],
            env: 'fakeGoogle' as const,
            readyUrl: `${where.fakeGoogle}/readyz`,
          },
        ]
      : []),
    {
      name: 'core',
      sibling: 'core',
      cmd: [bun, '--no-env-file', 'src/server.ts'],
      env: 'core',
      readyUrl: `${where.core}/readyz`,
    },
    {
      name: 'auth',
      sibling: 'auth',
      cmd: [bun, '--no-env-file', 'src/server.ts'],
      env: 'auth',
      readyUrl: `${where.auth}/readyz`,
    },
    {
      // The API and the workers are one process: it starts its job loop and sweeps itself
      // (WORKERS_ENABLED defaults to true for ENVIRONMENT=local).
      name: 'playbook',
      sibling: 'playbook',
      cmd: [bun, '--no-env-file', 'src/server.ts'],
      env: 'playbook',
      readyUrl: `${where.playbook}/readyz`,
    },
    {
      // Lines and Calls; the number provider is its in-memory stand-in (TELEPHONY_PROVIDER=memory).
      name: 'voice',
      sibling: 'voice',
      cmd: [bun, '--no-env-file', 'src/server.ts'],
      env: 'voice',
      readyUrl: `${where.voice}/readyz`,
    },
    {
      // Campaigns across email, LinkedIn and messaging; only its health routes exist so far.
      name: 'outbound',
      sibling: 'outbound',
      cmd: [bun, '--no-env-file', 'src/server.ts'],
      env: 'outbound',
      readyUrl: `${where.outbound}/readyz`,
    },
    {
      name: 'portal',
      sibling: 'portal',
      cmd: [
        bun,
        '--no-env-file',
        '--bun',
        'node_modules/vite/bin/vite.js',
        '--host',
        '127.0.0.1',
        '--port',
        String(ports.portal),
        '--strictPort',
      ],
      env: 'portal',
      readyUrl: `${where.portal}/`,
    },
  ]
}

/** Options for {@link requestWithRetry}. */
export type RequestOptions = {
  timeoutMs?: number
  attempts?: number
  /** Pause before attempt n (1-based), in ms; jittered by default. */
  backoffMs?: (attempt: number) => number
  fetchImpl?: typeof fetch
}

/** The statuses worth another try: the server or something in front of it was not ready. */
function retryable(status: number): boolean {
  return status === 502 || status === 503 || status === 504
}

/**
 * One HTTP request with a timeout on every attempt and a bounded, jittered retry on a network
 * error, a timeout or 502/503/504. Pass `idempotent: false` for a request that must be sent once.
 */
export async function requestWithRetry(
  url: string,
  init: RequestInit & { idempotent?: boolean } = {},
  options: RequestOptions = {}
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? 5_000
  const attempts = init.idempotent === false ? 1 : (options.attempts ?? 3)
  const backoff = options.backoffMs ?? ((n: number) => 100 * 2 ** (n - 1) * (0.5 + Math.random()))
  const doFetch = options.fetchImpl ?? fetch
  const { idempotent: _ignored, ...rest } = init
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await doFetch(url, {
        ...rest,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'manual',
      })
      if (!retryable(response.status) || attempt === attempts) {
        return response
      }
      await response.body?.cancel()
    } catch (error) {
      lastError = error
      if (attempt === attempts) {
        throw error
      }
    }
    await Bun.sleep(backoff(attempt))
  }
  throw lastError instanceof Error ? lastError : new Error('request failed')
}

/**
 * Polls `url` until it answers 2xx, `isAlive` says the process is gone, or `timeoutMs` passes.
 * Resolves with an error message, or `undefined` when ready.
 */
export async function waitForReady(
  url: string,
  options: {
    timeoutMs: number
    intervalMs?: number
    isAlive?: () => boolean
    fetchImpl?: typeof fetch
  }
): Promise<string | undefined> {
  const deadline = Date.now() + options.timeoutMs
  const doFetch = options.fetchImpl ?? fetch
  while (Date.now() < deadline) {
    if (options.isAlive && !options.isAlive()) {
      return 'the process exited before it was ready'
    }
    try {
      const response = await doFetch(url, {
        signal: AbortSignal.timeout(1_500),
        redirect: 'manual',
      })
      await response.body?.cancel()
      if (response.ok) {
        return undefined
      }
    } catch {
      // not listening yet
    }
    await Bun.sleep(options.intervalMs ?? 250)
  }
  return `did not answer 2xx at ${url} within ${Math.round(options.timeoutMs / 1000)} s`
}

/** The result of the wiring probe: what core said to the shared secret, and to a wrong one. */
export type WiringResult = { ok: true } | { ok: false; reason: string }

/**
 * Checks, from this process, that core accepts the secret auth was given and refuses another:
 * the membership lookup of a user id that cannot exist must answer `{ found: false }`, and the
 * same call with a different secret must answer 401. Prints and returns no secret.
 */
export async function probeInternalWiring(options: {
  coreOrigin: string
  token: string
  fetchImpl?: typeof fetch
}): Promise<WiringResult> {
  const call = async (token: string) => {
    const response = await requestWithRetry(
      `${options.coreOrigin}/internal/membership`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'idempotency-key': `wiring-probe-${randomHex(12)}`,
        },
        body: JSON.stringify({ userId: `usr_${randomHex(16)}` }),
      },
      { fetchImpl: options.fetchImpl }
    )
    const text = await response.text()
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      json = undefined
    }
    return { status: response.status, json }
  }
  const good = await call(options.token)
  const found = (good.json as { found?: unknown } | undefined)?.found
  if (good.status !== 200 || found !== false) {
    const code = (good.json as { code?: unknown } | undefined)?.code
    return {
      ok: false,
      reason: `core answered the shared secret with ${good.status}${typeof code === 'string' ? ` ${code}` : ''}`,
    }
  }
  const bad = await call(randomHex(32))
  if (bad.status !== 401) {
    return { ok: false, reason: `core answered a wrong secret with ${bad.status}, not 401` }
  }
  return { ok: true }
}

/**
 * The `docker compose` command line for the dev stack. Always names the `closeline-dev` project,
 * so no command here can touch another project's containers or volumes, and reads no `.env`
 * file (`--env-file /dev/null`), which compose would otherwise load from the hub.
 */
export function composeArgs(composeFile: string, ...args: string[]): string[] {
  return [
    'docker',
    'compose',
    '--env-file',
    '/dev/null',
    '-p',
    COMPOSE_PROJECT,
    '-f',
    composeFile,
    ...args,
  ]
}

/** The command line of `--down`, with `--volumes` deleting the dev stack's data. */
export function downArgs(composeFile: string, volumes: boolean): string[] {
  return composeArgs(composeFile, 'down', '--remove-orphans', ...(volumes ? ['--volumes'] : []))
}

/**
 * The db library's migration script, run as a file so that no nested `bun run` can load a stray
 * `.env` from that clone. This is what its `db:migrate` script runs.
 */
export function migrateCommand(bun: string): string[] {
  return [bun, '--no-env-file', 'scripts/migrate.ts']
}

/** Longest each kind of subprocess may run before it is killed, in ms. */
export const TIMEOUTS = {
  dockerQuick: 20_000,
  psql: 60_000,
  migrate: 180_000,
  composeUp: 240_000,
  composeDown: 120_000,
} as const

/** Reads a stream to its end through a line prefixer. */
export async function pumpThrough(
  stream: ReadableStream<Uint8Array>,
  prefixer: LinePrefixer
): Promise<void> {
  const decoder = new TextDecoder()
  for await (const chunk of stream) {
    prefixer.push(decoder.decode(chunk, { stream: true }))
  }
  prefixer.push(decoder.decode())
  prefixer.flush()
}

/** Where a process's output lines go. */
export type Sinks = { out: (text: string) => void; err: (text: string) => void }

const processSinks: Sinks = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
}

/** Options shared by the subprocess helpers. */
export type SpawnOptions = {
  cwd: string
  env: Record<string, string>
  /** Secret values removed from every output line of both streams. */
  secrets: readonly string[]
  stdin?: string
  sinks?: Sinks
  /** Aborting it stops the process (SIGTERM). */
  signal?: AbortSignal
  /** Aborting it kills the process (SIGKILL), for one that ignored the first signal. */
  force?: AbortSignal
}

/** Wires the two abort signals of a process: SIGTERM on `signal`, SIGKILL on `force`. */
function linkAbort(
  proc: { kill: (signal: 'SIGTERM' | 'SIGKILL') => void },
  options: { signal?: AbortSignal; force?: AbortSignal }
): () => void {
  const term = () => proc.kill('SIGTERM')
  const kill = () => proc.kill('SIGKILL')
  options.signal?.addEventListener('abort', term, { once: true })
  options.force?.addEventListener('abort', kill, { once: true })
  if (options.force?.aborted) {
    kill()
  }
  return () => {
    options.signal?.removeEventListener('abort', term)
    options.force?.removeEventListener('abort', kill)
  }
}

/**
 * Runs a command to completion with its output prefixed and scrubbed of `secrets` on both streams.
 * It is killed after `timeoutMs`. Resolves with the exit code and whether it timed out.
 */
export async function runCommand(
  name: string,
  cmd: string[],
  options: SpawnOptions & { timeoutMs: number }
): Promise<{ code: number; timedOut: boolean }> {
  const sinks = options.sinks ?? processSinks
  if (options.signal?.aborted) {
    return { code: 143, timedOut: false }
  }
  let proc: Bun.Subprocess<'ignore' | Uint8Array, 'pipe', 'pipe'>
  try {
    proc = Bun.spawn({
      cmd,
      cwd: options.cwd,
      env: options.env,
      stdin: options.stdin === undefined ? 'ignore' : new TextEncoder().encode(options.stdin),
      stdout: 'pipe',
      stderr: 'pipe',
    })
  } catch {
    sinks.err(`[${name}] cannot run ${cmd[0] ?? 'the command'}: is it installed and on PATH?\n`)
    return { code: 127, timedOut: false }
  }
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill('SIGKILL')
  }, options.timeoutMs)
  const unlink = linkAbort(proc, options)
  try {
    await Promise.all([
      pumpThrough(proc.stdout, new LinePrefixer(name, sinks.out, options.secrets)),
      pumpThrough(proc.stderr, new LinePrefixer(name, sinks.err, options.secrets)),
    ])
    return { code: await proc.exited, timedOut }
  } finally {
    clearTimeout(timer)
    unlink()
  }
}

/** The stdout of a short command, or undefined if it failed or ran past `timeoutMs`. */
export async function captureCommand(
  cmd: string[],
  options: {
    cwd: string
    env: Record<string, string>
    timeoutMs: number
    stdin?: string
    signal?: AbortSignal
    force?: AbortSignal
  }
): Promise<string | undefined> {
  if (options.signal?.aborted) {
    return undefined
  }
  let proc: Bun.Subprocess<'ignore' | Uint8Array, 'pipe', 'ignore'>
  try {
    proc = Bun.spawn({
      cmd,
      cwd: options.cwd,
      env: options.env,
      stdin: options.stdin === undefined ? 'ignore' : new TextEncoder().encode(options.stdin),
      stdout: 'pipe',
      stderr: 'ignore',
    })
  } catch {
    return undefined
  }
  const timer = setTimeout(() => proc.kill('SIGKILL'), options.timeoutMs)
  const unlink = linkAbort(proc, options)
  try {
    const text = await new Response(proc.stdout).text()
    return (await proc.exited) === 0 ? text : undefined
  } finally {
    clearTimeout(timer)
    unlink()
  }
}

/** A long-running child the supervisor can stop. */
export type ManagedChild = {
  name: string
  alive: () => boolean
  kill: (signal: 'SIGTERM' | 'SIGKILL') => void
  /** Resolves with the exit code once the process has exited and its output has drained. */
  exited: Promise<number>
}

/** Starts a long-running child whose output is prefixed and scrubbed of `secrets` on both streams. */
export function spawnManaged(name: string, cmd: string[], options: SpawnOptions): ManagedChild {
  const sinks = options.sinks ?? processSinks
  let proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>
  try {
    proc = Bun.spawn({
      cmd,
      cwd: options.cwd,
      env: options.env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
  } catch {
    throw new Error(
      `cannot start ${name} (${cmd[0] ?? 'the command'}): is it installed and on PATH?`
    )
  }
  let alive = true
  const exited = (async () => {
    await Promise.all([
      pumpThrough(proc.stdout, new LinePrefixer(name, sinks.out, options.secrets)),
      pumpThrough(proc.stderr, new LinePrefixer(name, sinks.err, options.secrets)),
    ])
    const code = await proc.exited
    alive = false
    return code
  })()
  return { name, alive: () => alive, kill: (signal) => proc.kill(signal), exited }
}

/** Stops every child: SIGTERM, then SIGKILL for any still alive after `graceMs`. */
export async function stopAll(children: readonly ManagedChild[], graceMs = 15_000): Promise<void> {
  for (const child of children) {
    if (child.alive()) {
      child.kill('SIGTERM')
    }
  }
  const timer = setTimeout(() => {
    for (const child of children) {
      if (child.alive()) {
        child.kill('SIGKILL')
      }
    }
  }, graceMs)
  try {
    await Promise.all(children.map((child) => child.exited))
  } finally {
    clearTimeout(timer)
  }
}

/** The signals that stop the stack: Ctrl-C, a kill, and the terminal going away. */
export const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const

/** One service for {@link supervise}. */
export type ServiceSpec = { name: string; readyUrl: string; spawn: () => ManagedChild }

/** Everything {@link supervise} needs, so it can be tested with fakes. */
export type SuperviseOptions = {
  services: readonly ServiceSpec[]
  /** Checks the services are wired together once they are all ready. */
  probe: () => Promise<WiringResult>
  /** Resolves with a message, or undefined when `url` is ready; stops when `isAlive` is false. */
  waitReady: (url: string, isAlive: () => boolean) => Promise<string | undefined>
  /** Registers a signal handler; returns a function that removes it. */
  subscribe: (onSignal: (signal: string) => void) => () => void
  log: (line: string) => void
  error: (line: string) => void
  /** Called once everything is ready, before waiting. */
  banner: () => void
  graceMs?: number
}

/**
 * Starts the services in order, waits for each, checks the wiring, then waits for a signal or for
 * any service to exit. Every path out, including a throw, stops every child that was started.
 * Returns 0 after a signal and 1 after any failure.
 */
export async function supervise(options: SuperviseOptions): Promise<number> {
  const children: ManagedChild[] = []
  let stopping = false
  let exitCode = 0
  let wake: () => void = () => {}
  const woken = new Promise<void>((resolve) => {
    wake = resolve
  })
  const stop = (code: number) => {
    if (!stopping) {
      stopping = true
      exitCode = code
      wake()
    }
  }
  const unsubscribe = options.subscribe((signal) => {
    if (!stopping) {
      options.log(
        `${signal}: stopping services (compose keeps running; \`bun run dev --down\` stops it)`
      )
    }
    stop(0)
  })
  try {
    for (const service of options.services) {
      const child = service.spawn()
      children.push(child)
      void child.exited.then((code) => {
        if (!stopping) {
          options.error(`${service.name} exited with code ${code}`)
          stop(1)
        }
      })
      const failure = await options.waitReady(service.readyUrl, () => child.alive() && !stopping)
      if (stopping) {
        break
      }
      if (failure !== undefined) {
        options.error(`${service.name} ${failure}`)
        stop(1)
        break
      }
      options.log(`${service.name} is ready`)
    }
    if (!stopping) {
      const wiring = await options.probe()
      if (!stopping) {
        if (wiring.ok) {
          options.log("wiring: core accepts auth's internal secret and refuses a wrong one")
        } else {
          options.error(`wiring: ${wiring.reason}`)
          stop(1)
        }
      }
    }
    if (!stopping) {
      options.banner()
      await woken
    }
  } catch (error) {
    options.error(error instanceof Error ? error.message : 'the supervisor failed')
    exitCode = 1
  } finally {
    stopping = true
    unsubscribe()
    await stopAll(children, options.graceMs)
  }
  return exitCode
}

/** Whether a process with this pid is alive. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** `ps` runs with a fixed locale and zone, so a start time reads the same to writer and reader. */
const psEnv = () => ({ ...process.env, LC_ALL: 'C', TZ: 'UTC' })

/** A process's start time as `ps` prints it (macOS and Linux), or undefined if it is not known. */
export function processStart(pid: number): string | undefined {
  const out = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
    encoding: 'utf8',
    env: psEnv(),
  })
  const text = out.status === 0 ? out.stdout.trim().replace(/\s+/g, ' ') : ''
  return text === '' ? undefined : text
}

/** Parses a lock file's `<pid> <start time>`; undefined for an empty or malformed one. */
function parseLock(text: string): { pid: number; start: string } | undefined {
  const match = /^(\d+) (.+)$/.exec(text.trim())
  const pid = Number(match?.[1])
  return match && Number.isSafeInteger(pid) && pid > 0 ? { pid, start: match[2] ?? '' } : undefined
}

/** Where the machine-wide start lock lives. */
export const DEFAULT_LOCK_PATH = join(tmpdir(), 'closeline-dev-stack.lock')

/** What {@link stopLockHolder} found and did. */
export type HolderOutcome =
  | { kind: 'none' }
  | { kind: 'stale' }
  | { kind: 'stopped'; pid: number }
  | { kind: 'killed'; pid: number }
  | { kind: 'failed'; reason: string }

/** A process recorded with its start time, so a reused pid can be told apart later. */
export type Proc = { pid: number; start: string }

/**
 * Every descendant of `pid` with its start time, read in one `ps`; undefined when `ps` fails or
 * its output cannot be read, which means the tree is not known (never "empty").
 */
function descendants(pid: number, psBin = 'ps'): Proc[] | undefined {
  const out = spawnSync(psBin, ['-A', '-o', 'pid=,ppid=,lstart='], {
    encoding: 'utf8',
    env: psEnv(),
  })
  if (out.status !== 0 || out.error || out.stdout.trim() === '') {
    return undefined
  }
  const rows = new Map<number, Proc[]>()
  for (const line of out.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line)
    if (match) {
      const parent = Number(match[2])
      rows.set(parent, [
        ...(rows.get(parent) ?? []),
        { pid: Number(match[1]), start: (match[3] ?? '').replace(/\s+/g, ' ') },
      ])
    }
  }
  const found: Proc[] = []
  const queue = [pid]
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const child of rows.get(next) ?? []) {
      found.push(child)
      queue.push(child.pid)
    }
  }
  return found
}

/**
 * Removes the lock file only if it still holds `seen`: moves it aside, re-reads it, and puts it
 * back when it changed meanwhile (a new live lock a start just linked).
 */
function removeLockIfSame(path: string, seen: string, beforeRemove?: () => void): void {
  beforeRemove?.()
  const moved = `${path}.${process.pid}.${randomBytes(4).toString('hex')}`
  try {
    renameSync(path, moved)
  } catch {
    return
  }
  try {
    if (readFileSync(moved, 'utf8') !== seen) {
      try {
        linkSync(moved, path)
      } catch {
        // someone created a lock meanwhile; theirs stands
      }
    }
  } finally {
    rmSync(moved, { force: true })
  }
}

/** Sends a signal, ignoring a process that is already gone. */
function signalPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal)
  } catch {
    // gone
  }
}

/**
 * Stops the `bun run dev` that holds the start lock, for `--down`. A lock with no live holder of
 * that start time is removed. A live holder gets SIGTERM and `graceMs` to stop its services and
 * release the lock; if it is still there, it and everything it started are sent SIGKILL (its
 * descendants, not its process group: the group may be the user's shell).
 */
export async function stopLockHolder(
  path: string = DEFAULT_LOCK_PATH,
  options: {
    graceMs?: number
    pollMs?: number
    /** Test seams: the `ps` binary, the tree before it is used, and the moment before a removal. */
    psBin?: string
    onSnapshot?: (tree: Proc[]) => void
    beforeRemove?: () => void
  } = {}
): Promise<HolderOutcome> {
  const graceMs = options.graceMs ?? 20_000
  const pollMs = options.pollMs ?? 100
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return { kind: 'none' }
  }
  const holder = parseLock(text)
  if (!holder) {
    return {
      kind: 'failed',
      reason: `the lock ${path} is empty or unreadable; delete it if nothing runs`,
    }
  }
  if (!pidAlive(holder.pid)) {
    removeLockIfSame(path, text, options.beforeRemove)
    return { kind: 'stale' }
  }
  const start = holder.start === 'unknown' ? undefined : processStart(holder.pid)
  if (start === undefined) {
    return {
      kind: 'failed',
      reason: `cannot tell whether pid ${holder.pid} is the dev stack (its start time is unknown); not signalling it. Stop it by hand and delete ${path}`,
    }
  }
  if (start !== holder.start) {
    removeLockIfSame(path, text, options.beforeRemove)
    return { kind: 'stale' }
  }
  const tree = descendants(holder.pid, options.psBin)
  if (tree === undefined) {
    return {
      kind: 'failed',
      reason: `could not list the processes of pid ${holder.pid} (ps failed); not stopping it, so nothing is killed by mistake`,
    }
  }
  options.onSnapshot?.(tree)
  signalPid(holder.pid, 'SIGTERM')
  const deadline = Date.now() + graceMs
  while (Date.now() < deadline) {
    if (!pidAlive(holder.pid)) {
      return { kind: 'stopped', pid: holder.pid }
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
  // Each pid is checked against its recorded start time just before its SIGKILL.
  for (const proc of [...tree.reverse(), { pid: holder.pid, start: holder.start }]) {
    if (processStart(proc.pid) === proc.start) {
      signalPid(proc.pid, 'SIGKILL')
    }
  }
  for (let i = 0; i < 50 && pidAlive(holder.pid); i++) {
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
  if (pidAlive(holder.pid)) {
    return { kind: 'failed', reason: `pid ${holder.pid} did not die after SIGKILL` }
  }
  removeLockIfSame(path, text)
  return { kind: 'killed', pid: holder.pid }
}

/** Waits a few milliseconds without spinning. */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Takes the machine-wide lock a running `bun run dev` holds. The file holds `<pid> <start time>`
 * and is created whole (written to a temp file, then hard-linked into place), so a reader never
 * sees it empty. A live holder is refused with its pid. An empty or unreadable lock is treated as
 * busy, never stale. A lock whose process is gone, or whose pid now belongs to a process that
 * started at another time, is moved aside and re-checked before it is deleted. With no pid in the
 * refusal the lock could not be taken at all.
 */
export function acquireStartLock(
  path: string = DEFAULT_LOCK_PATH,
  seam: { beforeTakeover?: () => void } = {}
): { held: false; release: () => void } | { held: true; pid?: number; path: string } {
  const mine = `${process.pid} ${processStart(process.pid) ?? 'unknown'}`
  const unique = () => `${path}.${process.pid}.${randomBytes(4).toString('hex')}`
  for (let attempt = 0; attempt < 8; attempt++) {
    const temp = unique()
    try {
      writeFileSync(temp, mine)
      linkSync(temp, path)
      return {
        held: false,
        release: () => {
          try {
            if (readFileSync(path, 'utf8') === mine) {
              unlinkSync(path)
            }
          } catch {
            // already gone
          }
        },
      }
    } catch {
      // the lock exists, or could not be written: look at it
    } finally {
      rmSync(temp, { force: true })
    }
    let seen: string
    try {
      seen = readFileSync(path, 'utf8')
    } catch {
      continue
    }
    const holder = parseLock(seen)
    if (!holder) {
      pause(25 * (attempt + 1))
      continue
    }
    const start = holder.start === 'unknown' ? undefined : processStart(holder.pid)
    if (pidAlive(holder.pid) && (start === undefined || start === holder.start)) {
      return { held: true, pid: holder.pid, path }
    }
    seam.beforeTakeover?.()
    const moved = unique()
    try {
      renameSync(path, moved)
    } catch {
      continue
    }
    if (readFileSync(moved, 'utf8') === seen) {
      rmSync(moved, { force: true })
    } else {
      // Not the dead lock we saw: a live holder's. Put it back.
      try {
        linkSync(moved, path)
      } catch {
        // someone created a lock meanwhile; theirs stands
      }
      rmSync(moved, { force: true })
    }
  }
  return { held: true, path }
}
