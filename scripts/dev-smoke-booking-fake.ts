// A stand-in for core's calendar, availability, Booking Type, routing and Booking routes, used only
// by the smoke test's own tests. It behaves like the real ones for the calls the Booking steps make
// and each option breaks one thing, so a test can show the smoke test notices.

/** What can be broken in the booking fake. Every option is off by default. */
export type BookingFakeOptions = {
  /** Completing the calendar connection is refused, whatever the code. */
  connectRefused?: boolean
  /** The connection reads `needs_reconnect` after it is made. */
  notHealthy?: boolean
  /** The public slots are always empty. */
  noSlots?: boolean
  /** A public slot also names the Rep. */
  slotNamesRep?: boolean
  /** The same key again books a second time (201) instead of replaying the first (200). */
  replayBooksAgain?: boolean
  /** A public Booking reads origin `member`. */
  originMember?: boolean
  /** A public Booking stays `pending`. */
  stayPending?: boolean
  /** A booked time can be booked again. */
  doubleBooking?: boolean
  /** The Booking list and get ignore the Organization in the token. */
  leak?: boolean
  /** A signed-in book accepts a Booking Type and Prospect of another Organization. */
  crossBook?: boolean
}

type Who = { orgId: string; memberId: string; role: string }
type BookingRow = {
  id: string
  orgId: string
  repId: string
  startsAt: string
  endsAt: string
  origin: string
  state: string
}

/** The fixed code core's local calendar stand-in accepts. */
export const LOCAL_CALENDAR_CODE = 'local-calendar-code'

/**
 * Builds the booking routes of the fake core. The handler answers a Response for a route it knows
 * and undefined for any other. `prospectOrg` says which Organization a Prospect belongs to.
 */
