import { describe, expect, test } from 'bun:test'
import {
  exitCodeFor,
  formatResult,
  runSmoke,
  SALES_HISTORY_STEPS,
  type StepResult,
  silentWav,
} from './dev-smoke.ts'
import { type FakeOptions, fakeStack } from './dev-smoke-fake.ts'
import type { PlaybookFakeOptions } from './dev-smoke-playbook-fake.ts'

const by = (results: StepResult[], name: string) => results.find((result) => result.name === name)
const fast = {
  timeoutMs: 1_000,
  mailWaitMs: 400,
  mailIntervalMs: 20,
  playbookWaitMs: 300,
  playbookIntervalMs: 10,
}

async function run(playbook: PlaybookFakeOptions = {}, extra: Partial<FakeOptions> = {}) {
  const stack = fakeStack({ ...extra, playbook })
  try {
    const results = await runSmoke(stack.targets, fast)
    return { stack, results }
  } finally {
    stack.stop()
  }
}

/** The one step that a broken playbook must fail. */
async function failsAt(playbook: PlaybookFakeOptions, step: (typeof SALES_HISTORY_STEPS)[number]) {
  const { results } = await run(playbook)
  const found = by(results, step)
  expect(found?.status).toBe('fail')
  expect(exitCodeFor(results)).toBe(1)
  return found?.detail ?? ''
}

describe('the sales-history steps against a healthy playbook', () => {
  test('every step passes and none is skipped, so --strict is green', async () => {
    const { results } = await run()
    for (const name of SALES_HISTORY_STEPS) {
      expect(by(results, name)?.status).toBe('pass')
    }
    expect(by(results, 'playbook is ready')?.status).toBe('pass')
    expect(results.filter((result) => result.status !== 'pass')).toEqual([])
    expect(exitCodeFor(results, true)).toBe(0)
  })

  test('the steps run after sign-in, in the order the list gives', async () => {
    const { results } = await run()
    const names = results.map((result) => result.name)
    const at = SALES_HISTORY_STEPS.map((name) => names.indexOf(name))
    expect(at).toEqual([...at].sort((a, b) => a - b))
    expect(at[0]).toBeGreaterThan(names.indexOf('sign in'))
  })

  test('an upload sends the Deal and the Rep before the file, once, with its own key', async () => {
    const stack = fakeStack()
    const parts: { path: string; names: string[]; key: string | null }[] = []
    const wrapped = (async (input: string | Request | URL, init?: RequestInit) => {
      const body = init?.body
      if (body instanceof FormData) {
        parts.push({
          path: new URL(String(input)).pathname,
          names: [...body.keys()],
          key: new Headers(init?.headers).get('idempotency-key'),
        })
      }
      return fetch(input, init)
    }) as typeof fetch
    try {
      await runSmoke(stack.targets, { ...fast, fetchImpl: wrapped })
    } finally {
      stack.stop()
    }
    const calls = parts.filter((part) => part.path === '/v1/playbook/calls')
    // The refused try, the Transcript, the Recording and the second Organization own Call.
    expect(calls).toHaveLength(4)
    for (const part of calls) {
      expect(part.names.at(-1)).toBe('file')
      expect(part.names).toContain('dealId')
    }
    expect(calls[1]?.names).toEqual(['dealId', 'rep', 'file'])
    expect(parts.filter((part) => part.path === '/v1/playbook/deal-imports')).toHaveLength(2)
    const keys = parts.map((part) => part.key)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys.every((key) => key !== null && key.length >= 16)).toBe(true)
  })

  test('the Recording is a real WAV file, one second of 8 kHz mono PCM', () => {
    const wav = silentWav()
    const text = (from: number, to: number) => new TextDecoder().decode(wav.slice(from, to))
    expect([text(0, 4), text(8, 12), text(12, 16), text(36, 40)]).toEqual([
      'RIFF',
      'WAVE',
      'fmt ',
      'data',
    ])
    expect(wav.length).toBe(44 + 8000 * 2)
    expect(new DataView(wav.buffer).getUint32(24, true)).toBe(8000)
  })

  test('the report holds no Call, Deal or import id and no customer deal id', async () => {
    const { stack, results } = await run()
    const report = results.map(formatResult).join('\n')
    expect(report).not.toMatch(/(call|deal|dimp)_[0-9a-f]{8,}/)
    expect(report).not.toMatch(/smoke-[0-9a-f]{12}-[abc]/)
    expect(stack.seen.some((call) => call.path.startsWith('/v1/playbook/'))).toBe(true)
  })
})

