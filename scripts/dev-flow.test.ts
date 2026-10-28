import './test-guard.ts'
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type FlowDeps, INTERRUPTED, runDown, runUp } from './dev-flow.ts'
import {
  buildStackEnv,
  captureCommand,
  DEFAULT_PORTS,
  freshSalt,
  generateSecrets,
  LOGIN_ROLES_SQL,
  type ManagedChild,
  runCommand,
  type SuperviseOptions,
  secretValues,
} from './dev-lib.ts'

const secrets = generateSecrets()
const ALL_SECRETS = secretValues(secrets)
const LOCAL_SOCKET = 'unix:///var/run/docker.sock'

type Call = {
  kind: 'run' | 'capture' | 'spawn'
  name: string
  cmd: string[]
  secrets?: readonly string[]
  stdin?: string
  cwd?: string
  env?: Record<string, string>
}

/** A harness with fake run/capture/spawn/supervise that records every call in order. */
function harness(
  options: {
    parentEnv?: Record<string, string | undefined>
    context?: string | undefined
    logins?: string | undefined
    busy?: string[]
    siblingProblems?: string[]
    buildEnv?: FlowDeps['buildEnv']
    runCode?: (name: string, cmd: string[]) => number
    superviseCode?: number
    mailFailure?: string
    /** Compose services that already have a running container. */
    running?: string[]
    secrets?: typeof secrets
    exportSecrets?: FlowDeps['exportSecrets']
    infisical?: boolean
    /** Another live `bun run dev` holds the start-up lock (its pid). */
    lockedBy?: number
    /** What stopping the lock holder reports (default: no stack running). */
    holder?: Awaited<ReturnType<FlowDeps['stopHolder']>>
  } = {}
) {
  const calls: Call[] = []
  const said: string[] = []
  const failed: string[] = []
  const live = new Set<(signal: string) => void>()
  const waited: string[] = []
  const busyAsked: { name: string; port: number }[] = []
  let supervised = false
  let released = 0
  const label = (cmd: string[]) => cmd.slice(0, 3).join(' ')
  const deps: FlowDeps = {
    run: async (name, cmd, opts) => {
      calls.push({ kind: 'run', name, cmd, secrets: opts.secrets, stdin: opts.stdin })
      return { code: options.runCode?.(name, cmd) ?? 0, timedOut: false }
    },
    capture: async (cmd, opts) => {
      calls.push({ kind: 'capture', name: label(cmd), cmd, stdin: opts.stdin })
      if (cmd[1] === 'context') {
        return 'context' in options ? options.context : LOCAL_SOCKET
      }
      if (opts.stdin?.includes('rolcanlogin')) {
        return 'logins' in options
          ? options.logins
          : 'closeline_auth\ncloseline_core\ncloseline_owner\ncloseline_playbook\npostgres\n'
      }
      if (cmd.includes('ps')) {
        const service = cmd.at(-1) ?? ''
        const up =
          service === '-q' ? (options.running?.length ?? 0) > 0 : options.running?.includes(service)
        return up ? 'abc123\n' : ''
      }
      return ''
    },
    spawn: (name, cmd, opts) => {
      calls.push({ kind: 'spawn', name, cmd, secrets: opts.secrets, cwd: opts.cwd, env: opts.env })
      const child: ManagedChild = {
        name,
        alive: () => true,
        kill: () => {},
        exited: new Promise(() => {}),
      }
      return child
    },
    supervise: async (o: SuperviseOptions) => {
      supervised = true
      for (const service of o.services) {
        service.spawn()
      }
      o.banner()
      return options.superviseCode ?? 0
    },
    busy: async (wanted) => {
      busyAsked.push(...wanted)
      return options.busy ?? []
    },
    lock: () =>
      options.lockedBy === undefined
        ? {
            held: false,
            release: () => {
              released++
            },
          }
        : {
            held: true,
            pid: Number.isNaN(options.lockedBy) ? undefined : options.lockedBy,
            path: '/tmp/x.lock',
          },
    stopHolder: async () => options.holder ?? { kind: 'none' },
    siblingProblems: () => options.siblingProblems ?? [],
    buildEnv: options.buildEnv ?? buildStackEnv,
    secrets: options.secrets ?? secrets,
    exportSecrets: options.exportSecrets,
    salt: freshSalt,
    subscribe: (onSignal) => {
      live.add(onSignal)
      return () => {
        live.delete(onSignal)
      }
    },
    probe: async () => ({ ok: true }),
    waitReady: async (url) => {
      waited.push(url)
      return options.mailFailure
    },
    say: (line) => said.push(line),
    fail: (line) => failed.push(line),
  }
  const context = {
    hub: '/hub',
    composeFile: '/hub/compose.dev.yaml',
    root: '/clones',
    ports: DEFAULT_PORTS,
    parentEnv: options.parentEnv ?? { PATH: '/usr/bin' },
    execPath: '/bin/bun',
    infisical: options.infisical,
  }
  return {
    calls,
    said,
    failed,
    deps,
    context,
    /** Like the process emitting a signal: every handler that is registered right now gets it. */
    signal: (name = 'SIGINT') => {
      for (const handler of [...live]) {
        handler(name)
      }
    },
    liveHandlers: () => live.size,
    released: () => released,
    waited,
    busyAsked,
    supervised: () => supervised,
  }
}

