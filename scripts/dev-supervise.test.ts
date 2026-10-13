import { describe, expect, test } from 'bun:test'
import {
  captureCommand,
  type ManagedChild,
  runCommand,
  type ServiceSpec,
  type Sinks,
  STOP_SIGNALS,
  spawnManaged,
  stopAll,
  supervise,
} from './dev-lib.ts'

/** A child that records the signals it gets; `ignoreTerm` makes it need a SIGKILL. */
function fakeChild(name: string, options: { ignoreTerm?: boolean } = {}) {
  let alive = true
  let finish: (code: number) => void = () => {}
  const exited = new Promise<number>((resolve) => {
    finish = resolve
  })
  const signals: string[] = []
  const child: ManagedChild = {
    name,
    alive: () => alive,
    kill: (signal) => {
      signals.push(signal)
      if (signal === 'SIGKILL' || !options.ignoreTerm) {
        alive = false
        finish(signal === 'SIGKILL' ? 137 : 143)
      }
    },
    exited,
  }
  return {
    child,
    signals,
    die: (code: number) => {
      alive = false
      finish(code)
    },
  }
}

/** A supervise harness: fake children, a settable probe and a signal source. */
function harness(
  options: {
    probe?: () => Promise<{ ok: true } | { ok: false; reason: string }>
    waitReady?: (url: string, isAlive: () => boolean) => Promise<string | undefined>
    spawnFails?: string
  } = {}
) {
  const children = new Map<string, ReturnType<typeof fakeChild>>()
  const lines: string[] = []
  const errors: string[] = []
  let handler: (signal: string) => void = () => {}
  let unsubscribed = 0
  const specs: ServiceSpec[] = ['core', 'auth', 'portal'].map((name) => ({
    name,
    readyUrl: `http://x/${name}`,
    spawn: () => {
      if (options.spawnFails === name) {
        throw new Error(`cannot start ${name}`)
      }
      const fake = fakeChild(name)
      children.set(name, fake)
      return fake.child
    },
  }))
  let bannerReached: () => void = () => {}
  const running = new Promise<void>((resolve) => {
    bannerReached = resolve
  })
  const result = supervise({
    services: specs,
    probe: options.probe ?? (async () => ({ ok: true })),
    waitReady: options.waitReady ?? (async () => undefined),
    subscribe: (onSignal) => {
      handler = onSignal
      return () => {
        unsubscribed++
      }
    },
    log: (line) => lines.push(line),
    error: (line) => errors.push(line),
    banner: () => bannerReached(),
    graceMs: 50,
  })
  return {
    result,
    running,
    children,
    lines,
    errors,
    signal: (name: string) => handler(name),
    unsubscribed: () => unsubscribed,
  }
}

describe('supervise', () => {
  test('a signal after startup stops all three children and exits 0', async () => {
    const h = harness()
    await h.running
    h.signal('SIGINT')
    expect(await h.result).toBe(0)
    expect([...h.children.values()].map((fake) => fake.signals)).toEqual([
      ['SIGTERM'],
      ['SIGTERM'],
      ['SIGTERM'],
    ])
    expect(h.unsubscribed()).toBe(1)
  })

  test('stops on SIGHUP as well as SIGINT and SIGTERM', () => {
    expect([...STOP_SIGNALS]).toEqual(['SIGINT', 'SIGTERM', 'SIGHUP'])
  })

  test('a probe that throws still stops every child and exits 1', async () => {
    const h = harness({
      probe: async () => {
        throw new Error('core timed out')
      },
    })
    expect(await h.result).toBe(1)
    expect(h.errors).toContain('core timed out')
    expect(h.children.size).toBe(3)
    for (const fake of h.children.values()) {
      expect(fake.child.alive()).toBe(false)
      expect(fake.signals).toEqual(['SIGTERM'])
    }
  })

  test('a failed wiring probe stops every child and exits 1', async () => {
    const h = harness({ probe: async () => ({ ok: false, reason: 'core answered 401' }) })
    expect(await h.result).toBe(1)
    expect(h.errors).toContain('wiring: core answered 401')
    for (const fake of h.children.values()) {
      expect(fake.child.alive()).toBe(false)
    }
  })

  test('a spawn that throws stops the children already started', async () => {
    const h = harness({ spawnFails: 'portal' })
    expect(await h.result).toBe(1)
    expect([...h.children.keys()]).toEqual(['core', 'auth'])
    for (const fake of h.children.values()) {
      expect(fake.child.alive()).toBe(false)
    }
    expect(h.errors).toContain('cannot start portal')
  })

  test('a service that exits while running stops the others and exits 1', async () => {
    const h = harness()
    await h.running
    h.children.get('auth')?.die(137)
    expect(await h.result).toBe(1)
    expect(h.errors).toContain('auth exited with code 137')
    expect(h.children.get('core')?.signals).toEqual(['SIGTERM'])
    expect(h.children.get('portal')?.signals).toEqual(['SIGTERM'])
  })

  test('a service that never becomes ready stops everything', async () => {
    const h = harness({
      waitReady: async (url) => (url.endsWith('/auth') ? 'did not answer 2xx' : undefined),
    })
    expect(await h.result).toBe(1)
    expect(h.errors).toContain('auth did not answer 2xx')
    expect(h.children.has('portal')).toBe(false)
    expect(h.children.get('core')?.child.alive()).toBe(false)
  })

  test('a signal while a service is still starting stops it and exits 0, without probing', async () => {
    let probed = false
    let release: () => void = () => {}
    const h = harness({
      probe: async () => {
        probed = true
        return { ok: true }
      },
      waitReady: (_url, isAlive) =>
        new Promise((resolve) => {
          release = () => resolve(isAlive() ? undefined : 'stopped')
        }),
    })
    await Bun.sleep(10)
    h.signal('SIGHUP')
    release()
    expect(await h.result).toBe(0)
    expect(probed).toBe(false)
    expect(h.children.get('core')?.child.alive()).toBe(false)
  })
})

