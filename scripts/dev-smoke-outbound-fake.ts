// A stand-in for outbound's Mailbox routes, used only by the smoke test's own tests. It plays the
// connect, complete and test-send calls the Mailbox steps make; each option breaks one thing, so a
// test can show the smoke test notices.

/** What can be broken in the outbound fake. Every option is off by default. */
export type OutboundFakeOptions = {
  /** Outbound has no Mailbox routes at all: connect answers 404 request.not_found. */
  noMailbox?: boolean
  /** The test-send route does not exist yet: it answers 404 request.not_found. */
  noTestSend?: boolean
  /** The test-send route answers 502. */
  sendFails?: boolean
  /** The test-send route answers 200 but sends nothing. */
  notDelivered?: boolean
  /** Completing the connection answers 500. */
  connectFails?: boolean
}

/** A request handler for the fake outbound. */
export function createOutboundFake(config: {
  orgOf: (token: string) => string | undefined
  /** The fake Google provider's origin and the portal's, for the authorization URL. */
  googleOrigin: () => string
  portalOrigin: () => string
  /** Called with the recipient when a message is "sent" through the fake provider. */
  deliver: (to: string) => void
  options?: OutboundFakeOptions
}) {
  const options = config.options ?? {}
  const json = (body: unknown, status = 200) => Response.json(body, { status })
  const error = (status: number, code: string) => json({ error: { code } }, status)
  const mailboxes = new Set<string>()
  let counter = 0

  return async (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url)
    if (pathname === '/readyz') {
      return json({ status: 'ok' })
    }
    const token = request.headers.get('authorization')?.replace(/^Bearer /, '')
    if (!token || !config.orgOf(token)) {
      return error(401, token ? 'auth.token_invalid' : 'auth.unauthenticated')
    }
    if (options.noMailbox && pathname.startsWith('/v1/mailboxes')) {
      return error(404, 'request.not_found')
    }
    if (request.method === 'POST' && pathname === '/v1/mailboxes/connect') {
      const url = new URL(`${config.googleOrigin()}/authorize`)
      url.searchParams.set('redirect_uri', `${config.portalOrigin()}/mailboxes/connect/callback`)
      url.searchParams.set('access_type', 'offline')
      url.searchParams.set('state', crypto.randomUUID())
      return json({ authorizationUrl: url.toString(), expiresAt: '2026-01-01T00:10:00.000Z' }, 201)
    }
    if (request.method === 'POST' && pathname === '/v1/mailboxes/connect/complete') {
      if (options.connectFails) {
        return error(500, 'internal.unexpected')
      }
      counter += 1
      const id = `mbx_${counter.toString(16).padStart(32, '0')}`
      mailboxes.add(id)
      return json({ id, provider: 'gmail', state: 'warming' }, 201)
    }
    const send = /^\/v1\/mailboxes\/([^/]+)\/test-send$/.exec(pathname)
    if (send && request.method === 'POST' && !options.noTestSend) {
      if (!mailboxes.has(send[1] ?? '')) {
        return error(404, 'mailbox.not_found')
      }
      if (options.sendFails) {
        return error(502, 'mailbox.provider_unavailable')
      }
      const { to } = (await request.json()) as { to: string }
      if (!options.notDelivered) {
        config.deliver(to)
      }
      return json({ providerMessageId: 'fake' })
    }
    return error(404, 'request.not_found')
  }
}
