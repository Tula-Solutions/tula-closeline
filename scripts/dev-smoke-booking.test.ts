// The Booking steps of the smoke test, each shown able to fail: the booking fake breaks one thing
// and the matching step must go red. See hub issue 221.
import './test-guard.ts'
import { describe, expect, test } from 'bun:test'
import { exitCodeFor, runSmoke, type StepResult } from './dev-smoke.ts'
import { BOOKING_STEPS } from './dev-smoke-booking.ts'
import type { BookingFakeOptions } from './dev-smoke-booking-fake.ts'
import { LOCAL_CALENDAR_CODE } from './dev-smoke-booking-fake.ts'
import { fakeStack } from './dev-smoke-fake.ts'

const by = (results: StepResult[], name: string) => results.find((result) => result.name === name)
const fast = {
  timeoutMs: 1_000,
  mailWaitMs: 400,
  mailIntervalMs: 20,
  playbookWaitMs: 400,
  playbookIntervalMs: 10,
}

async function run(booking: BookingFakeOptions = {}) {
  const stack = fakeStack({ booking })
  try {
    return { stack, results: await runSmoke(stack.targets, fast) }
  } finally {
    stack.stop()
  }
}

describe('the Booking steps against a healthy core', () => {
  test('every Booking step passes, so --strict is green', async () => {
    const { results } = await run()
    for (const name of BOOKING_STEPS) {
      expect(by(results, name)?.status).toBe('pass')
    }
    expect(results.filter((result) => result.status !== 'pass')).toEqual([])
    expect(exitCodeFor(results, true)).toBe(0)
  })

  test('no result detail holds the local calendar code or a link token', async () => {
    const { results } = await run()
    const printed = JSON.stringify(results)
    expect(printed).not.toContain(LOCAL_CALENDAR_CODE)
    expect(printed).not.toMatch(/publicToken/)
  })
})

describe('the Booking steps against a broken core', () => {
  const cases: [string, BookingFakeOptions, number][] = [
    ['a refused calendar grant', { connectRefused: true }, 0],
    ['a connection that is not healthy', { notHealthy: true }, 0],
    ['empty public slots', { noSlots: true }, 3],
    ['a slot that names the Rep', { slotNamesRep: true }, 3],
    ['a replay that books again', { replayBooksAgain: true }, 4],
    ['a Booking that reads origin member', { originMember: true }, 5],
    ['a Booking that stays pending', { stayPending: true }, 5],
    ['a time that can be booked twice', { doubleBooking: true }, 6],
    ['a list that ignores the Organization', { leak: true }, 7],
    ['a book that crosses Organizations', { crossBook: true }, 7],
  ]
  for (const [label, options, index] of cases) {
    test(`${label} fails ${BOOKING_STEPS[index]}`, async () => {
      const { results } = await run(options)
      expect(by(results, BOOKING_STEPS[index] as string)?.status).toBe('fail')
      expect(exitCodeFor(results)).toBe(1)
    })
  }
})