/** Names a recorded call by the step of the start-up it belongs to. */
function stepName(call: Call): string {
  const text = call.cmd.join(' ')
  const sql = call.stdin ?? ''
  const table: [boolean, string][] = [
    [call.cmd[1] === 'context', 'context'],
    [sql.includes('rolcanlogin'), 'logins'],
    [sql.includes('ALTER ROLE'), 'rotate'],
    [sql.includes('CREATE ROLE'), 'ensure-roles'],
    [text.includes(' up '), 'up'],
    [text.endsWith(' version'), 'version'],
    [text.includes(' ps '), 'ps'],
  ]
  return table.find(([matches]) => matches)?.[1] ?? call.name
}

const composeCalls = (calls: Call[]) => calls.filter((call) => call.cmd[1] === 'compose')
const rotationCalls = (calls: Call[]) => calls.filter((call) => call.stdin?.includes('ALTER ROLE'))

describe('runUp order', () => {
  test('checks Docker, then composes up, lists the login roles, rotates, migrates, then supervises', async () => {
    const h = harness()
    expect(await runUp(h.context, h.deps)).toBe(0)
    const steps = h.calls.map(stepName)
    // One `ps` per compose service (postgres, queue, storage, mail): see the ports tests below.
    expect(steps.slice(0, 12)).toEqual([
      'context',
      'version',
      'ps',
      'ps',
      'ps',
      'ps',
      'up',
      'logins',
      'ensure-roles',
      'rotate',
      'migrate',
      'fake-google',
    ])
    expect(h.supervised()).toBe(true)
  })

  test('starts the fake Google provider first, from the hub, with its own environment, and says so', async () => {
    const h = harness()
    await runUp(h.context, h.deps)
    const spawned = h.calls.filter((call) => call.kind === 'spawn')
    expect(spawned.map((call) => call.name)).toEqual([
      'fake-google',
      'core',
      'auth',
      'playbook',
      'voice',
      'outbound',
      'portal',
    ])
    expect(spawned[0]?.cmd).toEqual([
      h.context.execPath,
      '--no-env-file',
      'scripts/dev-fake-google.ts',
    ])
    expect(spawned[0]?.cwd).toBe('/hub')
    expect(spawned[0]?.env?.FAKE_GOOGLE_PORT).toBe('3010')
    expect(spawned[1]?.cwd).toBe('/clones/tula-closeline-core')
    expect(h.said.some((line) => line.includes('fake Google') && line.includes(':3010'))).toBe(true)
  })

  test('with real Google settings no fake is started or its port checked', async () => {
    const h = harness({
      parentEnv: {
        PATH: '/usr/bin',
        GOOGLE_CLIENT_ID: 'id',
        GOOGLE_CLIENT_SECRET: 'secret-value-xyz',
        GOOGLE_REDIRECT_URI: 'http://127.0.0.1:3002/v1/client/google/callback',
      },
    })
    await runUp(h.context, h.deps)
    expect(h.calls.some((call) => call.name === 'fake-google')).toBe(false)
    expect(h.busyAsked.map((wanted) => wanted.name)).not.toContain('fake Google')
    expect(h.said.some((line) => line.includes('real Google'))).toBe(true)
  })

  test('a half-set real Google configuration stops the start before any command', async () => {
    const h = harness({ parentEnv: { PATH: '/usr/bin', GOOGLE_CLIENT_ID: 'id' } })
    expect(await runUp(h.context, h.deps)).toBe(1)
    expect(h.calls).toEqual([])
    expect(h.failed.join('\n')).toContain('GOOGLE_CLIENT_SECRET')
  })

  test('a busy fake Google port stops the start', async () => {
    const h = harness({ busy: ['port 3010 (fake Google) is already in use'] })
    expect(await runUp(h.context, h.deps)).toBe(1)
    expect(h.busyAsked.map((wanted) => wanted.name)).toContain('fake Google')
  })

  test('starts the playbook after the migration, from the playbook clone, with its own environment', async () => {
    const h = harness()
    await runUp(h.context, h.deps)
    const migrate = h.calls.findIndex((call) => call.name === 'migrate')
    const playbook = h.calls.findIndex((call) => call.kind === 'spawn' && call.name === 'playbook')
    expect(playbook).toBeGreaterThan(migrate)
    expect(h.calls[playbook]?.cmd).toEqual([h.context.execPath, '--no-env-file', 'src/server.ts'])
    expect(h.said.some((line) => line.includes('127.0.0.1:3003'))).toBe(true)
  })

  test('starts voice after the migration, from the voice clone, with its own environment', async () => {
    const h = harness()
    await runUp(h.context, h.deps)
    const migrate = h.calls.findIndex((call) => call.name === 'migrate')
    const voice = h.calls.findIndex((call) => call.kind === 'spawn' && call.name === 'voice')
    expect(voice).toBeGreaterThan(migrate)
    expect(h.calls[voice]?.cwd).toBe('/clones/tula-closeline-voice')
    expect(h.calls[voice]?.cmd).toEqual([h.context.execPath, '--no-env-file', 'src/server.ts'])
    expect(h.calls[voice]?.env?.PORT).toBe('3004')
    expect(h.calls[voice]?.env?.TELEPHONY_PROVIDER).toBe('memory')
    expect(h.said.some((line) => line.includes('127.0.0.1:3004'))).toBe(true)
  })

  test('starts outbound from its clone with its own port and the shared local settings', async () => {
    const h = harness()
    await runUp(h.context, h.deps)
    const outbound = h.calls.find((call) => call.kind === 'spawn' && call.name === 'outbound')
    expect(outbound?.cwd).toBe('/clones/tula-closeline-outbound')
    expect(outbound?.cmd).toEqual([h.context.execPath, '--no-env-file', 'src/server.ts'])
    expect(outbound?.env?.PORT).toBe('3005')
    expect(outbound?.env?.ENVIRONMENT).toBe('local')
  })

  test('a busy voice port stops the start', async () => {
    const h = harness({ busy: ['port 3004 (voice) is already in use'] })
    expect(await runUp(h.context, h.deps)).toBe(1)
    expect(h.busyAsked.map((wanted) => wanted.name)).toContain('voice')
  })

  test('the login-role query asks for rolcanlogin before any rotation SQL is sent', async () => {
    const h = harness()
    await runUp(h.context, h.deps)
    const query = h.calls.findIndex((call) => call.stdin?.includes(LOGIN_ROLES_SQL))
    const rotate = h.calls.findIndex((call) => call.stdin?.includes('ALTER ROLE'))
    expect(query).toBeGreaterThan(-1)
    expect(rotate).toBeGreaterThan(query)
  })

  test('missing roles are created before the rotation, so a new login role can be given a password', async () => {
    const h = harness()
    await runUp(h.context, h.deps)
    const ensure = h.calls.findIndex((call) =>
      call.stdin?.includes('CREATE ROLE closeline_outbound')
    )
    const rotate = h.calls.findIndex((call) => call.stdin?.includes('ALTER ROLE'))
    expect(ensure).toBeGreaterThan(-1)
    expect(rotate).toBeGreaterThan(ensure)
  })

  test('a failed login-role query returns 1 and no rotation SQL is sent, no migration, no service', async () => {
    const h = harness({ logins: undefined })
    expect(await runUp(h.context, h.deps)).toBe(1)
    expect(rotationCalls(h.calls)).toHaveLength(0)
    expect(h.calls.some((call) => call.name === 'migrate')).toBe(false)
    expect(h.supervised()).toBe(false)
  })

  test('a login role outside the rotation set returns 1 and no rotation SQL is sent', async () => {
    const h = harness({ logins: 'closeline_auth\ncloseline_billing\npostgres\n' })
    expect(await runUp(h.context, h.deps)).toBe(1)
    expect(h.failed.join('\n')).toContain('closeline_billing')
    expect(rotationCalls(h.calls)).toHaveLength(0)
    expect(h.supervised()).toBe(false)
  })

  test.each([
    ['compose up', 'up', ['logins', 'ensure-roles', 'rotate', 'migrate']],
    ['the role check', 'ensure-roles', ['rotate', 'migrate']],
    ['the rotation', 'rotate', ['migrate']],
    ['the migration', 'migrate', []],
  ])(
    'a failed %s returns 1, runs none of the later steps and starts no service',
    async (_label, failing, later) => {
      const h = harness({
        runCode: (name, cmd) => (stepName({ kind: 'run', name, cmd } as Call) === failing ? 1 : 0),
      })
      // The rotation call carries its SQL on stdin, which runCode cannot see: match it by command.
      const original = h.deps.run
      h.deps.run = (name, cmd, opts) =>
        (failing === 'rotate' && opts.stdin?.includes('ALTER ROLE')) ||
        (failing === 'ensure-roles' && opts.stdin?.includes('CREATE ROLE'))
          ? Promise.resolve({ code: 1, timedOut: false })
          : original(name, cmd, opts)
      expect(await runUp(h.context, h.deps)).toBe(1)
      const seen = h.calls.map(stepName)
      for (const step of later) {
        expect(seen).not.toContain(step)
      }
      expect(h.supervised()).toBe(false)
      expect(h.failed).toHaveLength(1)
    }
  )

  test('port clashes and missing clones stop the run before the first compose command', async () => {
    for (const options of [
      { busy: ['port 3001 (auth) is already in use'] },
      { siblingProblems: ['x is missing'] },
    ]) {
      const h = harness(options)
      expect(await runUp(h.context, h.deps)).toBe(1)
      expect(h.calls.some((call) => call.cmd.includes('up'))).toBe(false)
    }
  })

  test('two runs send different salts for the same passwords', async () => {
    const first = harness()
    const second = harness()
    await runUp(first.context, first.deps)
    await runUp(second.context, second.deps)
    const sql = (h: ReturnType<typeof harness>) => rotationCalls(h.calls)[0]?.stdin
    expect(sql(first)).toBeDefined()
    expect(sql(first)).not.toBe(sql(second))
    expect(freshSalt().equals(freshSalt())).toBe(false)
    expect(freshSalt()).toHaveLength(16)
  })
})

