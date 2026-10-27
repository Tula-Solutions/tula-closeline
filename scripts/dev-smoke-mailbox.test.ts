import './test-guard.ts'
import { describe, expect, test } from 'bun:test'
import { exitCodeFor, runSmoke, type StepResult } from './dev-smoke.ts'
import { type FakeOptions, fakeStack } from './dev-smoke-fake.ts'
import { MAILBOX_STEPS, NO_MAILBOX_SKIP, TEST_SEND_SKIP } from './dev-smoke-mailbox.ts'

const by = (results: StepResult[], name: string) => results.find((result) => result.name === name)
const fast = {
  timeoutMs: 1_000,
  mailWaitMs: 400,
  mailIntervalMs: 20,
  playbookWaitMs: 400,
  playbookIntervalMs: 10,
}

async function run(options: FakeOptions = {}, drop?: 'outbound' | 'fakeGoogle') {
  const stack = fakeStack(options)
  try {
    const targets = { ...stack.targets }
    if (drop) {
      delete targets[drop]
    }
    return { stack, results: await runSmoke(targets, fast) }
  } finally {
    stack.stop()
  }
}

const mailbox = (results: StepResult[]) => MAILBOX_STEPS.map((name) => by(results, name))

describe('the Mailbox smoke steps', () => {
  test('against a healthy stack both pass, the message is at the fake and --strict is green', async () => {
    const { stack, results } = await run()
    expect(mailbox(results).map((result) => result?.status)).toEqual(['pass', 'pass'])
    expect(exitCodeFor(results, true)).toBe(0)
    const complete = stack.seen.find((call) => call.path === '/v1/mailboxes/connect/complete')
    expect(complete?.key).toMatch(/^mailbox-[0-9a-f]+-complete$/)
  })

  test('a test-send route that answers 404 skips the send with the stated reason', async () => {
    const { results } = await run({ outbound: { noTestSend: true } })
    expect(by(results, MAILBOX_STEPS[0])?.status).toBe('pass')
    const send = by(results, MAILBOX_STEPS[1])
    expect(send?.status).toBe('skip')
    expect(send?.detail).toBe(TEST_SEND_SKIP)
    expect(exitCodeFor(results)).toBe(0)
    expect(exitCodeFor(results, true)).toBe(1)
  })

  test('an outbound without Mailbox routes skips both steps with the reason, strict fails', async () => {
    const { results } = await run({ outbound: { noMailbox: true } })
    expect(mailbox(results).map((result) => result?.status)).toEqual(['skip', 'skip'])
    expect(by(results, MAILBOX_STEPS[0])?.detail).toBe(NO_MAILBOX_SKIP)
    expect(exitCodeFor(results)).toBe(0)
    expect(exitCodeFor(results, true)).toBe(1)
  })

  test('a failing connection is a failure, and the send is blocked by it', async () => {
    const { results } = await run({ outbound: { connectFails: true } })
    expect(by(results, MAILBOX_STEPS[0])?.status).toBe('fail')
    expect(by(results, MAILBOX_STEPS[1])?.status).toBe('skip')
    expect(by(results, MAILBOX_STEPS[1])?.detail).toContain('blocked by')
  })

  test('a send that errors, or that the provider never gets, fails', async () => {
    const errors = await run({ outbound: { sendFails: true } })
    expect(by(errors.results, MAILBOX_STEPS[1])?.status).toBe('fail')
    const lost = await run({ outbound: { notDelivered: true } })
    expect(by(lost.results, MAILBOX_STEPS[1])?.status).toBe('fail')
  })

  test('without an outbound address both steps skip with the reason', async () => {
    const { results } = await run({}, 'outbound')
    expect(by(results, MAILBOX_STEPS[0])?.detail).toBe('no outbound address was given')
    expect(by(results, MAILBOX_STEPS[1])?.status).toBe('skip')
  })

  test('without the fake provider (real Google) the connection is skipped, not tried', async () => {
    const { results, stack } = await run({}, 'fakeGoogle')
    expect(by(results, MAILBOX_STEPS[0])?.status).toBe('skip')
    expect(stack.seen.some((call) => call.path === '/v1/mailboxes/connect')).toBe(false)
  })

  test('no address, code or state is printed', async () => {
    const { results, stack } = await run()
    const text = JSON.stringify(mailbox(results))
    expect(text).not.toContain('closeline-smoke.test')
    for (const secret of stack.googleSecrets) {
      expect(text).not.toContain(secret)
    }
  })
})
