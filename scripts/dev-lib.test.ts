import { describe, expect, test } from 'bun:test'
import { createHash, createHmac, pbkdf2Sync } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertLoopbackDatabaseUrl,
  baseChildEnv,
  buildStackEnv,
  busyPorts,
  checkSiblings,
  composeArgs,
  DEFAULT_PORTS,
  dockerEndpointProblem,
  downArgs,
  generateSecrets,
  isPortInUse,
  LinePrefixer,
  LOGIN_ROLES_SQL,
  migrateCommand,
  parseArgs,
  probeInternalWiring,
  ROLES,
  randomHex,
  redact,
  requestWithRetry,
  resolvePorts,
  rotationSql,
  scramVerifier,
  secretValues,
  serviceDefinitions,
  unrotatedLoginRoles,
  waitForReady,
} from './dev-lib.ts'

/** A server on a free port; `handler` answers every request. */
function serve(handler: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: handler })
  return { server, origin: `http://127.0.0.1:${server.port}` }
}

describe('parseArgs', () => {
  test('no arguments starts the stack', () => {
    expect(parseArgs([])).toEqual({ kind: 'up' })
  })

  test('--down stops it, --volumes also deletes the data', () => {
    expect(parseArgs(['--down'])).toEqual({ kind: 'down', volumes: false })
    expect(parseArgs(['--down', '--volumes'])).toEqual({ kind: 'down', volumes: true })
    expect(parseArgs(['--volumes', '--down'])).toEqual({ kind: 'down', volumes: true })
  })

  test('--volumes alone and unknown flags are refused', () => {
    expect(parseArgs(['--volumes']).kind).toBe('error')
    expect(parseArgs(['--wipe']).kind).toBe('error')
  })

  test('--help wins', () => {
    expect(parseArgs(['--down', '--help'])).toEqual({ kind: 'help' })
  })
})

describe('resolvePorts', () => {
  test('defaults avoid the repos own test databases (5434 to 5437) and 5432', () => {
    const ports = resolvePorts({})
    expect(ports).toEqual(DEFAULT_PORTS)
    expect(ports.postgres).toBe(5440)
    for (const reserved of [5432, 5434, 5435, 5436, 5437]) {
      expect(Object.values(ports)).not.toContain(reserved)
    }
  })

  test('overrides apply and an empty value is ignored', () => {
    expect(
      resolvePorts({ CLOSELINE_DEV_POSTGRES_PORT: '5450', CLOSELINE_DEV_AUTH_PORT: '' })
    ).toEqual({
      ...DEFAULT_PORTS,
      postgres: 5450,
    })
  })

  test.each(['0', '65536', 'abc', '30.5', '-1'])('refuses %s, naming the variable', (value) => {
    expect(() => resolvePorts({ CLOSELINE_DEV_CORE_PORT: value })).toThrow(
      'CLOSELINE_DEV_CORE_PORT'
    )
  })

  test('refuses two services on one port', () => {
    expect(() => resolvePorts({ CLOSELINE_DEV_CORE_PORT: '3001' })).toThrow('both 3001')
  })
})