describe('guards run before the first Docker or database command', () => {
  test('a non-loopback database address returns 1 with no command spawned', async () => {
    const h = harness({
      buildEnv: (o) => {
        const env = buildStackEnv(o)
        return {
          ...env,
          migrate: { ...env.migrate, DATABASE_URL: 'postgres://u:p@db.example.com:5432/closeline' },
        }
      },
    })
    expect(await runUp(h.context, h.deps)).toBe(1)
    expect(h.calls).toEqual([])
    expect(h.failed.join('\n')).toContain('loopback')
  })

  test('a remote Docker context returns 1 and no docker compose command is spawned', async () => {
    const h = harness({ context: 'tcp://build.example.com:2376' })
    expect(await runUp(h.context, h.deps)).toBe(1)
    expect(composeCalls(h.calls)).toHaveLength(0)
    expect(h.failed.join('\n')).toContain('not a local unix socket')
  })

  test('DOCKER_HOST=tcp://x returns 1 before any command at all', async () => {
    const h = harness({ parentEnv: { DOCKER_HOST: 'tcp://x:2375' } })
    expect(await runUp(h.context, h.deps)).toBe(1)
    expect(h.calls).toEqual([])
  })

  test('an unreadable Docker context is refused, not assumed local', async () => {
    const h = harness({ context: undefined })
    expect(await runUp(h.context, h.deps)).toBe(1)
    expect(composeCalls(h.calls)).toHaveLength(0)
  })
})

