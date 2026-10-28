import './test-guard.ts'
import { describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { createHash, createHmac, pbkdf2Sync } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FAKE_GOOGLE_CLIENT_ID, FAKE_GOOGLE_CLIENT_SECRET } from './dev-fake-google.ts'
import {
  acquireStartLock,
  assertLoopbackDatabaseUrl,
  baseChildEnv,
  buildStackEnv,
  busyPorts,
  captureCommand,
  checkSiblings,
  composeArgs,
  DEFAULT_PORTS,
  dockerEndpointProblem,
  downArgs,
  ensureRolesSql,
  freshSalt,
  generateSecrets,
  isPortInUse,
  LinePrefixer,
  LOGIN_ROLES_SQL,
  migrateCommand,
  NOLOGIN_ROLES,
  origins,
  parseArgs,
  probeInternalWiring,
  processStart,
  ROLES,
  randomHex,
  redact,
  requestWithRetry,
  resolvePorts,
  rotationSql,
  runCommand,
  scramVerifier,
  secretValues,
  serviceDefinitions,
  spawnManaged,
  stopLockHolder,
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
    expect(parseArgs([])).toEqual({ kind: 'up', infisical: true, tunnel: false })
    expect(parseArgs(['--no-infisical'])).toEqual({ kind: 'up', infisical: false, tunnel: false })
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

  test('the playbook port defaults to the one the portal expects and can be moved', () => {
    expect(resolvePorts({}).playbook).toBe(3003)
    expect(resolvePorts({ CLOSELINE_DEV_PLAYBOOK_PORT: '3013' }).playbook).toBe(3013)
    expect(() => resolvePorts({ CLOSELINE_DEV_PLAYBOOK_PORT: '3001' })).toThrow('both 3001')
  })

  test('the outbound port defaults to 3005 and can be moved', () => {
    expect(resolvePorts({}).outbound).toBe(3005)
    expect(resolvePorts({ CLOSELINE_DEV_OUTBOUND_PORT: '3015' }).outbound).toBe(3015)
  })

  test('the voice port defaults to the one the portal expects and can be moved', () => {
    expect(resolvePorts({}).voice).toBe(3004)
    expect(resolvePorts({ CLOSELINE_DEV_VOICE_PORT: '3014' }).voice).toBe(3014)
    expect(() => resolvePorts({ CLOSELINE_DEV_VOICE_PORT: '3003' })).toThrow('both 3003')
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
  test('are 64 hex characters from the random source, one for each role, the internal token and the playbook token', () => {
    let counter = 0
    const secrets = generateSecrets((size) => Buffer.alloc(size, ++counter))
    expect(Object.keys(secrets.passwords).sort()).toEqual([...ROLES].sort())
    expect(secrets.internalToken).toMatch(/^[0-9a-f]{64}$/)
    expect(secrets.playbookToken).toMatch(/^[0-9a-f]{64}$/)
    expect(secrets.voiceCoreToken).toMatch(/^[0-9a-f]{64}$/)
    expect(secrets.voicePlaybookToken).toMatch(/^[0-9a-f]{64}$/)
    expect(secrets.coreVoiceToken).toMatch(/^[0-9a-f]{64}$/)
    expect(secrets.unsubscribeTokenKey).toMatch(/^[0-9a-f]{64}$/)
    expect(new Set(secretValues(secrets)).size).toBe(ROLES.length + 7)
  })

  test('differ on every run when the real generator is used', () => {
    const a = generateSecrets()
    const b = generateSecrets()
    expect(a.internalToken).not.toBe(b.internalToken)
    expect(a.playbookToken).not.toBe(b.playbookToken)
    expect(a.voiceCoreToken).not.toBe(b.voiceCoreToken)
    expect(a.unsubscribeTokenKey).not.toBe(b.unsubscribeTokenKey)
    expect(a.passwords.closeline_auth).not.toBe(b.passwords.closeline_auth)
    expect(randomHex(16)).toMatch(/^[0-9a-f]{32}$/)
  })

  test('there is a login role for every database login: the six closeline_* roles and postgres', () => {
    expect([...ROLES].sort()).toEqual([
      'closeline_auth',
      'closeline_core',
      'closeline_outbound',
      'closeline_owner',
      'closeline_playbook',
      'closeline_voice',
      'postgres',
    ])
  })

  test('the rotation SQL sets every role to a SCRAM verifier and never contains a password', () => {
    const secrets = generateSecrets()
    const sql = rotationSql(secrets, freshSalt)
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
    expect(() => rotationSql(bad, freshSalt)).toThrow('not hex')
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
    const sql = rotationSql(secrets, freshSalt)
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
    expect(env.core.INTERNAL_API_TOKENS).toBe(
      `${secrets.internalToken},${secrets.voiceCoreToken},${secrets.outboundCoreToken}`
    )
    expect(env.auth.CORE_INTERNAL_TOKEN?.length).toBeGreaterThanOrEqual(32)
  })

  test('core verifies tokens against the issuer, audience and keys auth publishes', () => {
    const env = build()
    expect(env.core.AUTH_ISSUER).toBe(env.auth.PUBLIC_URL)
    expect(env.core.AUTH_AUDIENCE).toBe(env.auth.TOKEN_AUDIENCE)
    expect(env.core.AUTH_JWKS_URL).toBe(`${env.auth.PUBLIC_URL}/.well-known/jwks.json`)
    expect(env.core.REGION).toBe(env.auth.REGION)
  })

  test('the portal proxies to auth, core and the playbook, and core links back to the portal', () => {
    const env = build()
    expect(env.portal.AUTH_PROXY_TARGET).toBe('http://127.0.0.1:3001')
    expect(env.portal.CORE_PROXY_TARGET).toBe('http://127.0.0.1:3100')
    expect(env.portal.PLAYBOOK_PROXY_TARGET).toBe('http://127.0.0.1:3003')
    expect(env.portal.VOICE_PROXY_TARGET).toBe('http://127.0.0.1:3004')
    expect(env.core.PORTAL_BASE_URL).toBe('http://127.0.0.1:3002')
  })

  test('compose gets a hash of the queue config, so a changed config recreates the queue', () => {
    const hash = (queueConfig: string) =>
      buildStackEnv({ parent: {}, ports: DEFAULT_PORTS, secrets, dbDir, queueConfig }).compose
        .CLOSELINE_DEV_QUEUE_CONFIG_SHA
    expect(hash('queues { a {} }')).toMatch(/^[0-9a-f]{64}$/)
    expect(hash('queues { a {} }')).toBe(hash('queues { a {} }'))
    expect(hash('queues { a {} b {} }')).not.toBe(hash('queues { a {} }'))
    expect(build().compose.CLOSELINE_DEV_QUEUE_CONFIG_SHA).toBeUndefined()
  })

  test('auth allows the portal origin for browser sessions, on the overridden port too', () => {
    expect(build().auth.SESSION_ALLOWED_ORIGINS).toBe('http://127.0.0.1:3002')
    const moved = buildStackEnv({
      parent: {},
      ports: resolvePorts({ CLOSELINE_DEV_PORTAL_PORT: '4402' }),
      secrets,
      dbDir,
    })
    expect(moved.auth.SESSION_ALLOWED_ORIGINS).toBe('http://127.0.0.1:4402')
    expect(moved.core.PORTAL_BASE_URL).toBe('http://127.0.0.1:4402')
  })

  test('without CLOSELINE_DEV_PUBLIC_ORIGIN nothing about the public origin is set', () => {
    const env = build({ CLOSELINE_DEV_PUBLIC_ORIGIN: '' })
    expect(env.auth.SESSION_ALLOWED_ORIGINS).toBe('http://127.0.0.1:3002')
    expect(env.portal.PORTAL_DEV_ALLOWED_HOSTS).toBeUndefined()
  })

  test('a public origin is allowed for sessions and its host for the portal dev server', () => {
    const env = build({ CLOSELINE_DEV_PUBLIC_ORIGIN: 'https://quiet-fox-1.trycloudflare.com' })
    expect(env.auth.SESSION_ALLOWED_ORIGINS).toBe(
      'http://127.0.0.1:3002,https://quiet-fox-1.trycloudflare.com'
    )
    expect(env.portal.PORTAL_DEV_ALLOWED_HOSTS).toBe('quiet-fox-1.trycloudflare.com')
    expect(env.core.PORTAL_BASE_URL).toBe('http://127.0.0.1:3002')
  })

  test('a public origin with a port keeps the port for auth and drops it for the host', () => {
    const env = build({ CLOSELINE_DEV_PUBLIC_ORIGIN: 'https://dev.example.com:8443' })
    expect(env.auth.SESSION_ALLOWED_ORIGINS).toBe(
      'http://127.0.0.1:3002,https://dev.example.com:8443'
    )
    expect(env.portal.PORTAL_DEV_ALLOWED_HOSTS).toBe('dev.example.com')
  })

  test.each([
    'http://a.trycloudflare.com',
    'https://a.trycloudflare.com/app',
    'https://a.trycloudflare.com/',
    'https://A.trycloudflare.com',
    'https://*.trycloudflare.com',
    'https://a.trycloudflare.com?x=1',
    'https://a.trycloudflare.com#x',
    'https://user@a.trycloudflare.com',
    'https://a.trycloudflare.com:99999x',
    'a.trycloudflare.com',
    'https://',
    'https://a b.com',
    'https://a.com:0',
    'https://a.com:65536',
    'https://a.com:099',
    'https://a.com:443',
    'https://example.1',
  ])('refuses the public origin %s before anything starts', (origin) => {
    expect(() => build({ CLOSELINE_DEV_PUBLIC_ORIGIN: origin })).toThrow(
      'CLOSELINE_DEV_PUBLIC_ORIGIN'
    )
  })

  test('the playbook verifies auth tokens like core and logs in as closeline_playbook', () => {
    const env = build()
    expect(env.playbook.ENVIRONMENT).toBe('local')
    expect(env.playbook.PORT).toBe('3003')
    expect(env.playbook.AUTH_ISSUER).toBe(env.auth.PUBLIC_URL)
    expect(env.playbook.AUTH_AUDIENCE).toBe(env.auth.TOKEN_AUDIENCE)
    expect(env.playbook.AUTH_JWKS_URL).toBe(`${env.auth.PUBLIC_URL}/.well-known/jwks.json`)
    expect(env.playbook.DATABASE_URL).toBe(
      `postgres://closeline_playbook:${secrets.passwords.closeline_playbook}@127.0.0.1:5440/closeline`
    )
  })

  test('core gets a generated unsubscribe key and the jobs queue of the compose stand-in', () => {
    const env = build()
    expect(env.core.UNSUBSCRIBE_TOKEN_KEY).toMatch(/^[0-9a-f]{64}$/)
    expect(env.core.JOBS_QUEUE_URL).toBe('http://127.0.0.1:9324/000000000000/core-jobs')
    expect(env.core.AUDIT_QUEUE_URL).toBe('http://127.0.0.1:9324/000000000000/core-audit')
    expect(env.core.QUEUE_ENDPOINT).toBe('http://127.0.0.1:9324')
    expect(JSON.stringify(env.auth)).not.toContain(env.core.UNSUBSCRIBE_TOKEN_KEY ?? 'x')
  })

  test('outbound reaches core internally with its own secret, which core also accepts', () => {
    const env = build()
    expect(env.outbound.CORE_URL).toBe('http://127.0.0.1:3100')
    expect(env.outbound.CORE_INTERNAL_SECRET).toBe(secrets.outboundCoreToken)
    expect(env.core.INTERNAL_API_TOKENS?.split(',')).toContain(secrets.outboundCoreToken)
    expect(secrets.outboundCoreToken).not.toBe(secrets.voiceCoreToken)
    expect(secrets.outboundCoreToken).not.toBe(secrets.internalToken)
    expect(secretValues(secrets)).toContain(secrets.outboundCoreToken)
    expect(JSON.stringify(env.voice)).not.toContain(secrets.outboundCoreToken)
    expect(JSON.stringify(env.portal)).not.toContain(secrets.outboundCoreToken)
  })

  test('voice reaches core internally with its own secret, which core also accepts', () => {
    const env = build()
    expect(env.voice.CORE_INTERNAL_URL).toBe('http://127.0.0.1:3100')
    expect(env.voice.CORE_INTERNAL_TOKEN).toBe(secrets.voiceCoreToken)
    expect(env.core.INTERNAL_API_TOKENS?.split(',')).toContain(secrets.voiceCoreToken)
    expect(env.core.INTERNAL_API_TOKENS?.split(',')).toContain(secrets.internalToken)
    expect(secrets.voiceCoreToken).not.toBe(secrets.internalToken)
    expect(JSON.stringify(env.auth)).not.toContain(secrets.voiceCoreToken)
    expect(JSON.stringify(env.portal)).not.toContain(secrets.voiceCoreToken)
  })

  test('the playbook uses the compose queue and object storage, with its own internal secret', () => {
    const env = build()
    expect(env.playbook.QUEUE_ENDPOINT).toBe('http://127.0.0.1:9324')
    expect(env.playbook.QUEUE_URL).toBe('http://127.0.0.1:9324/000000000000/closeline-playbook')
    expect(env.playbook.STORAGE_ENDPOINT).toBe('http://127.0.0.1:9090')
    expect(env.playbook.STORAGE_BUCKET).toBe('closeline-dev')
    expect(env.playbook.INTERNAL_API_TOKENS?.split(',')).toEqual([
      secrets.playbookToken,
      secrets.voicePlaybookToken,
    ])
    expect(secrets.playbookToken).not.toBe(secrets.internalToken)
    expect(JSON.stringify(env.core)).not.toContain(secrets.playbookToken)
    expect(JSON.stringify(env.auth)).not.toContain(secrets.playbookToken)
  })

  test('core reaches voice internally with its own secret, which voice also accepts', () => {
    const env = build()
    expect(env.core.VOICE_INTERNAL_URL).toBe('http://127.0.0.1:3004')
    expect(env.core.VOICE_INTERNAL_TOKEN).toBe(secrets.coreVoiceToken)
    expect(env.voice.INTERNAL_API_TOKENS?.split(',')).toEqual([secrets.coreVoiceToken])
    expect(secrets.coreVoiceToken).toMatch(/^[\x20-\x7e]{32,512}$/)
    expect(secretValues(secrets)).toContain(secrets.coreVoiceToken)
    for (const service of ['auth', 'playbook', 'outbound', 'portal'] as const) {
      expect(JSON.stringify(env[service])).not.toContain(secrets.coreVoiceToken)
    }
  })

  test('voice reaches the playbook internally with its own secret, which the playbook also accepts', () => {
    const env = build()
    expect(env.voice.PLAYBOOK_INTERNAL_URL).toBe('http://127.0.0.1:3003')
    expect(env.voice.PLAYBOOK_INTERNAL_TOKEN).toBe(secrets.voicePlaybookToken)
    expect(env.playbook.INTERNAL_API_TOKENS?.split(',')).toContain(secrets.voicePlaybookToken)
    expect(secrets.voicePlaybookToken).not.toBe(secrets.playbookToken)
    expect(secretValues(secrets)).toContain(secrets.voicePlaybookToken)
    for (const service of ['auth', 'core', 'outbound', 'portal'] as const) {
      expect(JSON.stringify(env[service])).not.toContain(secrets.voicePlaybookToken)
    }
    expect(JSON.stringify(env.voice)).not.toContain(secrets.playbookToken)
  })

  test('the playbook gets no setting that would turn its in-process stand-ins off or on elsewhere', () => {
    const env = build()
    expect(env.playbook.WORKERS_ENABLED).toBeUndefined()
    expect(env.playbook.SENTRY_DSN).toBeUndefined()
  })

  test('voice verifies auth tokens like core, logs in as closeline_voice and uses no real telephony', () => {
    const env = build()
    expect(env.voice.ENVIRONMENT).toBe('local')
    expect(env.voice.PORT).toBe('3004')
    expect(env.voice.REGION).toBe('us')
    expect(env.voice.AUTH_ISSUER).toBe(env.auth.PUBLIC_URL)
    expect(env.voice.AUTH_AUDIENCE).toBe(env.auth.TOKEN_AUDIENCE)
    expect(env.voice.AUTH_JWKS_URL).toBe(`${env.auth.PUBLIC_URL}/.well-known/jwks.json`)
    expect(env.voice.DATABASE_URL).toBe(
      `postgres://closeline_voice:${secrets.passwords.closeline_voice}@127.0.0.1:5440/closeline`
    )
    expect(env.voice.TELEPHONY_PROVIDER).toBe('memory')
    expect(Object.keys(env.voice).filter((name) => name.startsWith('TWILIO'))).toEqual([])
  })

  test('outbound logs in as closeline_outbound on the dev port and verifies auth tokens like core', () => {
    const env = build()
    expect(env.outbound.DATABASE_URL).toBe(
      `postgres://closeline_outbound:${secrets.passwords.closeline_outbound}@127.0.0.1:5440/closeline`
    )
    expect(env.outbound.AUTH_ISSUER).toBe(env.auth.PUBLIC_URL)
    expect(env.outbound.AUTH_AUDIENCE).toBe(env.auth.TOKEN_AUDIENCE)
    expect(env.outbound.AUTH_JWKS_URL).toBe(`${env.auth.PUBLIC_URL}/.well-known/jwks.json`)
    expect(env.outbound.REGION).toBe('us')
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

  test('a service never receives another role password: not the owner or postgres, nor that of another service', () => {
    const env = build()
    const own = {
      auth: secrets.passwords.closeline_auth,
      core: secrets.passwords.closeline_core,
      playbook: secrets.passwords.closeline_playbook,
      voice: secrets.passwords.closeline_voice,
      outbound: secrets.passwords.closeline_outbound,
    }
    for (const service of ['auth', 'core', 'playbook', 'voice', 'outbound'] as const) {
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
    for (const child of [env.auth, env.core, env.playbook, env.voice, env.portal, env.migrate]) {
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
    for (const child of [env.auth, env.core, env.playbook, env.voice, env.portal, env.migrate]) {
      expect(child.PATH).toBe('/usr/bin')
      expect(child.AWS_SECRET_ACCESS_KEY).not.toBe('secret')
    }
    expect(env.playbook.AWS_SECRET_ACCESS_KEY).toBe('local')
    expect(env.core.AWS_SECRET_ACCESS_KEY).toBe('local')
    for (const child of [env.auth, env.portal, env.migrate]) {
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

describe('ensureRolesSql', () => {
  const sql = ensureRolesSql()

  test('creates each NOLOGIN role only when missing and grants it to the owner', () => {
    expect(NOLOGIN_ROLES.length).toBeGreaterThan(0)
    for (const { name } of NOLOGIN_ROLES) {
      expect(sql).toContain(`rolname = '${name}'`)
      expect(sql).toMatch(
        new RegExp(`IF NOT EXISTS[^;]*'${name}'[^;]*THEN\\s+CREATE ROLE ${name} NOLOGIN`)
      )
      expect(sql).toContain(`GRANT ${name} TO closeline_owner WITH SET TRUE, INHERIT FALSE;`)
    }
  })

  test('creates the closeline_outbound login role when missing, without a password', () => {
    expect(ROLES).toContain('closeline_outbound')
    expect(sql).toMatch(
      /IF NOT EXISTS[^;]*'closeline_outbound'[^;]*THEN\s+CREATE ROLE closeline_outbound LOGIN/
    )
  })

  test('never changes a password or a login role', () => {
    expect(sql).not.toContain('ALTER ROLE')
    expect(sql).not.toContain('PASSWORD')
  })

  test('matches every NOLOGIN role of the db clone init.sql, attributes included', () => {
    const root = process.env.CLOSELINE_SIBLINGS_DIR ?? join(import.meta.dir, '..', '..')
    const file = join(root, 'tula-closeline-db', 'docker', 'postgres', 'init.sql')
    if (!existsSync(file)) {
      return
    }
    const squash = (text: string) => text.replace(/\s+/g, ' ').trim()
    const found = [...readFileSync(file, 'utf8').matchAll(/CREATE ROLE (\w+) NOLOGIN([^;]*);/g)]
    const fromInit = found.map((m) => [m[1] ?? '', squash(m[2] ?? '')])
    const listed = NOLOGIN_ROLES.map((role) => [role.name, squash(role.attributes)])
    expect(listed.sort()).toEqual(fromInit.sort())
    expect(fromInit.length).toBeGreaterThan(0)
  })
})

describe('serviceDefinitions', () => {
  const definitions = serviceDefinitions('/bin/bun', DEFAULT_PORTS)

  test('starts core before auth, which calls it, then the playbook and the portal, with no stray .env', () => {
    expect(definitions.map((definition) => definition.name)).toEqual([
      'core',
      'auth',
      'playbook',
      'voice',
      'outbound',
      'portal',
    ])
    for (const definition of definitions) {
      expect(definition.cmd.slice(0, 2)).toEqual(['/bin/bun', '--no-env-file'])
    }
  })

  test('the playbook is one process for the API and the workers, ready when /readyz answers', () => {
    const playbook = definitions.find((definition) => definition.name === 'playbook')
    expect(playbook?.sibling).toBe('playbook')
    expect(playbook?.cmd).toEqual(['/bin/bun', '--no-env-file', 'src/server.ts'])
    expect(playbook?.env).toBe('playbook')
    expect(playbook?.readyUrl).toBe('http://127.0.0.1:3003/readyz')
  })

  test('the portal runs the dev server unless a built portal is asked for', () => {
    const dev = definitions.find((definition) => definition.name === 'portal')
    expect(dev?.cmd.join(' ')).not.toContain('preview')
    const built = serviceDefinitions('/bin/bun', DEFAULT_PORTS, false, true).find(
      (definition) => definition.name === 'portal'
    )
    const script = built?.cmd.at(-1) ?? ''
    expect(built?.cmd.slice(0, 2)).toEqual(['/bin/sh', '-c'])
    expect(script).toContain("'/bin/bun' --no-env-file --bun node_modules/vite/bin/vite.js build")
    expect(script).toContain('&& exec ')
    expect(script).toContain('preview --outDir node_modules/.closeline-dev-dist')
    expect(script).toContain('--port 3002 --strictPort')
    expect(built?.readyUrl).toBe('http://127.0.0.1:3002/')
  })

  test('voice runs from its clone like the playbook, ready when /readyz answers', () => {
    const voice = definitions.find((definition) => definition.name === 'voice')
    expect(voice?.sibling).toBe('voice')
    expect(voice?.cmd).toEqual(['/bin/bun', '--no-env-file', 'src/server.ts'])
    expect(voice?.env).toBe('voice')
    expect(voice?.readyUrl).toBe('http://127.0.0.1:3004/readyz')
  })

  test('outbound runs from its clone like voice, ready when /readyz answers', () => {
    const outbound = definitions.find((definition) => definition.name === 'outbound')
    expect(outbound?.sibling).toBe('outbound')
    expect(outbound?.cmd).toEqual(['/bin/bun', '--no-env-file', 'src/server.ts'])
    expect(outbound?.env).toBe('outbound')
    expect(outbound?.readyUrl).toBe('http://127.0.0.1:3005/readyz')
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
    for (const short of ['db', 'auth', 'core', 'playbook', 'voice', 'outbound', 'portal']) {
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
    expect(problems.some((p) => p.includes('tula-closeline-playbook is missing'))).toBe(true)
    expect(problems.some((p) => p.includes('tula-closeline-voice is missing'))).toBe(true)
    expect(problems.some((p) => p.includes('tula-closeline-outbound is missing'))).toBe(true)
    expect(problems.some((p) => p.includes('is not tula-closeline-auth'))).toBe(true)
    expect(problems.some((p) => p.includes('tula-closeline-core has no node_modules'))).toBe(true)
    expect(problems).toHaveLength(6)
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

describe('the local mailbox settings', () => {
  const secrets = generateSecrets()
  const build = (ports = DEFAULT_PORTS) =>
    buildStackEnv({ parent: {}, ports, secrets, dbDir: '/db' })

  test('the mailbox is on 8026 by default, which the other Mailpit on 8025 does not use', () => {
    expect(DEFAULT_PORTS.mail).toBe(8026)
    expect(resolvePorts({ CLOSELINE_DEV_MAIL_PORT: '8100' }).mail).toBe(8100)
    expect(() => resolvePorts({ CLOSELINE_DEV_MAIL_PORT: 'x' })).toThrow('CLOSELINE_DEV_MAIL_PORT')
    expect(() => resolvePorts({ CLOSELINE_DEV_MAIL_PORT: '3001' })).toThrow('both 3001')
  })

  test('auth and core get the one mailbox address, in the exact form their schemas accept', () => {
    const env = build()
    for (const service of [env.auth, env.core]) {
      expect(service.MAIL_LOCAL_URL).toBe('http://127.0.0.1:8026')
      expect(service.MAIL_LOCAL_URL).toMatch(/^http:\/\/(127\.0\.0\.1|\[::1\]|localhost)(:\d+)?$/)
      expect(service.ENVIRONMENT).toBe('local')
    }
    expect(build({ ...DEFAULT_PORTS, mail: 8099 }).auth.MAIL_LOCAL_URL).toBe(
      'http://127.0.0.1:8099'
    )
  })

  test('nothing else gets the mailbox address, and no sender is invented', () => {
    const env = build()
    for (const other of [env.portal, env.migrate]) {
      expect(JSON.stringify(other)).not.toContain('MAIL_')
    }
    expect(env.auth.MAIL_LOCAL_FROM).toBeUndefined()
    expect(env.core.MAIL_LOCAL_FROM).toBeUndefined()
    expect(env.compose.CLOSELINE_DEV_MAIL_PORT).toBe('8026')
    expect(origins(DEFAULT_PORTS).mail).toBe('http://127.0.0.1:8026')
  })
})

describe('a program that is not installed', () => {
  const gone = ['/definitely/not/installed/docker', 'version']
  const quiet = { out: () => {}, err: () => {} }

  test('captureCommand answers undefined and runCommand 127, with a message and no throw', async () => {
    expect(await captureCommand(gone, { cwd: '/', env: {}, timeoutMs: 1_000 })).toBeUndefined()
    const lines: string[] = []
    const result = await runCommand('compose', gone, {
      cwd: '/',
      env: {},
      secrets: [],
      timeoutMs: 1_000,
      sinks: { out: () => {}, err: (text) => lines.push(text) },
    })
    expect(result.code).toBe(127)
    expect(lines.join('')).toContain('is it installed and on PATH')
  })

  test('spawnManaged throws a plain message, not a stack trace from Bun', () => {
    expect(() =>
      spawnManaged('auth', gone, { cwd: '/', env: {}, secrets: [], sinks: quiet })
    ).toThrow('cannot start auth')
  })

  test('the Docker check says what to do about it', async () => {
    const problem = await dockerEndpointProblem({}, async () => undefined)
    expect(problem).toContain('Docker installed and on PATH')
  })
})

describe('force-killing a process that ignored SIGTERM', () => {
  const stubborn = [
    process.execPath,
    '-e',
    "process.on('SIGTERM', () => {}); console.log('ready'); await Bun.sleep(30000)",
  ]

  test('runCommand ends it on the force signal, long before its timeout', async () => {
    const stop = new AbortController()
    const force = new AbortController()
    const started = Date.now()
    const lines: string[] = []
    const running = runCommand('step', stubborn, {
      cwd: '/',
      env: {},
      secrets: [],
      timeoutMs: 60_000,
      signal: stop.signal,
      force: force.signal,
      sinks: { out: (text) => lines.push(text), err: () => {} },
    })
    while (!lines.join('').includes('ready') && Date.now() - started < 10_000) {
      await Bun.sleep(20)
    }
    stop.abort()
    await Bun.sleep(300)
    expect(Date.now() - started).toBeLessThan(10_000)
    force.abort()
    const result = await running
    expect(result.code).not.toBe(0)
    expect(Date.now() - started).toBeLessThan(15_000)
  })

  test('captureCommand does the same', async () => {
    const stop = new AbortController()
    const force = new AbortController()
    const started = Date.now()
    setTimeout(() => stop.abort(), 400)
    setTimeout(() => force.abort(), 900)
    const out = await captureCommand(stubborn, {
      cwd: '/',
      env: {},
      timeoutMs: 60_000,
      signal: stop.signal,
      force: force.signal,
    })
    expect(out).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(15_000)
  })
})

describe('acquireStartLock', () => {
  const file = () => join(mkdtempSync(join(tmpdir(), 'closeline-lock-')), 'dev.lock')

  test('a second holder is refused while the first lives, and may take it once released', () => {
    const path = file()
    const first = acquireStartLock(path)
    expect(first.held).toBe(false)
    expect(acquireStartLock(path)).toEqual({ held: true, pid: process.pid, path })
    if (!first.held) {
      first.release()
    }
    const again = acquireStartLock(path)
    expect(again.held).toBe(false)
    if (!again.held) {
      again.release()
    }
  })

  test('a lock left by a dead process is taken over', () => {
    const path = file()
    writeFileSync(path, '2147483646 Thu Jan  1 00:00:00 1970')
    const taken = acquireStartLock(path)
    expect(taken.held).toBe(false)
    if (!taken.held) {
      taken.release()
    }
  })

  test('an empty lock (a holder between create and write) is busy, never taken over', () => {
    const path = file()
    writeFileSync(path, '')
    const result = acquireStartLock(path)
    expect(result.held).toBe(true)
    if (result.held) {
      expect(result.pid).toBeUndefined()
      expect(result.path).toBe(path)
    }
    expect(readFileSync(path, 'utf8')).toBe('')
  })

  test('two takers that saw the same dead pid end with exactly one holder', () => {
    const path = file()
    writeFileSync(path, '2147483646 Thu Jan  1 00:00:00 1970')
    let second: ReturnType<typeof acquireStartLock> | undefined
    const first = acquireStartLock(path, {
      beforeTakeover: () => {
        // The other taker runs to completion between this one's read and its takeover.
        if (second === undefined) {
          second = acquireStartLock(path)
        }
      },
    })
    expect(second?.held).toBe(false)
    expect(first.held).toBe(true)
    if (first.held) {
      expect(first.pid).toBe(process.pid)
    }
    expect(readFileSync(path, 'utf8')).toStartWith(`${process.pid} `)
  })

  test('a live pid with a different start time is a reused pid, not the stack', () => {
    const path = file()
    writeFileSync(path, `${process.pid} Thu Jan  1 00:00:00 1970`)
    const taken = acquireStartLock(path)
    expect(taken.held).toBe(false)
    if (!taken.held) {
      taken.release()
    }
  })
})

describe('stopLockHolder', () => {
  const file = () => join(mkdtempSync(join(tmpdir(), 'closeline-holder-')), 'dev.lock')
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  /** A fake supervisor holding `path`: on SIGTERM it releases the lock and exits, or ignores it. */
  async function holder(path: string, ignoreTerm: boolean) {
    const code = ignoreTerm
      ? `process.on('SIGTERM', () => {}); console.log('up'); setInterval(() => {}, 1000)`
      : `import { unlinkSync } from 'node:fs'
         process.on('SIGTERM', () => { unlinkSync(${JSON.stringify(path)}); process.exit(0) })
         console.log('up'); setInterval(() => {}, 1000)`
    const child = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'ignore'] })
    await new Promise<void>((resolve) => child.stdout.once('data', () => resolve()))
    const pid = child.pid ?? 0
    writeFileSync(path, `${pid} ${processStart(pid)}`)
    return { pid, child }
  }

  test('no lock: nothing to stop', async () => {
    expect(await stopLockHolder(file())).toEqual({ kind: 'none' })
  })

  test('a lock of a dead process is removed', async () => {
    const path = file()
    writeFileSync(path, '999999 Mon Jan  1 00:00:00 2001')
    expect(await stopLockHolder(path)).toEqual({ kind: 'stale' })
    expect(existsSync(path)).toBe(false)
  })

  test('a live pid with another start time (pid reuse) is stale and not signalled', async () => {
    const path = file()
    writeFileSync(path, `${process.pid} Mon Jan  1 00:00:00 2001`)
    expect(await stopLockHolder(path)).toEqual({ kind: 'stale' })
    expect(existsSync(path)).toBe(false)
  })

  test('a live holder gets SIGTERM, releases the lock and exits', async () => {
    const path = file()
    const { pid, child } = await holder(path, false)
    try {
      expect(await stopLockHolder(path, { graceMs: 5000, pollMs: 20 })).toEqual({
        kind: 'stopped',
        pid,
      })
      expect(existsSync(path)).toBe(false)
    } finally {
      child.kill('SIGKILL')
    }
  }, 15_000)

  test('a holder that ignores SIGTERM is killed after the grace period and the lock removed', async () => {
    const path = file()
    const { pid, child } = await holder(path, true)
    try {
      expect(await stopLockHolder(path, { graceMs: 300, pollMs: 20 })).toEqual({
        kind: 'killed',
        pid,
      })
      expect(alive(pid)).toBe(false)
      expect(existsSync(path)).toBe(false)
    } finally {
      child.kill('SIGKILL')
    }
  }, 15_000)

  test('a snapshotted descendant whose pid now belongs to another process survives the kill', async () => {
    const path = file()
    const { pid, child } = await holder(path, true)
    const bystander = spawn('sleep', ['30'], { stdio: 'ignore' })
    try {
      const outcome = await stopLockHolder(path, {
        graceMs: 200,
        pollMs: 20,
        // pretend the bystander's pid was in the tree, recorded with a different start time
        onSnapshot: (entries) => {
          entries.push({ pid: bystander.pid ?? 0, start: 'Mon Jan 1 00:00:00 2001' })
        },
      })
      expect(outcome.kind).toBe('killed')
      expect(alive(pid)).toBe(false)
      expect(alive(bystander.pid ?? 0)).toBe(true)
    } finally {
      child.kill('SIGKILL')
      bystander.kill('SIGKILL')
    }
  }, 15_000)

  test('a stale lock replaced by a live one before removal is put back', async () => {
    const path = file()
    writeFileSync(path, '999999 Mon Jan  1 00:00:00 2001')
    const fresh = `${process.pid} ${processStart(process.pid)}`
    const outcome = await stopLockHolder(path, {
      beforeRemove: () => writeFileSync(path, fresh),
    })
    expect(outcome).toEqual({ kind: 'stale' })
    expect(readFileSync(path, 'utf8')).toBe(fresh)
  })

  test('a ps that fails means it cannot stop safely, and nothing is signalled', async () => {
    const path = file()
    const { pid, child } = await holder(path, false)
    try {
      const outcome = await stopLockHolder(path, { graceMs: 200, psBin: 'false' })
      expect(outcome.kind).toBe('failed')
      expect(alive(pid)).toBe(true)
      expect(existsSync(path)).toBe(true)
    } finally {
      child.kill('SIGKILL')
    }
  })

  test('a holder with an unknown start time is not signalled', async () => {
    const path = file()
    const { pid, child } = await holder(path, false)
    writeFileSync(path, `${pid} unknown`)
    try {
      const outcome = await stopLockHolder(path, { graceMs: 200 })
      expect(outcome.kind).toBe('failed')
      expect(alive(pid)).toBe(true)
    } finally {
      child.kill('SIGKILL')
    }
  })

  test('an unreadable lock is reported and left alone', async () => {
    const path = file()
    writeFileSync(path, '')
    expect((await stopLockHolder(path)).kind).toBe('failed')
    expect(existsSync(path)).toBe(true)
  })
})

describe('processStart', () => {
  test('is the same under two time zones and locales', () => {
    const before = { tz: process.env.TZ, lc: process.env.LC_ALL }
    try {
      process.env.TZ = 'Pacific/Auckland'
      process.env.LC_ALL = 'de_DE.UTF-8'
      const a = processStart(process.pid)
      process.env.TZ = 'America/Los_Angeles'
      process.env.LC_ALL = 'ja_JP.UTF-8'
      const b = processStart(process.pid)
      expect(a).toBeDefined()
      expect(a).toBe(b)
    } finally {
      for (const [key, value] of [
        ['TZ', before.tz],
        ['LC_ALL', before.lc],
      ] as const) {
        if (value === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = value
        }
      }
    }
  })
})

describe('Sign in with Google in the dev stack', () => {
  const secrets = generateSecrets()
  const build = (parent: Record<string, string | undefined> = {}, ports = DEFAULT_PORTS) =>
    buildStackEnv({ parent, ports, secrets, dbDir: '/db' })
  const CALLBACK = 'http://127.0.0.1:3002/v1/client/google/callback'
  const real = {
    GOOGLE_CLIENT_ID: 'real-id.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'real-secret-value',
    GOOGLE_REDIRECT_URI: CALLBACK,
  }

  test('the fake provider has its own port, free of the stack and movable', () => {
    expect(DEFAULT_PORTS.fakeGoogle).toBe(3010)
    expect(resolvePorts({ CLOSELINE_DEV_FAKE_GOOGLE_PORT: '3011' }).fakeGoogle).toBe(3011)
    expect(() => resolvePorts({ CLOSELINE_DEV_FAKE_GOOGLE_PORT: '3001' })).toThrow('both 3001')
  })

  test('with no Google settings in the shell, auth talks to the fake and the portal trusts its host', () => {
    const env = build()
    expect(env.auth.GOOGLE_CLIENT_ID).toBe(FAKE_GOOGLE_CLIENT_ID)
    expect(env.auth.GOOGLE_CLIENT_SECRET).toBe(FAKE_GOOGLE_CLIENT_SECRET)
    expect(env.auth.GOOGLE_REDIRECT_URI).toBe(CALLBACK)
    expect(env.auth.GOOGLE_ISSUER_URL).toBe('http://127.0.0.1:3010')
    expect(env.portal.VITE_GOOGLE_FAKE_ISSUER_HOST).toBe('127.0.0.1:3010')
    expect(env.fakeGoogle).toEqual({
      ...baseChildEnv({}),
      FAKE_GOOGLE_PORT: '3010',
      FAKE_GOOGLE_CLIENT_ID: FAKE_GOOGLE_CLIENT_ID,
      FAKE_GOOGLE_CLIENT_SECRET: FAKE_GOOGLE_CLIENT_SECRET,
      FAKE_GOOGLE_REDIRECT_URI: CALLBACK,
      FAKE_GOOGLE_MAIL_REDIRECT_URI: 'http://127.0.0.1:3002/mailboxes/connect/callback',
    })
  })

  test('outbound sends Gmail Mailboxes to the fake, and to real Google never', () => {
    const { outbound } = build()
    expect(outbound.GOOGLE_CLIENT_ID).toBe(FAKE_GOOGLE_CLIENT_ID)
    expect(outbound.GOOGLE_CLIENT_SECRET).toBe(FAKE_GOOGLE_CLIENT_SECRET)
    expect(outbound.GOOGLE_AUTH_URL).toBe('http://127.0.0.1:3010/authorize')
    expect(outbound.GOOGLE_TOKEN_URL).toBe('http://127.0.0.1:3010/token')
    expect(outbound.GOOGLE_REVOKE_URL).toBe('http://127.0.0.1:3010/revoke')
    expect(outbound.GMAIL_API_BASE_URL).toBe('http://127.0.0.1:3010')
    expect(outbound.MAIL_OAUTH_REDIRECT_URI).toBe(
      'http://127.0.0.1:3002/mailboxes/connect/callback'
    )
    const realEnv = build(real).outbound
    expect(Object.keys(realEnv).filter((key) => /^(GOOGLE|GMAIL|MAIL_OAUTH)/.test(key))).toEqual([])
  })

  test('the fake and the redirect URI follow moved ports', () => {
    const env = build(
      {},
      resolvePorts({
        CLOSELINE_DEV_FAKE_GOOGLE_PORT: '4410',
        CLOSELINE_DEV_PORTAL_PORT: '4402',
      })
    )
    expect(env.auth.GOOGLE_REDIRECT_URI).toBe('http://127.0.0.1:4402/v1/client/google/callback')
    expect(env.auth.GOOGLE_ISSUER_URL).toBe('http://127.0.0.1:4410')
    expect(env.portal.VITE_GOOGLE_FAKE_ISSUER_HOST).toBe('127.0.0.1:4410')
    expect(env.fakeGoogle?.FAKE_GOOGLE_REDIRECT_URI).toBe(env.auth.GOOGLE_REDIRECT_URI)
  })

  test('empty Google variables count as unset', () => {
    const env = build({ GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', GOOGLE_REDIRECT_URI: '' })
    expect(env.auth.GOOGLE_ISSUER_URL).toBe('http://127.0.0.1:3010')
  })

  test('real Google settings pass through with no fake and no issuer override', () => {
    const env = build(real)
    expect(env.auth.GOOGLE_CLIENT_ID).toBe(real.GOOGLE_CLIENT_ID)
    expect(env.auth.GOOGLE_CLIENT_SECRET).toBe(real.GOOGLE_CLIENT_SECRET)
    expect(env.auth.GOOGLE_REDIRECT_URI).toBe(CALLBACK)
    expect(env.auth.GOOGLE_ISSUER_URL).toBeUndefined()
    expect(env.portal.VITE_GOOGLE_FAKE_ISSUER_HOST).toBeUndefined()
    expect(env.fakeGoogle).toBeUndefined()
  })

  test('a GOOGLE_ISSUER_URL in the shell never reaches auth, with real settings or without', () => {
    expect(build({ ...real, GOOGLE_ISSUER_URL: 'http://evil.test' }).auth.GOOGLE_ISSUER_URL).toBe(
      undefined
    )
    expect(build({ GOOGLE_ISSUER_URL: 'http://evil.test' }).auth.GOOGLE_ISSUER_URL).toBe(
      'http://127.0.0.1:3010'
    )
  })

  test.each([['GOOGLE_CLIENT_ID'], ['GOOGLE_CLIENT_SECRET'], ['GOOGLE_REDIRECT_URI']])(
    'real settings missing %s are refused, naming the variable and not the secret',
    (missing) => {
      const half = { ...real, [missing]: undefined }
      let message = ''
      try {
        build(half)
      } catch (error) {
        message = error instanceof Error ? error.message : ''
      }
      expect(message).toContain(missing)
      expect(message).not.toContain(real.GOOGLE_CLIENT_SECRET)
    }
  )

  test('a redirect URI that is not on the portal origin or the tunnel is refused', () => {
    expect(() =>
      build({
        ...real,
        GOOGLE_REDIRECT_URI: 'https://elsewhere.example.com/v1/client/google/callback',
      })
    ).toThrow('GOOGLE_REDIRECT_URI')
    expect(() => build({ ...real, GOOGLE_REDIRECT_URI: 'not a url' })).toThrow(
      'GOOGLE_REDIRECT_URI'
    )
  })

  test('with a tunnel, real Google may redirect to the tunnel or to the portal', () => {
    const tunnel = 'https://quiet-fox-1.trycloudflare.com'
    const onTunnel = `${tunnel}/v1/client/google/callback`
    expect(
      build({ ...real, CLOSELINE_DEV_PUBLIC_ORIGIN: tunnel, GOOGLE_REDIRECT_URI: onTunnel }).auth
        .GOOGLE_REDIRECT_URI
    ).toBe(onTunnel)
    expect(build({ ...real, CLOSELINE_DEV_PUBLIC_ORIGIN: tunnel }).auth.GOOGLE_REDIRECT_URI).toBe(
      CALLBACK
    )
    // The tunnel origin is only allowed when a tunnel is set.
    expect(() => build({ ...real, GOOGLE_REDIRECT_URI: onTunnel })).toThrow('GOOGLE_REDIRECT_URI')
  })

  test('with the fake and a tunnel, the redirect stays on the loopback portal (local browser only)', () => {
    const env = build({ CLOSELINE_DEV_PUBLIC_ORIGIN: 'https://quiet-fox-1.trycloudflare.com' })
    expect(env.auth.GOOGLE_REDIRECT_URI).toBe(CALLBACK)
    expect(env.auth.GOOGLE_ISSUER_URL).toBe('http://127.0.0.1:3010')
  })

  test('the fake is the first service, runs from the hub and only when asked for', () => {
    expect(serviceDefinitions('/bin/bun', DEFAULT_PORTS).map((d) => d.name)).toEqual([
      'core',
      'auth',
      'playbook',
      'voice',
      'outbound',
      'portal',
    ])
    const [fake, ...rest] = serviceDefinitions('/bin/bun', DEFAULT_PORTS, true)
    expect(fake?.name).toBe('fake-google')
    expect(fake?.sibling).toBeUndefined()
    expect(fake?.cmd).toEqual(['/bin/bun', '--no-env-file', 'scripts/dev-fake-google.ts'])
    expect(fake?.env).toBe('fakeGoogle')
    expect(fake?.readyUrl).toBe('http://127.0.0.1:3010/readyz')
    expect(rest.map((d) => d.name)).toEqual([
      'core',
      'auth',
      'playbook',
      'voice',
      'outbound',
      'portal',
    ])
  })
})
