// The Booking steps of `bun run dev:smoke`: a Rep connects core's local memory calendar and sets
// hours, the Owner makes a Booking Type and a default routing rule, then a Prospect books through
// the public link, over HTTP like the other steps. Core shows nothing of the calendar event, so the
// event itself is not checked (the Booking is, through the signed-in list). No token, link token or
// code is printed: every value is registered with `remember` the moment it exists.
import type { StepStatus } from './dev-smoke.ts'

/** The names of the Booking steps, in the order they run (after the Lines steps). */
export const BOOKING_STEPS = [
  'booking: the Rep connects the local calendar and it reads healthy',
  'booking: the Rep sets weekly hours',
  'booking: the Owner creates a Booking Type and a default routing rule for the Rep',
  'booking: public slots by the link token return times and name no Rep',
  'booking: a public booking answers 201 and the same key again 200 with the same Booking',
  'booking: the Booking is listed to the Owner as confirmed, origin public',
  'booking: the same time again with a new key is booking.slot_taken',
  'booking: a second Organization cannot see or book against the first',
] as const

/** The one code core's local calendar stand-in accepts (`LOCAL_CALENDAR_CODE` in core). */
const LOCAL_CALENDAR_CODE = 'local-calendar-code'

type Json = Record<string, unknown>
type Reply = { status: number; json: unknown }
type Outcome = { status: StepStatus; detail: string }
type Who = { token: string } | { problem: string }

/** What the steps need from the smoke run that calls them. */
export type BookingKit = {
  core: string
  call: (
    method: string,
    url: string,
    send?: { headers?: Record<string, string>; body?: unknown; once?: boolean }
  ) => Promise<Reply>
  step: (name: string, body: () => Promise<Outcome>) => Promise<StepStatus>
  remember: (...values: (string | null | undefined)[]) => void
  /** Makes up a value for this run and registers it so it can never be printed. */
  minted: (value: string) => string
  /** `status code` of a reply, with the code only if it has the contract's shape. */
  answered: (reply: Reply) => string
  runId: string
  /** A fresh access token for the Owner, the Rep and the second Organization's Owner; undefined when the run has no such user. */
  who: { owner: () => Promise<Who>; rep?: () => Promise<Who>; other?: () => Promise<Who> }
  /** The Rep's membership id. */
  repMembershipId?: string
}

const pass = (detail = ''): Outcome => ({ status: 'pass', detail })
const fail = (detail: string): Outcome => ({ status: 'fail', detail })
const skip = (detail: string): Outcome => ({ status: 'skip', detail })

const at = (value: unknown, ...path: string[]): unknown => {
  let here = value
  for (const key of path) {
    here = typeof here === 'object' && here !== null ? (here as Json)[key] : undefined
  }
  return here
}
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

const bearer = (token: string) => ({ authorization: `Bearer ${token}` })
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const