describe('runDown', () => {
  for (const volumes of [false, true]) {
    const flag = volumes ? '--down --volumes' : '--down'

    test(`${flag} with a remote Docker context is refused and spawns no docker compose command`, async () => {
      const h = harness({ context: 'ssh://me@remote-box' })
      expect(await runDown(h.context, h.deps, volumes)).toBe(1)
      expect(composeCalls(h.calls)).toHaveLength(0)
      expect(h.calls.every((call) => call.cmd[1] === 'context')).toBe(true)
    })

    test(`${flag} with DOCKER_HOST=tcp://x is refused with no command`, async () => {
      const h = harness({ parentEnv: { DOCKER_HOST: 'tcp://x:2375' } })
      expect(await runDown(h.context, h.deps, volumes)).toBe(1)
      expect(h.calls).toEqual([])
    })

    test(`${flag} on a local socket checks the endpoint first, then downs only closeline-dev`, async () => {
      const h = harness()
      expect(await runDown(h.context, h.deps, volumes)).toBe(0)
      expect(h.calls[0]?.cmd[1]).toBe('context')
      const down = h.calls.find((call) => call.cmd.includes('down'))
      expect(down?.cmd[down.cmd.indexOf('-p') + 1]).toBe('closeline-dev')
      expect(down?.cmd.includes('--volumes')).toBe(volumes)
    })
  }
})

describe('runDown does not depend on the Google settings', () => {
  test('a half-set GOOGLE_* still runs compose down', async () => {
    const h = harness({ parentEnv: { PATH: '/usr/bin', GOOGLE_CLIENT_ID: 'id' } })
    expect(await runDown(h.context, h.deps, false)).toBe(0)
    expect(h.calls.some((call) => call.cmd.includes('down'))).toBe(true)
    expect(h.failed).toEqual([])
  })
})

