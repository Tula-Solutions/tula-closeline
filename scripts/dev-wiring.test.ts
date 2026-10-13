import { describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createContext, createDeps } from './dev.ts'
import { runDown } from './dev-flow.ts'
import { DEFAULT_PORTS, STOP_SIGNALS, secretValues } from './dev-lib.ts'

const hub = resolve(import.meta.dir, '..')

describe('the real effects wired in dev.ts', () => {
  test('the salt source is the secure one: 16 bytes, different every call', () => {
    const { salt } = createDeps()
    const first = salt()
    expect(first).toHaveLength(16)
    expect(first.equals(Buffer.alloc(16))).toBe(false)
    expect(first.equals(salt())).toBe(false)
  })

  test('secrets are fresh for every run and cover every role and the internal token', () => {
    const a = createDeps().secrets
    const b = createDeps().secrets
    expect(new Set(secretValues(a)).size).toBe(6)
    expect(a.internalToken).not.toBe(b.internalToken)
    expect(a.passwords.closeline_auth).not.toBe(b.passwords.closeline_auth)
    for (const value of secretValues(a)) {
      expect(value).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  test('the signal subscription covers SIGINT, SIGTERM and SIGHUP and removes itself', () => {
    expect([...STOP_SIGNALS]).toEqual(['SIGINT', 'SIGTERM', 'SIGHUP'])
    const before = STOP_SIGNALS.map((signal) => process.listenerCount(signal))
    const off = createDeps().subscribe(() => {})
    expect(STOP_SIGNALS.map((signal) => process.listenerCount(signal))).toEqual(
      before.map((count) => count + 1)
    )
    off()
    expect(STOP_SIGNALS.map((signal) => process.listenerCount(signal))).toEqual(before)
  })

  test('the context carries the environment it was started with, not an empty one', () => {
    const env = { PATH: '/x', DOCKER_HOST: 'unix:///a.sock', CLOSELINE_SIBLINGS_DIR: '/clones' }
    const context = createContext(env, DEFAULT_PORTS)
    expect(context.parentEnv).toBe(env)
    expect(context.root).toBe('/clones')
    expect(context.hub).toBe(hub)
    expect(context.composeFile).toBe(join(hub, 'compose.dev.yaml'))
    expect(createContext({}, DEFAULT_PORTS).root).toBe(dirname(hub))
  })

  test('with DOCKER_HOST=tcp://x the real runDown exits 1 and spawns nothing', async () => {
    const deps = createDeps()
    const spawned: string[][] = []
    const run = deps.run
    const capture = deps.capture
    deps.run = (name, cmd, options) => {
      spawned.push(cmd)
      return run(name, cmd, options)
    }
    deps.capture = (cmd, options) => {
      spawned.push(cmd)
      return capture(cmd, options)
    }
    const quiet: string[] = []
    deps.fail = (line) => quiet.push(line)
    const context = createContext({ PATH: '/usr/bin', DOCKER_HOST: 'tcp://x:2375' }, DEFAULT_PORTS)
    expect(await runDown(context, deps, true)).toBe(1)
    expect(spawned).toEqual([])
    expect(quiet.join('\n')).toContain('not a local unix socket')
  })
})

/** A directory holding a `docker` that logs its arguments and answers `context inspect`. */
function standInDocker() {
  const dir = mkdtempSync(join(tmpdir(), 'closeline-docker-'))
  const log = join(dir, 'calls.log')
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  writeFileSync(
    join(bin, 'docker'),
    `#!/bin/sh\necho "$@" >> "${log}"\nif [ "$1" = context ]; then echo unix:///var/run/docker.sock; fi\nexit 0\n`
  )
  chmodSync(join(bin, 'docker'), 0o755)
  return { bin, log }
}

function runDev(args: string[], env: Record<string, string>) {
  const proc = Bun.spawnSync([process.execPath, '--no-env-file', 'scripts/dev.ts', ...args], {
    cwd: hub,
    env,
    timeout: 30_000,
  })
  return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() }
}

describe('scripts/dev.ts as a program', () => {
  test('--down with DOCKER_HOST=tcp://x exits 1 and runs no docker at all', () => {
    const { bin, log } = standInDocker()
    const result = runDev(['--down'], { PATH: `${bin}:/usr/bin:/bin`, DOCKER_HOST: 'tcp://x:2375' })
    expect(result.code).toBe(1)
    expect(existsSync(log)).toBe(false)
    expect(result.err).toContain('not a local unix socket')
  })

  test('--down --volumes on a local socket checks the context first, then downs closeline-dev only', () => {
    const { bin, log } = standInDocker()
    const result = runDev(['--down', '--volumes'], { PATH: `${bin}:/usr/bin:/bin` })
    expect(result.code).toBe(0)
    const calls = readFileSync(log, 'utf8').trim().split('\n')
    expect(calls[0]).toStartWith('context inspect')
    const down = calls.find((call) => call.includes(' down '))
    expect(down).toContain('-p closeline-dev')
    expect(down).toContain('--volumes')
    expect(down).toContain('--env-file /dev/null')
  })

  test('with no docker on PATH it says so plainly, with no stack trace', () => {
    const empty = mkdtempSync(join(tmpdir(), 'closeline-nodocker-'))
    for (const args of [['--down'], []]) {
      const result = runDev(args, { PATH: empty })
      expect(result.code).toBe(1)
      expect(result.err).toContain('Docker installed and on PATH')
      expect(result.err).not.toMatch(/Executable not found|\n\s+at /)
    }
  })

  test('an unknown flag exits 2 with the usage', () => {
    const result = runDev(['--wipe'], { PATH: '/usr/bin:/bin' })
    expect(result.code).toBe(2)
    expect(result.err).toContain('usage: bun run dev')
  })
})