describe('secrets', () => {
  test('are 64 hex characters from the random source, one for each role and the internal token', () => {
    let counter = 0
    const secrets = generateSecrets((size) => Buffer.alloc(size, ++counter))
    expect(Object.keys(secrets.passwords).sort()).toEqual([...ROLES].sort())
    expect(secrets.internalToken).toMatch(/^[0-9a-f]{64}$/)
    expect(new Set(secretValues(secrets)).size).toBe(ROLES.length + 1)
  })

  test('differ on every run when the real generator is used', () => {
    const a = generateSecrets()
    const b = generateSecrets()
    expect(a.internalToken).not.toBe(b.internalToken)
    expect(a.passwords.closeline_auth).not.toBe(b.passwords.closeline_auth)
    expect(randomHex(16)).toMatch(/^[0-9a-f]{32}$/)
  })

  test('there is a login role for every database login: the four closeline_* services and postgres', () => {
    expect([...ROLES].sort()).toEqual([
      'closeline_auth',
      'closeline_core',
      'closeline_owner',
      'closeline_playbook',
      'postgres',
    ])
  })

  test('the rotation SQL sets every role to a SCRAM verifier and never contains a password', () => {
    const secrets = generateSecrets()
    const sql = rotationSql(secrets)
    for (const role of ROLES) {
      expect(sql).toMatch(
        new RegExp(
          `ALTER ROLE ${role} PASSWORD 'SCRAM-SHA-256\\$4096:[A-Za-z0-9+/=]+\\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+';`
        )
      )
      expect(sql).not.toContain(secrets.passwords[role])
    }
    expect(sql.split('\n').filter((line) => line.startsWith('ALTER ROLE'))).toHaveLength(
      ROLES.length
    )
  })

  test('refuses to build SQL from a password that is not hex', () => {
    const secrets = generateSecrets()
    const bad = {
      ...secrets,
      passwords: { ...secrets.passwords, closeline_core: "x'; DROP ROLE y;--" },
    }
    expect(() => rotationSql(bad)).toThrow('not hex')
  })

  test('scramVerifier follows RFC 7677: the verifier checks the RFC example client proof', () => {
    const salt = Buffer.from('W22ZaJ0SNY7soEsUEjb6gQ==', 'base64')
    const verifier = scramVerifier('pencil', salt)
    const [, rest] = verifier.split('SCRAM-SHA-256$')
    const [params, keys] = (rest ?? '').split('$')
    expect(params).toBe('4096:W22ZaJ0SNY7soEsUEjb6gQ==')
    const storedKey = Buffer.from((keys ?? '').split(':')[0] ?? '', 'base64')
    const authMessage =
      'n=user,r=rOprNGfwEbeRWgbNEkqO,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,' +
      's=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096,c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0'
    const proof = Buffer.from('dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=', 'base64')
    const signature = createHmac('sha256', storedKey).update(authMessage).digest()
    const clientKey = Buffer.from(proof.map((byte, index) => byte ^ (signature[index] ?? 0)))
    expect(createHash('sha256').update(clientKey).digest().equals(storedKey)).toBe(true)
    const salted = pbkdf2Sync('pencil', salt, 4096, 32, 'sha256')
    expect((keys ?? '').split(':')[1]).toBe(
      createHmac('sha256', salted).update('Server Key').digest().toString('base64')
    )
  })

  test('a failed ALTER ROLE leaves no password for the Postgres log: the statement has only the verifier', () => {
    const secrets = generateSecrets()
    const sql = rotationSql(secrets)
    for (const value of secretValues(secrets)) {
      expect(sql).not.toContain(value)
    }
  })

  test('the login-role query and its check name any role the rotation does not cover', () => {
    expect(LOGIN_ROLES_SQL).toContain('rolcanlogin')
    expect(unrotatedLoginRoles('closeline_auth\ncloseline_playbook\npostgres\n')).toEqual([])
    expect(unrotatedLoginRoles('closeline_auth\ncloseline_billing\r\nsomeone\n')).toEqual([
      'closeline_billing',
      'someone',
    ])
  })
})