describe('runDown and a running stack', () => {
  test('stops the holder first, then compose', async () => {
    const h = harness({ holder: { kind: 'stopped', pid: 42 } })
    expect(await runDown(h.context, h.deps, false)).toBe(0)
    expect(h.said.join('\n')).toMatch(/stopped the running stack \(pid 42\)/)
    expect(h.calls.some((call) => call.cmd.includes('down'))).toBe(true)
  })

  test('a holder that cannot be stopped fails and leaves compose alone', async () => {
    const h = harness({ holder: { kind: 'failed', reason: 'pid 42 did not die' } })
    expect(await runDown(h.context, h.deps, false)).toBe(1)
    expect(h.failed).toEqual(['pid 42 did not die'])
    expect(h.calls).toEqual([])
  })

  test('holds the start lock while compose goes down, and releases it', async () => {
    const h = harness()
    expect(await runDown(h.context, h.deps, false)).toBe(0)
    expect(h.released()).toBe(1)
  })

  test('refuses when a start holds the lock, and runs no compose command', async () => {
    const h = harness({ lockedBy: 7 })
    expect(await runDown(h.context, h.deps, false)).toBe(1)
    expect(h.failed.join('\n')).toMatch(/start/)
    expect(h.calls).toEqual([])
  })

  for (const kind of ['none', 'stale'] as const) {
    test(`${kind} lock still downs compose`, async () => {
      const h = harness({ holder: { kind } })
      expect(await runDown(h.context, h.deps, true)).toBe(0)
      expect(h.calls.find((call) => call.cmd.includes('--volumes'))).toBeDefined()
    })
  }
})

describe('redaction reaches every step', () => {
  test('compose up, the rotation, the role check, the migration and every service get the whole secret list', async () => {
    const h = harness()
    await runUp(h.context, h.deps)
    const steps = h.calls.filter((call) => call.kind !== 'capture')
    const names = steps.map((call) => call.name)
    expect(names).toEqual([
      'compose',
      'compose',
      'compose',
      'migrate',
      'fake-google',
      'core',
      'auth',
      'playbook',
      'voice',
      'outbound',
      'portal',
    ])
    for (const call of steps) {
      expect(call.secrets).toHaveLength(ALL_SECRETS.length)
      expect([...(call.secrets ?? [])].sort()).toEqual([...ALL_SECRETS].sort())
    }
    expect(ALL_SECRETS.length).toBeGreaterThanOrEqual(7)
  })
})

describe('a real Google client secret', () => {
  test('is scrubbed from the output of every service, and the fake secret is not treated as one', async () => {
    const real = 'real-client-secret-0123456789'
    const h = harness({
      parentEnv: {
        PATH: '/usr/bin',
        GOOGLE_CLIENT_ID: 'id',
        GOOGLE_CLIENT_SECRET: real,
        GOOGLE_REDIRECT_URI: 'http://127.0.0.1:3002/v1/client/google/callback',
      },
    })
    await runUp(h.context, h.deps)
    const services = h.calls.filter((call) => call.kind === 'spawn')
    expect(services.length).toBe(6)
    for (const call of services) {
      expect(call.secrets).toContain(real)
    }
  })
})

describe('signals during start-up', () => {
  for (const step of ['compose up', 'rotation', 'migrate']) {
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      test(`${signal} during ${step} stops that subprocess, exits non-zero and starts no service`, async () => {
        let seen = 0
        const h = harness()
        // Block the first compose call for "compose up", the second (psql) for "rotation".
        const original = h.deps.run
        h.deps.run = async (name, cmd, opts) => {
          const isUp = cmd.includes('up')
          const isRotation = opts.stdin?.includes('ALTER ROLE') === true
          const block =
            (step === 'compose up' && isUp) ||
            (step === 'rotation' && isRotation) ||
            (step === 'migrate' && name === 'migrate')
          if (!block) {
            return original(name, cmd, { ...opts, signal: undefined })
          }
          seen++
          await new Promise<void>((resolve) => {
            setTimeout(() => h.signal(signal), 5)
            opts.signal?.addEventListener('abort', () => resolve(), { once: true })
          })
          return { code: 143, timedOut: false }
        }
        const code = await runUp(h.context, h.deps)
        expect(seen).toBe(1)
        expect(code).toBe(INTERRUPTED)
        expect(INTERRUPTED).toBe(130)
        expect(h.liveHandlers()).toBe(0)
        expect(h.failed).toEqual([])
        expect(h.supervised()).toBe(false)
        expect(h.calls.some((call) => call.kind === 'spawn')).toBe(false)
        if (step !== 'migrate') {
          expect(h.calls.some((call) => call.name === 'migrate')).toBe(false)
        }
      })
    }
  }

  test('a signal that arrives between steps stops before the next one', async () => {
    const h = harness()
    const original = h.deps.run
    h.deps.run = async (name, cmd, opts) => {
      const result = await original(name, cmd, opts)
      if (cmd.includes('up')) {
        h.signal('SIGTERM')
      }
      return result
    }
    expect(await runUp(h.context, h.deps)).toBe(INTERRUPTED)
    expect(h.liveHandlers()).toBe(0)
    expect(rotationCalls(h.calls)).toHaveLength(0)
    expect(h.supervised()).toBe(false)
  })

  test('once the services run, a signal goes to the supervisor and exits 0', async () => {
    const h = harness()
    h.deps.supervise = async (o: SuperviseOptions) => {
      const off = o.subscribe((signal) => {
        h.said.push(`got ${signal}`)
      })
      expect(h.liveHandlers()).toBe(1)
      h.signal('SIGHUP')
      off()
      return 0
    }
    expect(await runUp(h.context, h.deps)).toBe(0)
    expect(h.said).toContain('got SIGHUP')
    expect(h.liveHandlers()).toBe(0)
  })
})

