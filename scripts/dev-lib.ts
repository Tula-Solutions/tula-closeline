// The logic behind `bun run dev` (scripts/dev.ts) and `bun run dev:smoke` (scripts/dev-smoke.ts)
// that can be tested without Docker: arguments, ports, secrets, environments, output handling.
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'

/** The compose project name; `docker compose -p` and every volume of the dev stack carry it. */
export const COMPOSE_PROJECT = 'closeline-dev'

/** The sibling clones the stack runs from, by short name. */
export const SIBLINGS = ['db', 'auth', 'core', 'portal'] as const

/** The short name of a sibling clone (`tula-closeline-<short>`). */
export type Sibling = (typeof SIBLINGS)[number]

/** The host ports of the whole stack. */
export type Ports = {
  postgres: number
  queue: number
  storage: number
  auth: number
  core: number
  portal: number
}

/** The ports used when no override is set. 5434 to 5437 belong to the repos' test databases. */
export const DEFAULT_PORTS: Ports = {
  postgres: 5440,
  queue: 9324,
  storage: 9090,
  auth: 3001,
  core: 3100,
  portal: 3002,
}

const PORT_VARIABLES: Record<keyof Ports, string> = {
  postgres: 'CLOSELINE_DEV_POSTGRES_PORT',
  queue: 'CLOSELINE_DEV_QUEUE_PORT',
  storage: 'CLOSELINE_DEV_STORAGE_PORT',
  auth: 'CLOSELINE_DEV_AUTH_PORT',
  core: 'CLOSELINE_DEV_CORE_PORT',
  portal: 'CLOSELINE_DEV_PORTAL_PORT',
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

/** The Postgres roles whose passwords are replaced on every start. */
export const ROLES = ['postgres', 'closeline_owner', 'closeline_auth', 'closeline_core'] as const

/** One of the roles in {@link ROLES}. */
export type Role = (typeof ROLES)[number]

/** Everything secret about one run. Generated once per run, held in memory, never printed. */
export type Secrets = {
  passwords: Record<Role, string>
  /** The bearer secret auth presents to core's internal routes. */
  internalToken: string
}

/** Fresh secrets from a cryptographically secure generator (32 random bytes each). */
export function generateSecrets(random: (size: number) => Buffer = randomBytes): Secrets {
  const passwords = {} as Record<Role, string>
  for (const role of ROLES) {
    passwords[role] = randomHex(32, random)
  }
  return { passwords, internalToken: randomHex(32, random) }
}

/** Every secret value, for {@link redact}. */
export function secretValues(secrets: Secrets): string[] {
  return [...Object.values(secrets.passwords), secrets.internalToken]
}

/** The SQL that gives each role its password for this run; reads only hex passwords. */
export function rotationSql(secrets: Secrets): string {
  return `${ROLES.map((role) => {
    const password = secrets.passwords[role]
    if (!/^[0-9a-f]{32,}$/.test(password)) {
      throw new Error(`refusing to build SQL from a password that is not hex (${role})`)
    }
    return `ALTER ROLE ${role} PASSWORD '${password}';`
  }).join('\n')}\n`
}

/** A connection string for one login on the dev Postgres. */
export function databaseUrl(role: Role, secrets: Secrets, ports: Ports): string {
  return `postgres://${role}:${secrets.passwords[role]}@127.0.0.1:${ports.postgres}/closeline`
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

/** The origins the services are reached at, from the host. */
export function origins(ports: Ports): { auth: string; core: string; portal: string } {
  return {
    auth: `http://127.0.0.1:${ports.auth}`,
    core: `http://127.0.0.1:${ports.core}`,
    portal: `http://127.0.0.1:${ports.portal}`,
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
  portal: Record<string, string>
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
}): StackEnv {
  const { parent, ports, secrets, dbDir } = options
  const base = baseChildEnv(parent)
  const where = origins(ports)
  const common = { ENVIRONMENT: 'local', REGION: 'us', LOG_LEVEL: 'info', SHUTDOWN_GRACE_MS: '0' }
  return {
    compose: {
      ...base,
      CLOSELINE_DB_DIR: dbDir,
      CLOSELINE_DEV_POSTGRES_PORT: String(ports.postgres),
      CLOSELINE_DEV_QUEUE_PORT: String(ports.queue),
      CLOSELINE_DEV_STORAGE_PORT: String(ports.storage),
    },
    migrate: { ...base, DATABASE_URL: databaseUrl('closeline_owner', secrets, ports) },
    auth: {
      ...base,
      ...common,
      PORT: String(ports.auth),
      DATABASE_URL: databaseUrl('closeline_auth', secrets, ports),
      PUBLIC_URL: where.auth,
      TOKEN_AUDIENCE: 'closeline',
      CORE_BASE_URL: where.core,
      CORE_INTERNAL_TOKEN: secrets.internalToken,
    },
    core: {
      ...base,
      ...common,
      PORT: String(ports.core),
      DATABASE_URL: databaseUrl('closeline_core', secrets, ports),
      AUTH_JWKS_URL: `${where.auth}/.well-known/jwks.json`,
      AUTH_ISSUER: where.auth,
      AUTH_AUDIENCE: 'closeline',
      INTERNAL_API_TOKENS: secrets.internalToken,
      PORTAL_BASE_URL: where.portal,
    },
    portal: {
      ...base,
      VITE_ENVIRONMENT: 'local',
      VITE_AUTH_BASE_URL: where.auth,
      VITE_CORE_BASE_URL: where.core,
    },
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
  name: 'auth' | 'core' | 'portal'
  sibling: Sibling
  /** The command, run from the clone. `--no-env-file` keeps a stray `.env` out of the process. */
  cmd: string[]
  env: keyof Pick<StackEnv, 'auth' | 'core' | 'portal'>
  /** The URL that answers 2xx when the service is ready. */
  readyUrl: string
}

/** The three processes `dev.ts` starts. `bun` is the path of the running Bun. */
export function serviceDefinitions(bun: string, ports: Ports): ServiceDefinition[] {
  const where = origins(ports)
  return [
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