describe('buildStackEnv', () => {
  const secrets = generateSecrets()
  const dbDir = '/clones/tula-closeline-db'
  const build = (parent: Record<string, string | undefined> = {}) =>
    buildStackEnv({ parent, ports: DEFAULT_PORTS, secrets, dbDir })

  test('wires auth to core with one shared secret', () => {
    const env = build()
    expect(env.auth.CORE_BASE_URL).toBe('http://127.0.0.1:3100')
    expect(env.auth.CORE_INTERNAL_TOKEN).toBe(secrets.internalToken)
    expect(env.core.INTERNAL_API_TOKENS).toBe(secrets.internalToken)
    expect(env.auth.CORE_INTERNAL_TOKEN?.length).toBeGreaterThanOrEqual(32)
  })

  test('core verifies tokens against the issuer, audience and keys auth publishes', () => {
    const env = build()
    expect(env.core.AUTH_ISSUER).toBe(env.auth.PUBLIC_URL)
    expect(env.core.AUTH_AUDIENCE).toBe(env.auth.TOKEN_AUDIENCE)
    expect(env.core.AUTH_JWKS_URL).toBe(`${env.auth.PUBLIC_URL}/.well-known/jwks.json`)
    expect(env.core.REGION).toBe(env.auth.REGION)
  })

  test('the portal points at both services and core links back to the portal', () => {
    const env = build()
    expect(env.portal.VITE_AUTH_BASE_URL).toBe('http://127.0.0.1:3001')
    expect(env.portal.VITE_CORE_BASE_URL).toBe('http://127.0.0.1:3100')
    expect(env.core.PORTAL_BASE_URL).toBe('http://127.0.0.1:3002')
  })

  test('every service runs as local and each logs in as its own database role on the dev port', () => {
    const env = build()
    expect(env.auth.ENVIRONMENT).toBe('local')
    expect(env.core.ENVIRONMENT).toBe('local')
    expect(env.portal.VITE_ENVIRONMENT).toBe('local')
    expect(env.auth.DATABASE_URL).toBe(
      `postgres://closeline_auth:${secrets.passwords.closeline_auth}@127.0.0.1:5440/closeline`
    )
    expect(env.core.DATABASE_URL).toBe(
      `postgres://closeline_core:${secrets.passwords.closeline_core}@127.0.0.1:5440/closeline`
    )
    expect(env.migrate.DATABASE_URL).toBe(
      `postgres://closeline_owner:${secrets.passwords.closeline_owner}@127.0.0.1:5440/closeline`
    )
  })

  test('a service never receives another role password: not the owner, postgres or playbook', () => {
    const env = build()
    const own = {
      auth: secrets.passwords.closeline_auth,
      core: secrets.passwords.closeline_core,
    }
    for (const service of ['auth', 'core'] as const) {
      const text = JSON.stringify(env[service])
      for (const role of ROLES) {
        const password = secrets.passwords[role]
        expect(text.includes(password)).toBe(password === own[service])
      }
    }
    const portal = JSON.stringify(env.portal)
    for (const password of Object.values(secrets.passwords)) {
      expect(portal).not.toContain(password)
    }
    expect(JSON.stringify(env.portal)).not.toContain(secrets.internalToken)
    const migrate = JSON.stringify(env.migrate)
    expect(migrate).toContain(secrets.passwords.closeline_owner)
    expect(migrate).not.toContain(secrets.passwords.closeline_auth)
    expect(migrate).not.toContain(secrets.internalToken)
  })

  test('the Docker variables reach the compose commands and no service', () => {
    const env = build({
      DOCKER_HOST: 'unix:///home/me/.colima/docker.sock',
      DOCKER_CONTEXT: 'colima',
      DOCKER_CONFIG: '/home/me/.docker',
    })
    expect(env.compose.DOCKER_HOST).toBe('unix:///home/me/.colima/docker.sock')
    expect(env.compose.DOCKER_CONTEXT).toBe('colima')
    expect(env.compose.DOCKER_CONFIG).toBe('/home/me/.docker')
    for (const child of [env.auth, env.core, env.portal, env.migrate]) {
      expect(Object.keys(child).filter((name) => name.startsWith('DOCKER_'))).toEqual([])
    }
  })

  test('a Docker host that is not a local unix socket is refused', () => {
    for (const host of ['tcp://build.example.com:2375', 'ssh://me@server', 'npipe:////./pipe/x']) {
      expect(() => build({ DOCKER_HOST: host })).toThrow('not a local unix socket')
    }
  })

  test('a database host that is not a loopback address is refused before anything is built', () => {
    for (const host of ['db.internal', '10.0.0.5', 'localhost.evil.com']) {
      expect(() =>
        buildStackEnv({ parent: {}, ports: DEFAULT_PORTS, secrets, dbDir, databaseHost: host })
      ).toThrow('loopback')
    }
    for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
      expect(() =>
        buildStackEnv({ parent: {}, ports: DEFAULT_PORTS, secrets, dbDir, databaseHost: host })
      ).not.toThrow()
    }
  })

  test('a variable exported in the developer shell cannot leak into a child', () => {
    const env = build({
      PATH: '/usr/bin',
      DATABASE_URL: 'postgres://prod',
      ENVIRONMENT: 'prod',
      PORT: '80',
      AUTH_MASTER_KEY: 'a'.repeat(64),
      AWS_SECRET_ACCESS_KEY: 'secret',
    })
    for (const child of [env.auth, env.core, env.portal, env.migrate]) {
      expect(child.PATH).toBe('/usr/bin')
      expect(child.AWS_SECRET_ACCESS_KEY).toBeUndefined()
    }
    expect(env.auth.DATABASE_URL).not.toContain('prod')
    expect(env.auth.ENVIRONMENT).toBe('local')
    expect(env.auth.PORT).toBe('3001')
    expect(env.auth.AUTH_MASTER_KEY).toBeUndefined()
  })

  test('the compose environment carries ports and the clone path and no secret', () => {
    const env = build()
    expect(env.compose.CLOSELINE_DB_DIR).toBe(dbDir)
    expect(env.compose.CLOSELINE_DEV_POSTGRES_PORT).toBe('5440')
    const joined = JSON.stringify(env.compose)
    for (const value of secretValues(secrets)) {
      expect(joined).not.toContain(value)
    }
  })

  test('baseChildEnv keeps only the allowlist', () => {
    expect(baseChildEnv({ PATH: 'p', HOME: 'h', FOO: 'x', DATABASE_URL: 'y' })).toEqual({
      PATH: 'p',
      HOME: 'h',
    })
  })
})