describe('stopAll', () => {
  test('sends SIGKILL to a child that ignores SIGTERM once the grace has passed', async () => {
    const stubborn = fakeChild('stubborn', { ignoreTerm: true })
    const polite = fakeChild('polite')
    await stopAll([stubborn.child, polite.child], 30)
    expect(stubborn.signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(polite.signals).toEqual(['SIGTERM'])
  })

  test('leaves a child that already exited alone', async () => {
    const gone = fakeChild('gone')
    gone.die(0)
    await stopAll([gone.child], 30)
    expect(gone.signals).toEqual([])
  })
})

/** Output sinks that collect lines. */
function sinks(): Sinks & { out_: string[]; err_: string[] } {
  const out_: string[] = []
  const err_: string[] = []
  return { out: (t) => out_.push(t), err: (t) => err_.push(t), out_, err_ }
}

const SECRET = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
const bun = process.execPath
const printSecret = `console.log("out ${SECRET} end"); console.error("err ${SECRET} end")`

describe('subprocess output', () => {
  test('runCommand scrubs a secret from both streams', async () => {
    const s = sinks()
    const { code } = await runCommand('step', [bun, '-e', printSecret], {
      cwd: '/',
      env: {},
      secrets: [SECRET],
      sinks: s,
      timeoutMs: 10_000,
    })
    expect(code).toBe(0)
    expect(s.out_.join('')).toContain('[step]')
    expect(s.out_.join('')).toContain('[redacted]')
    expect(s.err_.join('')).toContain('[redacted]')
    expect(s.out_.join('') + s.err_.join('')).not.toContain(SECRET)
  })

  test('spawnManaged scrubs a secret from both streams of a service', async () => {
    const s = sinks()
    const child = spawnManaged('auth', [bun, '-e', printSecret], {
      cwd: '/',
      env: {},
      secrets: [SECRET],
      sinks: s,
    })
    expect(await child.exited).toBe(0)
    expect(child.alive()).toBe(false)
    expect(s.out_.join('')).toContain('[redacted]')
    expect(s.err_.join('')).toContain('[redacted]')
    expect(s.out_.join('') + s.err_.join('')).not.toContain(SECRET)
  })

  test('without the secret list the same output would leak (so the scrub is what hides it)', async () => {
    const s = sinks()
    await runCommand('step', [bun, '-e', printSecret], {
      cwd: '/',
      env: {},
      secrets: [],
      sinks: s,
      timeoutMs: 10_000,
    })
    expect(s.out_.join('')).toContain(SECRET)
  })

  test('runCommand kills a command that runs past its timeout', async () => {
    const started = Date.now()
    const result = await runCommand('slow', [bun, '-e', 'await Bun.sleep(30000)'], {
      cwd: '/',
      env: {},
      secrets: [],
      sinks: sinks(),
      timeoutMs: 150,
    })
    expect(result.timedOut).toBe(true)
    expect(result.code).not.toBe(0)
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  test('captureCommand returns undefined for a failure and for a timeout', async () => {
    const options = { cwd: '/', env: {}, timeoutMs: 150 }
    expect(await captureCommand([bun, '-e', 'process.exit(3)'], options)).toBeUndefined()
    expect(await captureCommand([bun, '-e', 'await Bun.sleep(30000)'], options)).toBeUndefined()
    expect(
      await captureCommand([bun, '-e', 'console.log("hi")'], { ...options, timeoutMs: 10_000 })
    ).toBe('hi\n')
  })

  test('a command given stdin receives it', async () => {
    const out = await captureCommand([bun, '-e', 'console.log(await Bun.stdin.text())'], {
      cwd: '/',
      env: {},
      timeoutMs: 10_000,
      stdin: 'select 1;',
    })
    expect(out?.trim()).toBe('select 1;')
  })
})