describe('abort signal on real subprocesses', () => {
  test('runCommand and captureCommand kill their process when the signal aborts', async () => {
    const sleep = [process.execPath, '-e', 'await Bun.sleep(30000)']
    const started = Date.now()
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 100)
    const result = await runCommand('slow', sleep, {
      cwd: '/',
      env: {},
      secrets: [],
      timeoutMs: 20_000,
      signal: controller.signal,
      sinks: { out: () => {}, err: () => {} },
    })
    expect(result.code).not.toBe(0)
    const second = new AbortController()
    setTimeout(() => second.abort(), 100)
    expect(
      await captureCommand(sleep, { cwd: '/', env: {}, timeoutMs: 20_000, signal: second.signal })
    ).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  test('an already aborted signal never lets the process run', async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await runCommand('slow', [process.execPath, '-e', 'await Bun.sleep(30000)'], {
      cwd: '/',
      env: {},
      secrets: [],
      timeoutMs: 20_000,
      signal: controller.signal,
      sinks: { out: () => {}, err: () => {} },
    })
    expect(result.code).not.toBe(0)
  })
})

describe('package scripts', () => {
  const scripts = (
    JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
  ).scripts

  test('dev and dev:smoke load no .env file', () => {
    expect(scripts.dev).toContain('--no-env-file')
    expect(scripts['dev:smoke']).toContain('--no-env-file')
  })
})

describe('signals during start-up: a second one kills, none misleads', () => {
  /** A fake run that ignores the first signal, like a process that traps SIGTERM. */
  function stubborn(h: ReturnType<typeof harness>) {
    const original = h.deps.run
    const seen = { term: 0, kill: 0 }
    h.deps.run = async (name, cmd, opts) => {
      if (!cmd.includes('up')) {
        return original(name, cmd, opts)
      }
      opts.signal?.addEventListener('abort', () => seen.term++, { once: true })
      return new Promise((resolve) => {
        opts.force?.addEventListener(
          'abort',
          () => {
            seen.kill++
            resolve({ code: 137, timedOut: false })
          },
          { once: true }
        )
        setTimeout(() => resolve({ code: 0, timedOut: false }), 5_000)
      })
    }
    return seen
  }

  test('one signal asks politely and a second kills a step that ignored the first', async () => {
    const h = harness()
    const seen = stubborn(h)
    const started = Date.now()
    const result = runUp(h.context, h.deps)
    await Bun.sleep(20)
    h.signal('SIGTERM')
    await Bun.sleep(40)
    expect(seen).toEqual({ term: 1, kill: 0 })
    h.signal('SIGTERM')
    expect(await result).toBe(INTERRUPTED)
    expect(seen.kill).toBe(1)
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(h.said.join('\n')).toContain('again: killing')
    expect(h.liveHandlers()).toBe(0)
    expect(h.supervised()).toBe(false)
  })

  test('a third signal does nothing more', async () => {
    const h = harness()
    const seen = stubborn(h)
    const result = runUp(h.context, h.deps)
    await Bun.sleep(20)
    h.signal('SIGINT')
    h.signal('SIGINT')
    h.signal('SIGINT')
    expect(await result).toBe(INTERRUPTED)
    expect(seen).toEqual({ term: 1, kill: 1 })
    expect(h.said.filter((line) => line.includes('killing'))).toHaveLength(1)
  })

  test.each([
    ['docker context inspect', (cmd: string[]) => cmd[1] === 'context'],
    ['docker compose version', (cmd: string[]) => cmd.at(-1) === 'version'],
  ])(
    'a signal during %s prints no complaint about Docker and exits 130',
    async (_label, during) => {
      const h = harness()
      const original = h.deps.capture
      h.deps.capture = async (cmd, opts) => {
        if (during(cmd)) {
          h.signal('SIGINT')
          return undefined
        }
        return original(cmd, opts)
      }
      expect(await runUp(h.context, h.deps)).toBe(INTERRUPTED)
      expect(h.failed).toEqual([])
      expect(h.calls.some((call) => call.cmd.includes('up'))).toBe(false)
    }
  )

  test('a signal during --down checks prints no complaint and exits 130', async () => {
    const h = harness()
    const original = h.deps.capture
    h.deps.capture = async (cmd, opts) => {
      if (cmd[1] === 'context') {
        h.signal('SIGTERM')
        return undefined
      }
      return original(cmd, opts)
    }
    expect(await runDown(h.context, h.deps, true)).toBe(INTERRUPTED)
    expect(h.failed).toEqual([])
    expect(h.calls.some((call) => call.cmd.includes('down'))).toBe(false)
  })

  test('signals during shutdown go to the supervisor and print no start-up message', async () => {
    const h = harness()
    h.deps.supervise = async (o: SuperviseOptions) => {
      const off = o.subscribe(() => {})
      h.signal('SIGINT')
      off()
      h.signal('SIGINT')
      h.signal('SIGHUP')
      return 0
    }
    expect(await runUp(h.context, h.deps)).toBe(0)
    expect(h.said.join('\n')).not.toMatch(/step in progress|killing/)
    expect(h.liveHandlers()).toBe(0)
  })
})

