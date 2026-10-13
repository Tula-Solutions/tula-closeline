import { describe, expect, test } from 'bun:test'
import {
  exitCodeFor,
  formatResult,
  parseSmokeArgs,
  runSmoke,
  type StepResult,
} from './dev-smoke.ts'

type Seen = { method: string; path: string; body: string }

/**
 * A stand-in for the three services. `mail` is how auth answers a sign-up; `core` overrides how
 * core answers a request with no token.
 */
function fakeStack(options: { mail?: 'unavailable' | 'sent'; coreOpen?: boolean } = {}) {
  const seen: Seen[] = []
  const answer = async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    seen.push({ method: request.method, path: url.pathname, body: await request.text() })
    if (url.pathname === '/readyz') {
      return Response.json({ status: 'ok' })
    }
    if (url.pathname === '/') {
      return new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } })
    }
    if (url.pathname === '/.well-known/jwks.json') {
      return Response.json({ keys: [{ kty: 'OKP', alg: 'EdDSA', kid: 'k' }] })
    }
    if (url.pathname === '/v1/organization') {
      if (options.coreOpen) {
        return Response.json({ id: 'org_x' })
      }
      const bearer = request.headers.get('authorization')
      return Response.json(
        { error: { code: bearer ? 'auth.token_invalid' : 'auth.unauthenticated' } },
        { status: 401 }
      )
    }
    if (url.pathname === '/v1/client/sign-ups') {
      return options.mail === 'sent'
        ? Response.json({ id: 'su_1', status: 'needs_email_verification' })
        : Response.json({ error: { code: 'mail.unavailable' } }, { status: 503 })
    }
    return new Response('{}', { status: 404 })
  }
  const auth = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: answer })
  const core = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: answer })
  const portal = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: answer })
  return {
    seen,
    targets: {
      auth: `http://127.0.0.1:${auth.port}`,
      core: `http://127.0.0.1:${core.port}`,
      portal: `http://127.0.0.1:${portal.port}`,
    },
    stop: () => {
      auth.stop(true)
      core.stop(true)
      portal.stop(true)
    },
  }
}

const by = (results: StepResult[], name: string) => results.find((result) => result.name === name)

describe('runSmoke', () => {
  test('with no mail provider the flow stops at the sign-up and every later step is skipped, not failed', async () => {
    const stack = fakeStack()
    const results = await runSmoke(stack.targets, { timeoutMs: 1_000 })
    stack.stop()
    expect(results.filter((result) => result.status === 'fail')).toEqual([])
    expect(by(results, 'auth is ready')?.status).toBe('pass')
    expect(by(results, 'core refuses a request without a valid token')?.status).toBe('pass')
    const signUp = by(results, 'sign up (starts, emails a code)')
    expect(signUp?.status).toBe('skip')
    expect(signUp?.detail).toContain('mail.unavailable')
    expect(results.filter((result) => result.status === 'skip')).toHaveLength(8)
    expect(formatResult(signUp as StepResult)).toStartWith('SKIP  sign up')
    expect(formatResult(signUp as StepResult)).toContain('skipped: ')
    expect(exitCodeFor(results)).toBe(0)
  })

  test('sends the sign-up once, however the answer goes', async () => {
    const stack = fakeStack()
    await runSmoke(stack.targets, { timeoutMs: 1_000 })
    stack.stop()
    expect(stack.seen.filter((call) => call.path === '/v1/client/sign-ups')).toHaveLength(1)
  })

  test('a sign-up that is accepted still skips the steps that need the emailed code', async () => {
    const stack = fakeStack({ mail: 'sent' })
    const results = await runSmoke(stack.targets, { timeoutMs: 1_000 })
    stack.stop()
    expect(by(results, 'sign up (starts, emails a code)')?.status).toBe('skip')
    expect(by(results, 'verify the email code')?.detail).toContain('no local mail stand-in')
    expect(exitCodeFor(results)).toBe(0)
  })

  test('a core that answers without a token fails the run', async () => {
    const stack = fakeStack({ coreOpen: true })
    const results = await runSmoke(stack.targets, { timeoutMs: 1_000 })
    stack.stop()
    const refusal = by(results, 'core refuses a request without a valid token')
    expect(refusal?.status).toBe('fail')
    expect(refusal?.detail).toContain('200')
    expect(exitCodeFor(results)).toBe(1)
  })

  test('a service that is down is a failure naming the step, with the error message only', async () => {
    const stack = fakeStack()
    stack.stop()
    const results = await runSmoke(stack.targets, { timeoutMs: 100 })
    expect(by(results, 'auth is ready')?.status).toBe('fail')
    expect(exitCodeFor(results)).toBe(1)
  })

  test('never puts the password, the email address or a bearer value in the report', async () => {
    const stack = fakeStack()
    const results = await runSmoke(stack.targets, { timeoutMs: 1_000 })
    stack.stop()
    const sent = JSON.parse(
      stack.seen.find((call) => call.path === '/v1/client/sign-ups')?.body ?? '{}'
    ) as {
      email: string
      password: string
    }
    expect(sent.password.length).toBeGreaterThanOrEqual(10)
    const report = results.map(formatResult).join('\n')
    expect(report).not.toContain(sent.password)
    expect(report).not.toContain(sent.email)
    expect(report).not.toMatch(/bearer/i)
  })
})

describe('--strict', () => {
  test('parses the flag and refuses anything else', () => {
    expect(parseSmokeArgs([])).toEqual({ strict: false })
    expect(parseSmokeArgs(['--strict'])).toEqual({ strict: true })
    expect(parseSmokeArgs(['--loose'])).toEqual({ error: 'unknown argument: --loose' })
  })

  test('a skipped step is an error in strict mode and not otherwise', async () => {
    const stack = fakeStack()
    const results = await runSmoke(stack.targets, { timeoutMs: 1_000 })
    stack.stop()
    expect(results.some((result) => result.status === 'skip')).toBe(true)
    expect(exitCodeFor(results)).toBe(0)
    expect(exitCodeFor(results, true)).toBe(1)
  })

  test('strict still passes when nothing is skipped or failed', () => {
    const results: StepResult[] = [{ name: 'a', status: 'pass', detail: '' }]
    expect(exitCodeFor(results, true)).toBe(0)
  })
})
