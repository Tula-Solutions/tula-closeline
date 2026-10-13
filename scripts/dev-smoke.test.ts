import { describe, expect, test } from 'bun:test'
import {
  ACCOUNT_STEPS,
  exitCodeFor,
  formatResult,
  parseSmokeArgs,
  runSmoke,
  type StepResult,
} from './dev-smoke.ts'
import { type FakeOptions, fakeStack } from './dev-smoke-fake.ts'

const by = (results: StepResult[], name: string) => results.find((result) => result.name === name)
const fast = { timeoutMs: 1_000, mailWaitMs: 400, mailIntervalMs: 20 }

async function run(options: FakeOptions = {}, extra: Parameters<typeof runSmoke>[1] = {}) {
  const stack = fakeStack(options)
  try {
    const results = await runSmoke(stack.targets, { ...fast, ...extra })
    return { stack, results }
  } finally {
    stack.stop()
  }
}

describe('runSmoke against a healthy stack', () => {
  test('every step passes and none is skipped, so --strict is green', async () => {
    const { results } = await run()
    expect(results.filter((result) => result.status !== 'pass')).toEqual([])
    for (const name of ACCOUNT_STEPS) {
      expect(by(results, name)?.status).toBe('pass')
    }
    expect(exitCodeFor(results, true)).toBe(0)
  })

  test('the mailbox is checked for readiness', async () => {
    const { results } = await run()
    expect(by(results, 'the mailbox is ready')?.status).toBe('pass')
  })

  test('each sign-up is sent once and a refresh token is used once, except the deliberate replay', async () => {
    const { stack } = await run()
    expect(stack.seen.filter((call) => call.path === '/v1/client/sign-ups')).toHaveLength(2)
    const refreshes = stack.seen
      .filter((call) => call.path === '/v1/client/sessions/refresh')
      .map((call) => call.body)
    expect(refreshes).toHaveLength(5)
    expect(refreshes.length - new Set(refreshes).size).toBe(1)
    expect(
      stack.seen.filter((call) => call.path === '/v1/invitations' && call.method === 'POST')
    ).toHaveLength(2)
  })

  test('the sign-up uses a reserved .test domain and a fresh address each run', async () => {
    const first = await run()
    const second = await run()
    const emails = [first, second].map(({ stack }) => {
      const body = stack.seen.find((call) => call.path === '/v1/client/sign-ups')?.body ?? '{}'
      return (JSON.parse(body) as { email: string }).email
    })
    expect(emails[0]).toMatch(/^smoke-[0-9a-f]+@[a-z-]+\.test$/)
    expect(emails[0]).not.toBe(emails[1])
  })

  test('never puts a password, code, token, link or address in the report', async () => {
    const { stack, results } = await run()
    const report = results.map(formatResult).join('\n')
    const signUp = JSON.parse(
      stack.seen.find((call) => call.path === '/v1/client/sign-ups')?.body ?? '{}'
    ) as { email: string; password: string }
    const secrets = [
      signUp.password,
      signUp.email,
      ...stack.mailbox.flatMap((mail) => [
        mail.to,
        /\d{6}/.exec(mail.text)?.[0] ?? '',
        /#invitation=(\S+)/.exec(mail.text)?.[1] ?? '',
      ]),
    ].filter((value) => value !== '')
    expect(secrets.length).toBeGreaterThan(4)
    for (const secret of secrets) {
      expect(report).not.toContain(secret)
    }
    expect(report).not.toMatch(/bearer|invitation=|at_\d|rt_\d/i)
  })
})

describe('runSmoke without a mailbox for auth', () => {
  test('a 503 mail.unavailable skips the sign-up and every step that needs it, with the reason', async () => {
    const { stack, results } = await run({ mail: 'unavailable' })
    expect(results.filter((result) => result.status === 'fail')).toEqual([])
    const signUp = by(results, 'sign up (starts, emails a code)')
    expect(signUp?.status).toBe('skip')
    expect(signUp?.detail).toContain('mail.unavailable')
    expect(results.filter((result) => result.status === 'skip')).toHaveLength(ACCOUNT_STEPS.length)
    const verify = by(results, 'verify the email code')
    expect(verify?.status).toBe('skip')
    expect(verify?.detail).toContain('blocked by')
    expect(formatResult(signUp as StepResult)).toStartWith('SKIP  sign up')
    expect(formatResult(signUp as StepResult)).toContain('skipped: ')
    expect(exitCodeFor(results)).toBe(0)
    expect(exitCodeFor(results, true)).toBe(1)
    expect(stack.seen.filter((call) => call.path === '/v1/client/sign-ups')).toHaveLength(1)
  })
})

describe('refresh', () => {
  test('an access token that is the same string as the last one is fine: only the refresh token must rotate', async () => {
    const { results } = await run({ sameAccessToken: true })
    expect(by(results, 'refresh the session')?.status).toBe('pass')
    expect(results.filter((result) => result.status !== 'pass')).toEqual([])
  })

  test('a refresh that hands back the same refresh token fails', async () => {
    const { results } = await run({ reuseRefreshToken: true })
    const refresh = by(results, 'refresh the session')
    expect(refresh?.status).toBe('fail')
    expect(refresh?.detail).toContain('did not rotate')
  })
})