describe('the mailbox', () => {
  test('is port-checked with the others and waited for before the roles are touched', async () => {
    const h = harness()
    expect(await runUp(h.context, h.deps)).toBe(0)
    expect(h.busyAsked).toContainEqual({ name: 'mailbox', port: 8026 })
    expect(h.waited[0]).toBe('http://127.0.0.1:8026/livez')
  })

  test('a mailbox that never answers stops the start before any role or service', async () => {
    const h = harness({ mailFailure: 'did not answer 2xx' })
    expect(await runUp(h.context, h.deps)).toBe(1)
    expect(h.failed.join('\n')).toContain('mailbox did not answer')
    expect(h.calls.some((call) => call.stdin?.includes('rolcanlogin'))).toBe(false)
    expect(h.supervised()).toBe(false)
  })

  test('its address is printed so a person can read the mail in a browser', async () => {
    const h = harness()
    await runUp(h.context, h.deps)
    expect(h.said.join('\n')).toContain('mailbox http://127.0.0.1:8026')
  })

  test('a moved mailbox port is the one that is checked, waited for and printed', async () => {
    const h = harness()
    h.context.ports = { ...DEFAULT_PORTS, mail: 8099 }
    await runUp(h.context, h.deps)
    expect(h.busyAsked).toContainEqual({ name: 'mailbox', port: 8099 })
    expect(h.waited[0]).toBe('http://127.0.0.1:8099/livez')
    expect(h.said.join('\n')).toContain('http://127.0.0.1:8099')
  })
})

describe('ports of a stack that is partly up', () => {
  const every = ['postgres', 'queue', 'storage', 'mail']

  test('a stack from an older run with no mail container still has the mailbox port checked', async () => {
    const h = harness({
      running: ['postgres', 'queue', 'storage'],
      busy: [
        'port 8026 (mailbox) is already in use; stop what uses it or set its CLOSELINE_DEV_*_PORT',
      ],
    })
    expect(await runUp(h.context, h.deps)).toBe(1)
    expect(h.busyAsked.map((wanted) => wanted.name)).toContain('mailbox')
    expect(h.failed.join('\n')).toContain('port 8026 (mailbox) is already in use')
    expect(h.calls.some((call) => call.cmd.includes('up'))).toBe(false)
  })

  test('only the containers that are not running have their port checked', async () => {
    const h = harness({ running: ['postgres', 'queue', 'storage'] })
    await runUp(h.context, h.deps)
    const asked = h.busyAsked.map((wanted) => wanted.name)
    expect(asked).toContain('mailbox')
    expect(asked).not.toContain('Postgres')
    expect(asked).not.toContain('queue stand-in')
    expect(asked).not.toContain('object storage stand-in')
  })

  test('a stack that is fully up has no compose port checked, only the services and the fake Google', async () => {
    const h = harness({ running: every })
    await runUp(h.context, h.deps)
    expect(h.busyAsked.map((wanted) => wanted.name).sort()).toEqual([
      'auth',
      'core',
      'fake Google',
      'outbound',
      'playbook',
      'portal',
      'voice',
    ])
  })

  test('a clean start checks all four compose ports', async () => {
    const h = harness()
    await runUp(h.context, h.deps)
    const asked = h.busyAsked.map((wanted) => wanted.name)
    for (const name of ['Postgres', 'queue stand-in', 'object storage stand-in', 'mailbox']) {
      expect(asked).toContain(name)
    }
  })
})

