// The Lines steps of the smoke test, each shown able to fail: a voice fake breaks one thing and the
// matching step must go red. See hub issue 382.
import './test-guard.ts'
import { describe, expect, test } from 'bun:test'
import { exitCodeFor, runSmoke, type StepResult, VOICE_STEPS } from './dev-smoke.ts'
import { fakeStack } from './dev-smoke-fake.ts'
import type { VoiceFakeOptions } from './dev-smoke-voice-fake.ts'

const by = (results: StepResult[], name: string) => results.find((result) => result.name === name)
const fast = {
  timeoutMs: 1_000,
  mailWaitMs: 400,
  mailIntervalMs: 20,
  playbookWaitMs: 400,
  playbookIntervalMs: 10,
}

async function run(voice: VoiceFakeOptions = {}) {
  const stack = fakeStack({ voice })
  try {
    return { stack, results: await runSmoke(stack.targets, fast) }
  } finally {
    stack.stop()
  }
}

describe('the Lines steps against a healthy voice', () => {
  test('voice is ready and every Lines step passes, so --strict is green', async () => {
    const { results } = await run()
    expect(by(results, 'voice is ready')?.status).toBe('pass')
    for (const name of VOICE_STEPS) {
      expect(by(results, name)?.status).toBe('pass')
    }
    expect(results.filter((result) => result.status !== 'pass')).toEqual([])
    expect(exitCodeFor(results, true)).toBe(0)
  })

  test('the Owner adds the Line once, with an Idempotency-Key', async () => {
    const { stack } = await run()
    const adds = stack.seen.filter((call) => call.method === 'POST' && call.path === '/v1/lines')
    expect(adds).toHaveLength(1)
    expect(adds[0]?.key).toBeTruthy()
  })
})

describe('the Lines steps against a broken voice', () => {
  test('a list that returns every Organization Lines fails the isolation step', async () => {
    const { results } = await run({ leak: true })
    expect(by(results, VOICE_STEPS[1])?.status).toBe('fail')
    expect(exitCodeFor(results)).toBe(1)
  })

  test('a list that is always empty fails the Owner step, so isolation cannot pass on nothing', async () => {
    const { results } = await run({ emptyList: true })
    expect(by(results, VOICE_STEPS[0])?.status).toBe('fail')
    expect(by(results, VOICE_STEPS[1])?.status).toBe('skip')
  })

  test('an add that fails fails the Owner step', async () => {
    const { results } = await run({ addFails: true })
    expect(by(results, VOICE_STEPS[0])?.status).toBe('fail')
  })
})

describe('the Lines isolation step when the second Organization was never made', () => {
  test('is skipped, and the skip names the sales-history step that should have made it', async () => {
    const stack = fakeStack({ playbook: { noRightsGate: true } })
    try {
      const results = await runSmoke(stack.targets, fast)
      const skipped = by(results, VOICE_STEPS[1])
      expect(skipped?.status).toBe('skip')
      expect(skipped?.detail).toContain('a second Organization cannot see any of the sales history')
      expect(skipped?.detail).not.toContain('an earlier step that did not provide it')
    } finally {
      stack.stop()
    }
  })
})