describe('assertLoopbackDatabaseUrl', () => {
  test.each([
    'postgres://u:p@127.0.0.1:5440/closeline',
    'postgres://u:p@localhost:5440/closeline',
    'postgres://u:p@[::1]:5440/closeline',
  ])('accepts %s', (url) => {
    expect(() => assertLoopbackDatabaseUrl(url)).not.toThrow()
  })

  test.each([
    'postgres://u:p@db.example.com:5432/closeline',
    'postgres://u:p@10.1.2.3:5432/closeline',
    'postgres://u:p@127.0.0.1.evil.test:5432/closeline',
    'postgres://u:p@/closeline',
    'not a url',
  ])('refuses %s', (url) => {
    expect(() => assertLoopbackDatabaseUrl(url)).toThrow()
  })
})

describe('dockerEndpointProblem', () => {
  const socket = async () => 'unix:///var/run/docker.sock'

  test('DOCKER_HOST=tcp://x is refused without asking the context', async () => {
    let asked = false
    const problem = await dockerEndpointProblem({ DOCKER_HOST: 'tcp://x:2375' }, async () => {
      asked = true
      return 'unix:///var/run/docker.sock'
    })
    expect(problem).toContain('tcp://x:2375')
    expect(asked).toBe(false)
  })

  test('a current context that is remote is refused although no variable is set', async () => {
    expect(await dockerEndpointProblem({}, async () => 'ssh://me@build-box')).toContain(
      'ssh://me@build-box'
    )
    expect(
      await dockerEndpointProblem({ DOCKER_CONTEXT: 'remote' }, async () => 'tcp://10.0.0.9:2376')
    ).toContain('not a local unix socket')
  })

  test('an unknown endpoint is refused rather than assumed local', async () => {
    expect(await dockerEndpointProblem({}, async () => undefined)).toContain('cannot tell')
  })

  test('a local socket passes, from the context or from DOCKER_HOST', async () => {
    expect(await dockerEndpointProblem({}, socket)).toBeUndefined()
    expect(
      await dockerEndpointProblem(
        { DOCKER_HOST: 'unix:///home/me/.colima/docker.sock' },
        async () => 'tcp://ignored'
      )
    ).toBeUndefined()
  })
})

describe('compose and migrate command lines', () => {
  test('every compose command, down included, names only the closeline-dev project', () => {
    for (const args of [
      downArgs('/hub/compose.dev.yaml', false),
      downArgs('/hub/compose.dev.yaml', true),
      composeArgs('/hub/compose.dev.yaml', 'ps', '-q'),
    ]) {
      const at = args.indexOf('-p')
      expect(args.slice(0, 2)).toEqual(['docker', 'compose'])
      expect(args[at + 1]).toBe('closeline-dev')
      expect(args.filter((arg) => arg === '-p')).toHaveLength(1)
      expect(args[args.indexOf('-f') + 1]).toBe('/hub/compose.dev.yaml')
    }
  })

  test('down removes volumes only when asked, and never prunes anything else', () => {
    expect(downArgs('/c.yaml', false)).not.toContain('--volumes')
    expect(downArgs('/c.yaml', true)).toContain('--volumes')
    for (const args of [downArgs('/c.yaml', true), downArgs('/c.yaml', false)]) {
      expect(args.join(' ')).not.toMatch(/prune|--rmi|\bvolume\b|\bsystem\b/)
    }
  })

  test('compose reads no .env file from the hub', () => {
    const args = composeArgs('/c.yaml', 'up')
    expect(args[args.indexOf('--env-file') + 1]).toBe('/dev/null')
  })

  test("migrate runs the db library's script file with no .env loaded, never drizzle-kit push", () => {
    const command = migrateCommand('/bin/bun')
    expect(command).toEqual(['/bin/bun', '--no-env-file', 'scripts/migrate.ts'])
    expect(command).not.toContain('run')
  })
})