describe('a second start while a stack is up (issue 86)', () => {
  test('refuses, naming the running start, and touches neither Docker nor any role password', async () => {
    const h = harness({ lockedBy: 4242, running: ['postgres'] })
    const code = await runUp(h.context, h.deps)
    expect(code).toBe(1)
    expect(h.failed.join('\n')).toContain('already running')
    expect(h.failed.join('\n')).toContain('4242')
    expect(h.failed.join('\n')).toContain('reuse it')
    expect(h.failed.join('\n')).toContain('/tmp/x.lock')
    expect(h.calls.filter((call) => call.kind !== 'capture' || call.cmd[1] === 'compose')).toEqual(
      []
    )
    expect(h.calls.some((call) => call.stdin?.includes('PASSWORD'))).toBe(false)
  })

  test('the lock is released when a start ends', async () => {
    const h = harness()
    await runUp(h.context, h.deps)
    expect(h.released()).toBe(1)
  })

  test('a lock that cannot be taken says so, not "pid 0"', async () => {
    const h = harness({ lockedBy: Number.NaN })
    await runUp(h.context, h.deps)
    expect(h.failed.join('\n')).toContain('could not take the lock')
    expect(h.failed.join('\n')).not.toContain('pid')
  })
})

describe('runUp with Infisical', () => {
  const exporter = (voice: Record<string, string>) => async (folder: string) =>
    JSON.stringify(
      Object.entries(folder === 'voice' ? voice : {}).map(([key, value]) => ({ key, value }))
    )

  test('adds the values to the child, scrubs them, and says which vendors are real', async () => {
    const h = harness({
      infisical: true,
      exportSecrets: exporter({ TWILIO_AUTH_TOKEN: 'tw-secret-zzz', TWILIO_ACCOUNT_SID: '' }),
    })
    expect(await runUp(h.context, h.deps)).toBe(0)
    const voice = h.calls.find((call) => call.name === 'voice')
    expect(voice?.env?.TWILIO_AUTH_TOKEN).toBe('tw-secret-zzz')
    expect(voice?.secrets).toContain('tw-secret-zzz')
    expect(h.said.join('\n')).toContain('real: TWILIO_AUTH_TOKEN (/voice)')
    expect(h.said.join('\n')).not.toContain('tw-secret-zzz')
  })

  test('an export that fails starts the stack as today, with one notice', async () => {
    const h = harness({ infisical: true, exportSecrets: async () => undefined })
    expect(await runUp(h.context, h.deps)).toBe(0)
    expect(h.said.filter((line) => line.includes('Infisical unavailable'))).toHaveLength(1)
    expect(h.calls.some((call) => call.name === 'fake-google')).toBe(true)
  })

  test('without the flag the exporter is never called', async () => {
    let asked = 0
    const h = harness({
      exportSecrets: async () => {
        asked++
        return '[]'
      },
    })
    await runUp(h.context, h.deps)
    expect(asked).toBe(0)
  })

  test('a full Google set from Infisical turns the fake off', async () => {
    const h = harness({
      infisical: true,
      exportSecrets: async (folder) =>
        JSON.stringify(
          folder === 'auth'
            ? [
                { key: 'GOOGLE_CLIENT_ID', value: 'gid' },
                { key: 'GOOGLE_CLIENT_SECRET', value: 'gsecret-qqq' },
                {
                  key: 'GOOGLE_REDIRECT_URI',
                  value: 'http://127.0.0.1:3002/v1/client/google/callback',
                },
              ]
            : []
        ),
    })
    await runUp(h.context, h.deps)
    expect(h.calls.some((call) => call.name === 'fake-google')).toBe(false)
    expect(h.calls.find((call) => call.name === 'auth')?.secrets).toContain('gsecret-qqq')
  })

  test('a half Google set is refused naming the missing key, not a value', async () => {
    const h = harness({
      infisical: true,
      exportSecrets: async (folder) =>
        JSON.stringify(folder === 'auth' ? [{ key: 'GOOGLE_CLIENT_ID', value: 'gid-vvv' }] : []),
    })
    expect(await runUp(h.context, h.deps)).toBe(1)
    expect(h.failed.join('\n')).toContain('GOOGLE_CLIENT_SECRET')
  })

  test('a bad tunnel origin from Infisical is refused without printing the value', async () => {
    const h = harness({
      infisical: true,
      exportSecrets: async (folder) =>
        JSON.stringify(
          folder === 'hub'
            ? [{ key: 'CLOSELINE_DEV_PUBLIC_ORIGIN', value: 'http://leaky.example' }]
            : []
        ),
    })
    expect(await runUp(h.context, h.deps)).toBe(1)
    expect(h.failed.join('\n')).not.toContain('leaky.example')
  })
})

describe('runUp stops while Infisical is being read', () => {
  test('a signal reaches the exporter, which is cut short', async () => {
    let seen: AbortSignal | undefined
    const h = harness({
      infisical: true,
      exportSecrets: (_folder, abort) => {
        seen = abort?.signal
        return new Promise((resolve) =>
          abort?.signal.addEventListener('abort', () => resolve(undefined))
        )
      },
    })
    const run = runUp(h.context, h.deps)
    await Bun.sleep(10)
    h.signal()
    expect(await run).toBe(INTERRUPTED)
    expect(seen?.aborted).toBe(true)
  })
})