describe('a playbook that is broken is noticed', () => {
  test('a Call accepted before the rights are confirmed fails the confirmation step', async () => {
    const detail = await failsAt({ noRightsGate: true }, 'confirm the rights wording')
    expect(detail).toContain('before the confirmation')
  })

  test('a Transcript that never leaves processing fails after a bounded wait', async () => {
    const started = Date.now()
    const detail = await failsAt(
      { transcriptStuck: true },
      'the Transcript is processed into Moments, not yet in search'
    )
    expect(detail).toContain('not finished within')
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  test('a Transcript that fails says why, in the contract failure word', async () => {
    const detail = await failsAt(
      { transcriptFails: true },
      'the Transcript is processed into Moments, not yet in search'
    )
    expect(detail).toContain('transcription_failed')
  })

  test('the Call of an open Deal that is in search fails', async () => {
    await failsAt(
      { openInSearch: true },
      'the Transcript is processed into Moments, not yet in search'
    )
  })

  test('a won Deal whose Call never reaches search fails after a bounded wait', async () => {
    const detail = await failsAt(
      { notInSearch: true },
      'the Outcome reaches the Moments and the Call is in search'
    )
    expect(detail).toContain('did not reach search')
  })

  test('a first Call that creates no Deal fails', async () => {
    await failsAt({ noDealForCall: true }, 'the first Call created its Deal, open')
  })

  test('a Recording that fails transcription fails the step', async () => {
    const detail = await failsAt({ recordingFails: true }, 'the Recording is transcribed')
    expect(detail).toContain('failed')
  })

  test('a Recording taken for a Transcript fails the upload step', async () => {
    await failsAt({ recordingAsTranscript: true }, 'upload a Recording')
  })

  test('an import that rejects a row fails the count check', async () => {
    const detail = await failsAt(
      { importRejectsOne: true },
      'the import is applied and the Deal has its Outcome'
    )
    expect(detail).toContain('3/2/1')
  })

  test('an import that never finishes fails after a bounded wait', async () => {
    const detail = await failsAt(
      { importStuck: true },
      'the import is applied and the Deal has its Outcome'
    )
    expect(detail).toContain('not finished within')
  })

  test('an import that leaves the Outcome of the Transcript Deal open fails', async () => {
    const detail = await failsAt(
      { importKeepsOutcome: true },
      'the import is applied and the Deal has its Outcome'
    )
    expect(detail).toContain('open')
  })

  test.each([
    ['leak', { leak: true }],
    ['sharedRights', { sharedRights: true }],
    ['crossLookup', { crossLookup: true }],
    ['crossDelete', { crossDelete: true }],
  ] as const)('a playbook with %s fails the second Organization check', async (_name, broken) => {
    await failsAt(broken, 'a second Organization cannot see any of the sales history')
  })

  test('a delete that leaves the Call readable fails', async () => {
    await failsAt({ deleteKeeps: true }, 'delete the Call and it is gone')
  })

  test('a deleted Call that stays in the list fails', async () => {
    const detail = await failsAt({ deletedStaysListed: true }, 'delete the Call and it is gone')
    expect(detail).toContain('still in the list')
  })

  test('deleting a deleted Call again must still answer 200', async () => {
    await failsAt({ deleteAgainNotFound: true }, 'delete the Call and it is gone')
  })

  test('a playbook that is down fails its readiness step', async () => {
    const stack = fakeStack()
    const targets = { ...stack.targets, playbook: 'http://127.0.0.1:1' }
    try {
      const results = await runSmoke(targets, { ...fast, timeoutMs: 200 })
      expect(by(results, 'playbook is ready')?.status).toBe('fail')
      expect(exitCodeFor(results)).toBe(1)
    } finally {
      stack.stop()
    }
  })

  test('a failed rights step blocks the uploads instead of hiding behind them', async () => {
    const { results } = await run({ noRightsGate: true })
    const upload = by(results, 'upload a Transcript')
    // The rights step failed, so the dependent step is skipped and --strict still fails.
    expect(upload?.status).toBe('skip')
    expect(upload?.detail).toContain('blocked by "confirm the rights wording" (failed)')
    expect(exitCodeFor(results, true)).toBe(1)
  })
})

describe('review follow-ups', () => {
  test('lists that always answer empty fail the second Organization check', async () => {
    const detail = await failsAt(
      { emptyLists: true },
      'a second Organization cannot see any of the sales history'
    )
    expect(detail).toContain('own')
  })

  test('a wait that is past its deadline stops before another look', async () => {
    const stack = fakeStack({ playbook: { transcriptStuck: true } })
    try {
      let okReads = 0
      const counting = (async (input: string | Request | URL, init?: RequestInit) => {
        const response = await fetch(input, init)
        const path = new URL(String(input)).pathname
        if ((init?.method ?? 'GET') === 'GET' && /^\/v1\/playbook\/calls\/call_/.test(path)) {
          if (response.status === 200) {
            okReads += 1
          }
        }
        return response
      }) as typeof fetch
      const results = await runSmoke(stack.targets, {
        ...fast,
        playbookWaitMs: 0,
        fetchImpl: counting,
      })
      const found = by(results, 'the Transcript is processed into Moments, not yet in search')
      expect(found?.status).toBe('fail')
      expect(found?.detail).toContain('not finished within')
      // Only the two plain reads (the unchanged check and the read after the delete) may succeed;
      // before the fix each of the three waits also read once before giving up.
      expect(okReads).toBeLessThanOrEqual(2)
    } finally {
      stack.stop()
    }
  })
})