/** Runs the Booking steps and records one result for each. */
export async function runBookingSteps(kit: BookingKit): Promise<void> {
  const { call, remember, answered, runId } = kit
  const core = (path: string) => `${kit.core}${path}`
  const blocked = (name: string) => skip(`blocked by "${name}"`)
  const prospectEmail = kit.minted(`booker-${runId}@closeline-smoke.test`)
  let linkToken: string | undefined
  let startsAt: string | undefined
  let bookingId: string | undefined

  /** A token for one user, or the step outcome that says why there is none. */
  const tokenOf = async (make: (() => Promise<Who>) | undefined, why: string) => {
    if (!make) {
      return skip(why)
    }
    const found = await make()
    if ('problem' in found) {
      return fail(found.problem)
    }
    remember(found.token)
    return found.token
  }

  await kit.step(BOOKING_STEPS[0], async () => {
    const token = await tokenOf(kit.who.rep, 'blocked by the step that makes the Rep')
    if (typeof token !== 'string') {
      return token
    }
    const headers = bearer(token)
    const started = await call('POST', core('/v1/calendar-connection/start'), {
      headers,
      body: { provider: 'google' },
      once: true,
    })
    const state = text(at(started.json, 'state'))
    remember(state, text(at(started.json, 'authorizationUrl')), LOCAL_CALENDAR_CODE)
    if (started.status !== 200 || !state) {
      return fail(`POST /v1/calendar-connection/start answered ${answered(started)}`)
    }
    const done = await call('POST', core('/v1/calendar-connection/complete'), {
      headers,
      body: { state, code: LOCAL_CALENDAR_CODE },
      once: true,
    })
    if (done.status !== 200) {
      return fail(`POST /v1/calendar-connection/complete answered ${answered(done)}`)
    }
    const read = await call('GET', core('/v1/calendar-connection'), { headers })
    return read.status === 200 && at(read.json, 'state') === 'healthy'
      ? pass('started, completed with the local code, healthy')
      : fail(`GET /v1/calendar-connection answered ${answered(read)}, not 200 healthy`)
  })

  await kit.step(BOOKING_STEPS[1], async () => {
    const token = await tokenOf(kit.who.rep, 'blocked by the step that makes the Rep')
    if (typeof token !== 'string') {
      return token
    }
    const hours = DAYS.map((day) => ({ day, windows: [{ start: '00:00', end: '23:59' }] }))
    const headers = bearer(token)
    const set = await call('PUT', core('/v1/availability'), {
      headers,
      body: { timeZone: 'UTC', hours, dailyCap: null, awayUntil: null },
      once: true,
    })
    if (set.status !== 200) {
      return fail(`PUT /v1/availability answered ${answered(set)}`)
    }
    const read = await call('GET', core('/v1/availability'), { headers })
    const days = at(read.json, 'hours')
    return read.status === 200 && Array.isArray(days) && days.length === DAYS.length
      ? pass('UTC, every day, all day')
      : fail(`GET /v1/availability answered ${answered(read)} without the seven days`)
  })

  await kit.step(BOOKING_STEPS[2], async () => {
    if (!kit.repMembershipId) {
      return skip('blocked by the step that makes the Rep')
    }
    const token = await tokenOf(kit.who.owner, 'no Owner sign-in')
    if (typeof token !== 'string') {
      return token
    }
    const headers = (key: string) => ({
      ...bearer(token),
      'idempotency-key': `smoke-${runId}-${key}`,
    })
    const made = await call('POST', core('/v1/booking-types'), {
      headers: headers('booking-type'),
      body: {
        name: `Smoke ${runId}`,
        lengthMinutes: 30,
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 0,
        minimumNoticeMinutes: 0,
        mode: 'phone',
      },
      once: true,
    })
    const publicToken = text(at(made.json, 'publicToken'))
    remember(publicToken)
    if (made.status !== 201 || !publicToken) {
      return fail(`POST /v1/booking-types answered ${answered(made)}, not 201 with a link token`)
    }
    const rule = await call('POST', core('/v1/routing-rules'), {
      headers: headers('routing-rule'),
      body: {
        name: 'Default',
        conditions: {},
        target: { kind: 'rep', membershipId: kit.repMembershipId },
        isDefault: true,
      },
      once: true,
    })
    if (rule.status !== 201) {
      return fail(`POST /v1/routing-rules answered ${answered(rule)}`)
    }
    linkToken = publicToken
    return pass('201 and 201, the rule is the default and targets the Rep')
  })

  await kit.step(BOOKING_STEPS[3], async () => {
    if (!linkToken) {
      return blocked(BOOKING_STEPS[2])
    }
    const from = new Date()
    const to = new Date(from.getTime() + 3 * 86_400_000)
    const slots = await call(
      'GET',
      core(
        `/v1/public/booking-types/${linkToken}/slots?from=${from.toISOString()}&to=${to.toISOString()}`
      )
    )
    const items = at(slots.json, 'items')
    if (slots.status !== 200 || !Array.isArray(items)) {
      return fail(`GET .../slots answered ${answered(slots)}, not 200 with items`)
    }
    const first = text(at(items[0], 'startsAt'))
    if (!first) {
      return fail('the public slots are empty although the Rep has hours and a calendar')
    }
    const odd = items.find(
      (item) =>
        Object.keys(item as Json)
          .sort()
          .join() !== 'endsAt,startsAt'
    )
    if (odd !== undefined) {
      return fail('a public slot holds more than a start and an end')
    }
    startsAt = first
    return pass(`${items.length} free time(s), start and end only`)
  })

  /** One public booking, keyed. */
  const publicBook = (key: string, at: string) =>
    call('POST', core(`/v1/public/booking-types/${linkToken}/bookings`), {
      headers: { 'idempotency-key': `smoke-${runId}-${key}` },
      body: {
        name: 'Smoke Booker',
        email: prospectEmail,
        startsAt: at,
        timeZone: 'UTC',
        website: '',
      },
      once: true,
    })

  await kit.step(BOOKING_STEPS[4], async () => {
    if (!linkToken || !startsAt) {
      return blocked(BOOKING_STEPS[3])
    }
    const first = await publicBook('public-book', startsAt)
    const id = text(at(first.json, 'id'))
    if (first.status !== 201 || !id) {
      return fail(`the public booking answered ${answered(first)}, not 201`)
    }
    const replay = await publicBook('public-book', startsAt)
    if (replay.status !== 200 || text(at(replay.json, 'id')) !== id) {
      return fail(`the same key answered ${answered(replay)}, not 200 with the first Booking`)
    }
    bookingId = id
    remember(id)
    return pass('201, then 200 with the same Booking')
  })

  await kit.step(BOOKING_STEPS[5], async () => {
    if (!bookingId) {
      return blocked(BOOKING_STEPS[4])
    }
    const token = await tokenOf(kit.who.owner, 'no Owner sign-in')
    if (typeof token !== 'string') {
      return token
    }
    const listed = await call('GET', core('/v1/bookings'), { headers: bearer(token) })
    const items = at(listed.json, 'items')
    const found = Array.isArray(items) ? items.find((i) => at(i, 'id') === bookingId) : undefined
    if (listed.status !== 200 || found === undefined) {
      return fail(`GET /v1/bookings answered ${answered(listed)} without the new Booking`)
    }
    if (at(found, 'origin') !== 'public' || at(found, 'state') !== 'confirmed') {
      return fail('the listed Booking is not confirmed with origin public')
    }
    // Core has no route that shows the calendar event, and the memory calendar is core's own.
    return pass('confirmed, origin public (core shows no calendar event, so none is checked)')
  })

  await kit.step(BOOKING_STEPS[6], async () => {
    if (!linkToken || !startsAt || !bookingId) {
      return blocked(BOOKING_STEPS[4])
    }
    const again = await publicBook('public-book-again', startsAt)
    return again.status === 409 && answered(again).endsWith('booking.slot_taken')
      ? pass('409 booking.slot_taken')
      : fail(`the same time again answered ${answered(again)}, not 409 booking.slot_taken`)
  })

  await kit.step(BOOKING_STEPS[7], async () => {
    if (!bookingId || !startsAt) {
      return blocked(BOOKING_STEPS[5])
    }
    const first = await tokenOf(kit.who.owner, 'no Owner sign-in')
    const other = await tokenOf(
      kit.who.other,
      'blocked by the sales-history step that makes the second Organization'
    )
    if (typeof first !== 'string') {
      return first
    }
    if (typeof other !== 'string') {
      return other
    }
    const theirs = bearer(other)
    const listed = await call('GET', core('/v1/bookings'), { headers: theirs })
    const items = at(listed.json, 'items')
    if (listed.status !== 200 || !Array.isArray(items) || items.length > 0) {
      return fail(
        `GET /v1/bookings answered ${answered(listed)} with rows for the second Organization`
      )
    }
    const read = await call('GET', core(`/v1/bookings/${bookingId}`), { headers: theirs })
    if (read.status !== 404 || !answered(read).endsWith('booking.not_found')) {
      return fail(
        `the second Organization reading the Booking answered ${answered(read)}, not 404 booking.not_found`
      )
    }
    // The second Organization's own Booking Type and Prospect, offered by the first Organization.
    const type = await call('POST', core('/v1/booking-types'), {
      headers: { ...theirs, 'idempotency-key': `smoke-${runId}-second-type` },
      body: {
        name: `Second ${runId}`,
        lengthMinutes: 30,
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 0,
        minimumNoticeMinutes: 0,
        mode: 'phone',
      },
      once: true,
    })
    const prospect = await call('POST', core('/v1/prospects'), {
      headers: { ...theirs, 'idempotency-key': `smoke-${runId}-second-prospect` },
      body: {
        firstName: 'Second',
        lastName: `Booker ${runId}`,
        email: kit.minted(`second-booker-${runId}@closeline-smoke.test`),
      },
      once: true,
    })
    const typeId = text(at(type.json, 'id'))
    const prospectId = text(at(prospect.json, 'id'))
    remember(text(at(type.json, 'publicToken')), typeId, prospectId)
    if (type.status !== 201 || !typeId || prospect.status !== 201 || !prospectId) {
      return fail(
        `the second Organization could not make its Booking Type and Prospect (${type.status}, ${prospect.status})`
      )
    }
    const crossed = await call('POST', core('/v1/bookings'), {
      headers: { ...bearer(first), 'idempotency-key': `smoke-${runId}-cross-book` },
      body: { bookingTypeId: typeId, prospectId, startsAt },
      once: true,
    })
    if (crossed.status !== 404) {
      return fail(
        `booking with the second Organization data answered ${answered(crossed)}, not 404`
      )
    }
    const after = await call('GET', core('/v1/bookings'), { headers: theirs })
    const rows = at(after.json, 'items')
    return after.status === 200 && Array.isArray(rows) && rows.length === 0
      ? pass('empty list, 404 booking.not_found, and a cross-Organization book answers 404')
      : fail('the second Organization now holds a Booking after the refused book')
  })
}