describe('serviceDefinitions', () => {
  const definitions = serviceDefinitions('/bin/bun', DEFAULT_PORTS)

  test('starts core before auth, which calls it, and keeps a stray .env out of every process', () => {
    expect(definitions.map((definition) => definition.name)).toEqual(['core', 'auth', 'portal'])
    for (const definition of definitions) {
      expect(definition.cmd.slice(0, 2)).toEqual(['/bin/bun', '--no-env-file'])
    }
  })

  test('the portal binds the loopback address on its own port and never moves to another', () => {
    const portal = definitions.find((definition) => definition.name === 'portal')
    expect(portal?.cmd).toContain('--strictPort')
    expect(portal?.cmd.join(' ')).toContain('--host 127.0.0.1 --port 3002')
    expect(portal?.readyUrl).toBe('http://127.0.0.1:3002/')
  })
})

describe('output', () => {
  test('redact removes every secret everywhere in the text', () => {
    expect(redact('a SECRET b SECRET c TOKEN', ['SECRET', 'TOKEN'])).toBe(
      'a [redacted] b [redacted] c [redacted]'
    )
    expect(redact('nothing here', [''])).toBe('nothing here')
  })

  test('LinePrefixer prefixes whole lines, joins a line split across chunks and flushes the rest', () => {
    const written: string[] = []
    const prefixer = new LinePrefixer('auth', (line) => written.push(line))
    prefixer.push('first\nsec')
    prefixer.push('ond\r\nthird')
    expect(written).toEqual(['[auth]     first\n', '[auth]     second\n'])
    prefixer.flush()
    expect(written.at(-1)).toBe('[auth]     third\n')
    prefixer.flush()
    expect(written).toHaveLength(3)
  })

  test('LinePrefixer redacts a secret even when a line is split across chunks', () => {
    const written: string[] = []
    const prefixer = new LinePrefixer('core', (line) => written.push(line), ['hunter2hunter2'])
    prefixer.push('token=hunter2')
    prefixer.push('hunter2 done\n')
    expect(written).toEqual(['[core]     token=[redacted] done\n'])
  })
})

describe('ports', () => {
  test('isPortInUse sees a listener and then sees it gone', async () => {
    const listener = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
    const port = listener.port
    expect(await isPortInUse(port)).toBe(true)
    listener.stop(true)
    expect(await isPortInUse(port)).toBe(false)
  })

  test('busyPorts names each taken port and its owner', async () => {
    const problems = await busyPorts(
      [
        { name: 'auth', port: 3001 },
        { name: 'core', port: 3100 },
      ],
      async (port) => port === 3100
    )
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('3100 (core)')
  })
})

describe('checkSiblings', () => {
  function clone(root: string, short: string, name = `tula-closeline-${short}`, installed = true) {
    const dir = join(root, `tula-closeline-${short}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name }))
    if (installed) {
      mkdirSync(join(dir, 'node_modules/vite/bin'), { recursive: true })
      writeFileSync(join(dir, 'node_modules/vite/bin/vite.js'), '')
    }
  }

  test('is empty when every clone is there and installed', () => {
    const root = mkdtempSync(join(tmpdir(), 'closeline-dev-'))
    for (const short of ['db', 'auth', 'core', 'portal']) {
      clone(root, short)
    }
    expect(checkSiblings(root)).toEqual([])
  })

  test('names a missing clone, a wrong repo and a clone that is not installed', () => {
    const root = mkdtempSync(join(tmpdir(), 'closeline-dev-'))
    clone(root, 'db')
    clone(root, 'auth', 'something-else')
    clone(root, 'core', undefined, false)
    const problems = checkSiblings(root)
    expect(problems.some((p) => p.includes('tula-closeline-portal is missing'))).toBe(true)
    expect(problems.some((p) => p.includes('is not tula-closeline-auth'))).toBe(true)
    expect(problems.some((p) => p.includes('tula-closeline-core has no node_modules'))).toBe(true)
    expect(problems).toHaveLength(3)
  })

  test('asks for vite when the portal has node_modules without it', () => {
    const root = mkdtempSync(join(tmpdir(), 'closeline-dev-'))
    clone(root, 'portal', undefined, false)
    mkdirSync(join(root, 'tula-closeline-portal/node_modules'))
    expect(checkSiblings(root, ['portal'])[0]).toContain('no vite installed')
  })
})

/** A 503 that bumps the caller's counter. */
function countedResponse(bump: () => number): Response {
  bump()
  return new Response('x', { status: 503 })
}

describe('requestWithRetry', () => {
  const quick = { backoffMs: () => 1, timeoutMs: 500 }

  test('retries a 503 and returns the answer that follows', async () => {
    let calls = 0
    const { server, origin } = serve(() => new Response('x', { status: ++calls < 3 ? 503 : 200 }))
    const response = await requestWithRetry(origin, {}, quick)
    server.stop(true)
    expect(response.status).toBe(200)
    expect(calls).toBe(3)
  })

  test('gives up after the bound and returns the last 503', async () => {
    let calls = 0
    const { server, origin } = serve(() => countedResponse(() => ++calls))
    const response = await requestWithRetry(origin, {}, { ...quick, attempts: 2 })
    server.stop(true)
    expect(response.status).toBe(503)
    expect(calls).toBe(2)
  })

  test('does not retry a 4xx or a request marked not idempotent', async () => {
    let calls = 0
    const { server, origin } = serve(() => countedResponse(() => ++calls))
    const response = await requestWithRetry(origin, { method: 'POST', idempotent: false }, quick)
    server.stop(true)
    expect(response.status).toBe(503)
    expect(calls).toBe(1)
  })

  test('times out a server that never answers, on every attempt', async () => {
    let calls = 0
    const { server, origin } = serve(async () => {
      ++calls
      await Bun.sleep(300)
      return new Response('late')
    })
    await expect(
      requestWithRetry(origin, {}, { backoffMs: () => 1, timeoutMs: 40, attempts: 2 })
    ).rejects.toThrow()
    server.stop(true)
    expect(calls).toBe(2)
  })

  test('a connection that is refused is retried then thrown', async () => {
    const listener = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
    const port = listener.port
    listener.stop(true)
    await expect(
      requestWithRetry(`http://127.0.0.1:${port}/`, {}, { ...quick, attempts: 2 })
    ).rejects.toThrow()
  })
})

