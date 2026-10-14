import { expect, test } from 'bun:test'
import { PACKAGE } from '../src/index'
import { BATCH_REQUESTS, BATCHES, measure, summary } from './measure'

// The pattern every benchmark follows: one operation, a stated batch size, an asserted budget.
// `measure` runs several batches after a warm-up and the test gates on the fastest, so one
// stalled batch (a cold or contended CI runner) cannot fail the gate; a real regression slows
// every batch and does. Replace the operation with the library's hot function, record the typical
// best batch here, and set the budget at about five times that, rounded up.
// Typical best batch: measure it on first run and write it here (ms for the batch size).
const BUDGET_MS = 50

test(`PACKAGE: the best of ${BATCHES} batches of ${BATCH_REQUESTS} calls is within ${BUDGET_MS} ms`, async () => {
  const result = await measure(() => PACKAGE.length)

  console.log(summary('package', result))
  expect(result.bestMs).toBeLessThan(BUDGET_MS)
})