export function createBookingFake(
  prospectOrg: (id: string) => string | undefined,
  options: BookingFakeOptions = {}
) {
  const json = (body: unknown, status = 200) => Response.json(body, { status })
  const error = (status: number, code: string) => json({ error: { code } }, status)
  const connections = new Map<string, string>() // member id -> state
  const pending = new Set<string>()
  const hours = new Map<string, number>() // member id -> number of working days
  const types = new Map<string, { orgId: string; token: string }>()
  const rules = new Map<string, string>() // org id -> default rep member id
  const bookings: BookingRow[] = []
  const keyed = new Map<string, string>() // Idempotency-Key -> booking id
  let counter = 0
  const next = (prefix: string) => `${prefix}_${(++counter).toString(16).padStart(32, '0')}`

  const publicShape = (row: BookingRow) => ({
    id: row.id,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    mode: 'phone',
    joinUrl: null,
  })
  const fullShape = (row: BookingRow) => ({
    ...publicShape(row),
    bookingTypeId: 'bkt_x',
    repMembershipId: row.repId,
    prospectId: 'prs_x',
    state: row.state,
    origin: row.origin,
    routingDecisionId: null,
    createdAt: row.startsAt,
    cancelledAt: null,
  })
  const book = (orgId: string, repId: string, startsAt: string, origin: string, key: string) => {
    const known = keyed.get(key)
    const row0 = bookings.find((row) => row.id === known)
    if (row0 && !options.replayBooksAgain) {
      return { row: row0, replay: true }
    }
    const taken = bookings.some((row) => row.repId === repId && row.startsAt === startsAt)
    if (taken && !options.doubleBooking) {
      return undefined
    }
    const row: BookingRow = {
      id: next('bkg'),
      orgId,
      repId,
      startsAt,
      endsAt: new Date(Date.parse(startsAt) + 30 * 60_000).toISOString(),
      origin: options.originMember ? 'member' : origin,
      state: options.stayPending ? 'pending' : 'confirmed',
    }
    bookings.push(row)
    keyed.set(key, row.id)
    return { row, replay: false }
  }

  return async (
    request: Request,
    pathname: string,
    body: Record<string, unknown>,
    who: Who | undefined,
    search: URLSearchParams
  ): Promise<Response | undefined> => {
    const method = request.method
    const slots = /^\/v1\/public\/booking-types\/([^/]+)\/slots$/.exec(pathname)
    if (slots && method === 'GET') {
      const type = [...types.values()].find((candidate) => candidate.token === slots[1])
      if (!type) {
        return error(404, 'booking.type_not_found')
      }
      const repId = rules.get(type.orgId)
      const ready = repId !== undefined && connections.has(repId) && (hours.get(repId) ?? 0) > 0
      const from = Date.parse(search.get('from') ?? '')
      const items = []
      for (let hour = 1; ready && !options.noSlots && hour <= 6; hour++) {
        const start = new Date(Math.ceil(from / 3_600_000) * 3_600_000 + hour * 3_600_000)
        const startsAt = start.toISOString()
        const isTaken = bookings.some((row) => row.repId === repId && row.startsAt === startsAt)
        if (!isTaken) {
          items.push({
            startsAt,
            endsAt: new Date(start.getTime() + 30 * 60_000).toISOString(),
            ...(options.slotNamesRep ? { repMembershipId: repId } : {}),
          })
        }
      }
      return json({
        items,
        nextCursor: null,
        bookingType: { name: 'Smoke', lengthMinutes: 30, mode: 'phone' },
      })
    }
    const publicBook = /^\/v1\/public\/booking-types\/([^/]+)\/bookings$/.exec(pathname)
    if (publicBook && method === 'POST') {
      const type = [...types.values()].find((candidate) => candidate.token === publicBook[1])
      const repId = type ? rules.get(type.orgId) : undefined
      if (!type || !repId) {
        return error(404, 'booking.type_not_found')
      }
      const made = book(
        type.orgId,
        repId,
        String(body.startsAt),
        'public',
        request.headers.get('idempotency-key') ?? ''
      )
      return made
        ? json(publicShape(made.row), made.replay ? 200 : 201)
        : error(409, 'booking.slot_taken')
    }
    if (!who) {
      return undefined
    }
    if (pathname === '/v1/calendar-connection/start' && method === 'POST') {
      const state = next('cal')
      pending.add(state)
      return json({ authorizationUrl: 'https://calendar.invalid/consent', state })
    }
    if (pathname === '/v1/calendar-connection/complete' && method === 'POST') {
      const state = String(body.state)
      if (options.connectRefused || body.code !== LOCAL_CALENDAR_CODE || !pending.delete(state)) {
        return error(422, 'calendar.authorization_failed')
      }
      connections.set(who.memberId, options.notHealthy ? 'needs_reconnect' : 'healthy')
      return json({ membershipId: who.memberId, provider: 'google', state: 'healthy' })
    }
    if (pathname === '/v1/calendar-connection' && method === 'GET') {
      const state = connections.get(who.memberId)
      return state
        ? json({ membershipId: who.memberId, provider: 'google', state })
        : error(404, 'calendar.not_connected')
    }
    if (pathname === '/v1/availability' && method === 'PUT') {
      const days = Array.isArray(body.hours) ? body.hours.length : 0
      hours.set(who.memberId, days)
      return json({ ...body })
    }
    if (pathname === '/v1/availability' && method === 'GET') {
      return json({
        timeZone: 'UTC',
        hours: Array.from({ length: hours.get(who.memberId) ?? 0 }, () => ({ day: 'mon' })),
        dailyCap: null,
        awayUntil: null,
      })
    }
    if (pathname === '/v1/booking-types' && method === 'POST') {
      if (who.role !== 'owner' && who.role !== 'admin') {
        return error(403, 'auth.forbidden')
      }
      const id = next('bkt')
      const token = crypto.randomUUID().replaceAll('-', '')
      types.set(id, { orgId: who.orgId, token })
      return json({ id, ...body, state: 'active', publicToken: token }, 201)
    }
    if (pathname === '/v1/routing-rules' && method === 'POST') {
      const target = body.target as { membershipId?: string } | undefined
      rules.set(who.orgId, String(target?.membershipId))
      return json({ id: next('rul'), ...body, position: 1 }, 201)
    }
    if (pathname === '/v1/bookings' && method === 'GET') {
      const rows = bookings.filter((row) => options.leak || row.orgId === who.orgId)
      return json({ items: rows.map(fullShape), nextCursor: null })
    }
    const one = /^\/v1\/bookings\/([^/]+)$/.exec(pathname)
    if (one && method === 'GET') {
      const row = bookings.find((candidate) => candidate.id === one[1])
      return row && (options.leak || row.orgId === who.orgId)
        ? json(fullShape(row))
        : error(404, 'booking.not_found')
    }
    if (pathname === '/v1/bookings' && method === 'POST') {
      const type = types.get(String(body.bookingTypeId))
      if (!options.crossBook) {
        if (!type || type.orgId !== who.orgId) {
          return error(404, 'booking.type_not_found')
        }
        if (prospectOrg(String(body.prospectId)) !== who.orgId) {
          return error(404, 'prospect.not_found')
        }
      }
      const repId = rules.get(type?.orgId ?? who.orgId) ?? who.memberId
      const made = book(
        who.orgId,
        repId,
        String(body.startsAt),
        'member',
        request.headers.get('idempotency-key') ?? ''
      )
      return made ? json(fullShape(made.row), 201) : error(409, 'booking.slot_taken')
    }
    return undefined
  }
}
