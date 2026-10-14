import './test-guard.ts'
import { describe, expect, test } from 'bun:test'
import { exitCodeFor, formatResult, runSmoke, type StepResult } from './dev-smoke.ts'
import { type FakeOptions, fakeStack } from './dev-smoke-fake.ts'
import { GOOGLE_STEPS } from './dev-smoke-google.ts'

const by = (results: StepResult[], name: string) => results.find((result) => result.name === name)
const fast = {
  timeoutMs: 1_000,
  mailWaitMs: 400,
  mailIntervalMs: 20,
  playbookWaitMs: 400,
  playbookIntervalMs: 10,
}

async function run(options: FakeOptions = {}) {
  const stack = fakeStack(options)
  try {
    const results = await runSmoke(stack.targets, fast)
    return { stack, results }
  } finally {
    stack.stop()
  }
}

const googleResults = (results: StepResult[]) =>
  GOOGLE_STEPS.map((name) => by(results, name) as StepResult)

describe('the Sign in with Google smoke steps', () => {
  test('against a healthy stack every Google step passes, so --strict is green', async () => {
    const { results } = await run()
    for (const result of googleResults(results)) {
      expect(result?.status).toBe('pass')
    }
    expect(results.filter((result) => result.status !== 'pass')).toEqual([])
    expect(exitCodeFor(results, true)).toBe(0)
  })

  test('the steps run in the documented order before the final refresh replay', async () => {
    const { results } = await run()
    const names = results.map((result) => result.name)
    const indexes = GOOGLE_STEPS.map((name) => names.indexOf(name))
    expect(indexes.every((index) => index > -1)).toBe(true)
    expect([...indexes].sort((a, b) => a - b)).toEqual(indexes)
  })

  test('the browser steps use the allowed Origin, the attempt cookie and a fresh email', async () => {
    const { stack } = await run()
    const start = stack.seen.find((call) => call.path === '/v1/client/google/start')
    const complete = stack.seen.find((call) => call.path === '/v1/client/google/complete')
    expect(start?.origin).toBe(stack.targets.portal)
    expect(complete?.origin).toBe(stack.targets.portal)
    expect(JSON.parse(complete?.body ?? '{}')).toMatchObject({
      organizationName: expect.any(String),
    })
    const callbacks = stack.seen.filter((call) => call.path === '/v1/client/google/callback')
    expect(callbacks).toHaveLength(3)
    expect(stack.googleEmails.length).toBe(2)
    expect(stack.googleEmails[0]).toMatch(/^google-[0-9a-f]+@[a-z-]+\.test$/)
    expect(stack.googleEmails[0]).toBe(stack.googleEmails[1])
  })

  test('the callback is requested through the portal, not straight at auth', async () => {
    const { stack } = await run()
    expect(stack.portalPaths).toContain('/v1/client/google/callback')
  })

  test('never puts an email, cookie, attempt, state or code in the report', async () => {
    const { stack, results } = await run()
    const report = results.map(formatResult).join('\n')
    expect(stack.googleSecrets.length).toBeGreaterThan(5)
    for (const secret of stack.googleSecrets) {
      expect(report).not.toContain(secret)
    }
  })

  test('with Google off, the Google steps are skipped with the reason and --strict fails', async () => {
    const { results } = await run({ google: 'off' })
    const [first, ...rest] = googleResults(results)
    expect(first?.status).toBe('skip')
    expect(first?.detail).toContain('off')
    for (const result of rest) {
      expect(result?.status).toBe('skip')
    }
    expect(results.filter((result) => result.status === 'fail')).toEqual([])
    expect(exitCodeFor(results)).toBe(0)
    expect(exitCodeFor(results, true)).toBe(1)
  })

  test('with real Google configured, the redirect is not followed and the rest is skipped', async () => {
    const { stack, results } = await run({ google: 'real' })
    const found = googleResults(results)
    expect(found[0]?.status).toBe('pass')
    expect(found[1]?.status).toBe('skip')
    expect(found[1]?.detail).toContain('real Google')
    for (const result of found.slice(2)) {
      expect(result?.status).toBe('skip')
    }
    expect(results.filter((result) => result.status === 'fail')).toEqual([])
    expect(stack.googleEmails).toEqual([])
  })

  test('a replayed callback that is accepted fails the replay step', async () => {
    const { results } = await run({ google: 'replay-accepted' })
    const found = by(results, GOOGLE_STEPS[GOOGLE_STEPS.length - 1] as string)
    expect(found?.status).toBe('fail')
    expect(found?.detail).toContain('oidc.state_invalid')
    expect(exitCodeFor(results)).toBe(1)
  })

  test('a returning person sent to sign-up again fails the second sign-in step', async () => {
    const { results } = await run({ google: 'returning-is-new' })
    const found = by(results, GOOGLE_STEPS[GOOGLE_STEPS.length - 2] as string)
    expect(found?.status).toBe('fail')
    expect(exitCodeFor(results)).toBe(1)
  })

  test('a callback that sets no refresh cookie fails the second sign-in step', async () => {
    const { results } = await run({ google: 'no-refresh-cookie' })
    const found = by(results, GOOGLE_STEPS[GOOGLE_STEPS.length - 2] as string)
    expect(found?.status).toBe('fail')
    expect(found?.detail).toContain('cookie')
  })

  test('an authorization URL that is not on the fake issuer is never followed', async () => {
    const { stack } = await run({ google: 'real' })
    expect(stack.googleAuthorizeHits).toBe(0)
  })

  test('a session that /me does not accept fails the /me step', async () => {
    const { results } = await run({ google: 'me-broken' })
    const found = by(results, 'google: /me shows the signed-in person')
    expect(found?.status).toBe('fail')
  })

  test('an organization name is required by complete and a refusal fails that step', async () => {
    const { results } = await run({ google: 'complete-refused' })
    const found = by(results, 'google: complete with an Organization name gives a session')
    expect(found?.status).toBe('fail')
    // The steps that need the session are blocked, not guessed.
    expect(by(results, 'google: /me shows the signed-in person')?.status).toBe('skip')
  })
})
