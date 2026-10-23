// A stand-in for the voice service, used only by the smoke test's own tests. It behaves like the
// real one for the calls the Lines steps make (add a Line, list Lines, one Organization per token)
// and each option breaks one thing, so a test can show the smoke test notices.

/** What can be broken in the voice fake. Every option is off by default. */
export type VoiceFakeOptions = {
  /** The list ignores the Organization in the token and returns every Line. */
  leak?: boolean
  /** The list always answers with no items. */
  emptyList?: boolean
  /** Adding a Line answers 500. */
  addFails?: boolean
}

type Line = { id: string; orgId: string; number: string }

/** A request handler for the fake voice. `orgOf` maps a bearer token to its Organization id. */
export function createVoiceFake(
  orgOf: (token: string) => string | undefined,
  options: VoiceFakeOptions = {}
) {
  const lines: Line[] = []
  let counter = 0
  const json = (body: unknown, status = 200) => Response.json(body, { status })
  const error = (status: number, code: string) => json({ error: { code } }, status)
  const publicLine = (line: Line) => ({
    id: line.id,
    number: line.number,
    country: 'US',
    label: null,
    state: 'active',
    assignment: { kind: 'unassigned' },
    createdAt: '2026-01-01T00:00:00.000Z',
    releasedAt: null,
  })

  return async (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url)
    if (pathname === '/readyz') {
      return json({ status: 'ok' })
    }
    const token = request.headers.get('authorization')?.replace(/^Bearer /, '')
    const orgId = token ? orgOf(token) : undefined
    if (!orgId) {
      return error(401, token ? 'auth.token_invalid' : 'auth.unauthenticated')
    }
    const one = /^\/v1\/lines\/([^/]+)$/.exec(pathname)
    if (one && request.method === 'GET') {
      const found = lines.find((line) => line.id === one[1])
      return found && (options.leak || found.orgId === orgId)
        ? json(publicLine(found))
        : error(404, 'line.not_found')
    }
    if (pathname !== '/v1/lines') {
      return error(404, 'request.not_found')
    }
    if (request.method === 'POST') {
      if (options.addFails) {
        return error(500, 'internal.unexpected')
      }
      counter += 1
      const line = {
        id: `line_${counter.toString(16).padStart(32, '0')}`,
        orgId,
        number: `+1555${counter.toString().padStart(7, '0')}`,
      }
      lines.push(line)
      return json(publicLine(line), 201)
    }
    if (request.method === 'GET') {
      const visible = options.emptyList
        ? []
        : lines.filter((line) => options.leak || line.orgId === orgId)
      return json({ items: visible.map(publicLine), nextCursor: null })
    }
    return error(405, 'request.method_not_allowed')
  }
}