describe('waitForReady', () => {
  test('returns once the URL answers 2xx', async () => {
    let calls = 0
    const { server, origin } = serve(() => new Response('ok', { status: ++calls < 3 ? 503 : 200 }))
    expect(await waitForReady(origin, { timeoutMs: 2_000, intervalMs: 5 })).toBeUndefined()
    server.stop(true)
  })

  test('reports a timeout, naming the URL', async () => {
    const message = await waitForReady('http://127.0.0.1:1/never', {
      timeoutMs: 100,
      intervalMs: 10,
    })
    expect(message).toContain('did not answer 2xx at http://127.0.0.1:1/never')
  })

  test('stops at once when the process is gone', async () => {
    const message = await waitForReady('http://127.0.0.1:1/never', {
      timeoutMs: 5_000,
      isAlive: () => false,
    })
    expect(message).toContain('exited')
  })
})

describe('probeInternalWiring', () => {
  /** A core that accepts exactly one secret, like core's internalAuth. */
  function fakeCore(secret: string, answer = { found: false }) {
    const seen: { auth: string | null; key: string | null; body: unknown }[] = []
    const { server, origin } = serve(async (request) => {
      const body = await request.json()
      seen.push({
        auth: request.headers.get('authorization'),
        key: request.headers.get('idempotency-key'),
        body,
      })
      if (new URL(request.url).pathname !== '/internal/membership') {
        return new Response('{}', { status: 404 })
      }
      if (request.headers.get('authorization') !== `Bearer ${secret}`) {
        return Response.json({ error: { code: 'auth.unauthenticated' } }, { status: 401 })
      }
      return Response.json(answer)
    })
    return { server, origin, seen }
  }

  test('is ok when the secret is accepted and a different one refused', async () => {
    const secret = randomHex(32)
    const { server, origin, seen } = fakeCore(secret)
    const result = await probeInternalWiring({ coreOrigin: origin, token: secret })
    server.stop(true)
    expect(result).toEqual({ ok: true })
    expect(seen).toHaveLength(2)
    expect(JSON.stringify(seen[0]?.body)).toMatch(/"userId":"usr_[0-9a-f]{32}"/)
    expect(seen[0]?.key?.length).toBeGreaterThanOrEqual(16)
  })

  test('says which side is wrong, without the secret', async () => {
    const secret = randomHex(32)
    const { server, origin } = fakeCore(randomHex(32))
    const result = await probeInternalWiring({ coreOrigin: origin, token: secret })
    server.stop(true)
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).toContain('401')
    expect(JSON.stringify(result)).not.toContain(secret)
  })

  test('fails when core accepts a wrong secret', async () => {
    const { server, origin } = serve(() => Response.json({ found: false }))
    const result = await probeInternalWiring({ coreOrigin: origin, token: randomHex(32) })
    server.stop(true)
    expect(result).toEqual({ ok: false, reason: 'core answered a wrong secret with 200, not 401' })
  })
})