describe('a failing step blocks only what needs it', () => {
  test('a rejected code fails that step; sign-in and everything after it is skipped as blocked', async () => {
    const { results } = await run({ rejectCode: true })
    const verify = by(results, 'verify the email code')
    expect(verify?.status).toBe('fail')
    expect(verify?.detail).toContain('422')
    expect(verify?.detail).toContain('verification.code_invalid')
    expect(by(results, 'sign in')?.detail).toContain('blocked by "verify the email code" (failed)')
    for (const name of ACCOUNT_STEPS.slice(3)) {
      const blocked = by(results, name)
      expect(blocked?.status).toBe('skip')
      expect(blocked?.detail).toContain('blocked by "')
    }
    expect(by(results, 'read the verification code from the mailbox')?.status).toBe('pass')
    expect(exitCodeFor(results)).toBe(1)
  })

  test('an email that never reaches the mailbox is a failure after a bounded wait', async () => {
    const started = Date.now()
    const { results } = await run({ dropMail: true })
    const read = by(results, 'read the verification code from the mailbox')
    expect(read?.status).toBe('fail')
    expect(read?.detail).toContain('no verification email')
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(by(results, 'verify the email code')?.status).toBe('skip')
  })

  test('a link that does not point at the portal sign-up page fails the Invitation email step', async () => {
    const { results } = await run({ wrongLinkHost: true })
    const link = by(results, 'the Invitation email and its link reach the mailbox')
    expect(link?.status).toBe('fail')
    expect(link?.detail).toContain('portal sign-up page')
    expect(link?.detail).not.toContain('elsewhere')
  })

  test('a core that answers without a token fails the run', async () => {
    const { results } = await run({ coreOpen: true })
    const refusal = by(results, 'core refuses a request without a valid token')
    expect(refusal?.status).toBe('fail')
    expect(refusal?.detail).toContain('200')
    expect(exitCodeFor(results)).toBe(1)
  })

  test('a service that is down is a failure naming the step', async () => {
    const stack = fakeStack()
    stack.stop()
    const results = await runSmoke(stack.targets, { timeoutMs: 100, mailWaitMs: 50 })
    expect(by(results, 'auth is ready')?.status).toBe('fail')
    expect(by(results, 'the mailbox is ready')?.status).toBe('fail')
    expect(exitCodeFor(results)).toBe(1)
  })
})

describe('Organization isolation', () => {
  test.each([
    ['invitations', 'GET /v1/invitations'],
    ['members', 'GET /v1/members'],
    ['organization', 'GET /v1/organization'],
    ['teams', 'GET /v1/teams'],
  ] as const)('a core that leaks %s to the second user fails the check', async (leak, label) => {
    const { results } = await run({ leak })
    const check = by(results, 'a second sign-up cannot read the first Organization')
    expect(check?.status).toBe('fail')
    expect(check?.detail).toContain(label)
    expect(exitCodeFor(results, true)).toBe(1)
  })

  test('a leaking answer is named but never printed', async () => {
    const { stack, results } = await run({ leak: 'invitations' })
    const check = by(results, 'a second sign-up cannot read the first Organization')
    const invite = stack.seen.find(
      (call) => call.path === '/v1/invitations' && call.method === 'POST'
    )
    const email = (JSON.parse(invite?.body ?? '{}') as { email: string }).email
    expect(check?.detail).toContain('returned data of the first Organization')
    expect(check?.detail).not.toContain(email)
  })

  test('a core that lets the second user revoke the first Invitation fails the check', async () => {
    const { results } = await run({ revokeAcrossOrganizations: true })
    const check = by(results, 'a second sign-up cannot read the first Organization')
    expect(check?.status).toBe('fail')
    expect(check?.detail).toContain('204')
  })

  test('the second user is a different person in a different Organization', async () => {
    const { stack } = await run()
    const signUps = stack.seen.filter((call) => call.path === '/v1/client/sign-ups')
    const emails = signUps.map((call) => (JSON.parse(call.body) as { email: string }).email)
    expect(new Set(emails).size).toBe(2)
  })
})

describe('what a failure message may contain', () => {
  test('a transport error that quotes a secret has it removed', async () => {
    const stack = fakeStack()
    let token: string | undefined
    const wrapped = (async (input: string | URL | Request, init?: RequestInit) => {
      const header = new Headers(init?.headers).get('authorization')
      if (header && String(input).includes('/v1/members')) {
        token = header.replace(/^Bearer /, '')
        throw new Error(`socket closed while sending ${header}`)
      }
      return fetch(input, init)
    }) as typeof fetch
    const results = await runSmoke(stack.targets, { ...fast, fetchImpl: wrapped })
    stack.stop()
    const members = by(results, 'core: GET /v1/members with the access token')
    expect(members?.status).toBe('fail')
    expect(token).toBeDefined()
    expect(members?.detail).not.toContain(token as string)
    expect(members?.detail).toContain('[hidden]')
  })
})

describe('--strict', () => {
  test('parses the flag and refuses anything else', () => {
    expect(parseSmokeArgs([])).toEqual({ strict: false })
    expect(parseSmokeArgs(['--strict'])).toEqual({ strict: true })
    expect(parseSmokeArgs(['--loose'])).toEqual({ error: 'unknown argument: --loose' })
  })

  test('strict still passes when nothing is skipped or failed', () => {
    const results: StepResult[] = [{ name: 'a', status: 'pass', detail: '' }]
    expect(exitCodeFor(results, true)).toBe(0)
  })

  test('a skip passes normally and fails under strict', () => {
    const results: StepResult[] = [{ name: 'a', status: 'skip', detail: 'x' }]
    expect(exitCodeFor(results)).toBe(0)
    expect(exitCodeFor(results, true)).toBe(1)
  })
})
