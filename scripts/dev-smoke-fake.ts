import { createPlaybookFake, type PlaybookFakeOptions } from './dev-smoke-playbook-fake.ts'

// A stand-in for auth, core, the playbook, the portal and the Mailpit API, used only by the smoke test's own
// tests. It behaves like the real services for the calls the smoke test makes (codes in a mailbox,
// refresh tokens that work once, separate Organizations) and each option breaks one thing, so a
// test can show the smoke test notices.

/** One request the fake saw. */
export type Seen = { method: string; path: string; body: string; key: string | null }

/** What can be broken in the fake. Every option is off by default. */
export type FakeOptions = {
  /** How auth answers a sign-up: `unavailable` is a stack started without a mailbox. */
  mail?: 'unavailable' | 'sent'
  /** Core answers a request with no token (a broken guard). */
  coreOpen?: boolean
  /** Which core list ignores the Organization in the token and returns every row. */
  leak?: 'invitations' | 'members' | 'organization' | 'teams'
  /** Refresh hands back the same refresh token. */
  reuseRefreshToken?: boolean
  /** Every access token for a user is the same string, as when two are issued in one second. */
  sameAccessToken?: boolean
  /** A refresh token that was already used is still accepted and nothing is revoked. */
  acceptOldRefresh?: boolean
  /** Reuse of an old refresh token is refused but the session itself is not ended. */
  reuseKeepsSession?: boolean
  /** The mailbox never receives the emails. */
  dropMail?: boolean
  /** The mailbox shows an email only this long after it was sent. */
  mailDelayMs?: number
  /** Every email is also sent to `evil-<address>`, which Mailpit's substring `to:` search matches. */
  staleMail?: boolean
  /** The mailbox search answers 500, or junk, or JSON without `messages`. */
  mailBroken?: '500' | 'junk' | 'no-messages'
  /** The verification email holds two codes, or none. */
  codes?: 'two' | 'none' | 'other-phrase'
  /** The Invitation email holds two links, or none. */
  links?: 'two' | 'none'
  /** Auth refuses every verification code. */
  rejectCode?: boolean
  /** Core's Invitation email links to another host. */
  wrongLinkHost?: boolean
  /** Core answers a revoke across Organizations with 204 instead of 404. */
  revokeAcrossOrganizations?: boolean
  /** Core answers a revoke across Organizations with 404 but another code. */
  revokeWrongCode?: boolean
  /** Core answers every DELETE of an Invitation with 404, even the owner's. */
  revokeNotFoundForEveryone?: boolean
  /** Core lets another Organization's token rename or delete a Team. */
  crossTeamWrite?: boolean
  /** Core lets another Organization's token change a member's role. */
  crossMemberWrite?: boolean
  /** Core revokes another Organization's Invitation but still answers 404. */
  silentCrossRevoke?: boolean
  /** Core answers every Team rename with 404, even for the owner. */
  teamRenameNotFoundForEveryone?: boolean
  /** What core says for its Organization's status and region. */
  coreStatus?: string
  coreRegion?: string
  /** Core renames another Organization's Team but still answers 404. */
  silentCrossTeamWrite?: boolean
  /** Core changes another Organization's member role but still answers 404. */
  silentCrossMemberWrite?: boolean
  /** Core lets another Organization's token delete a member. */
  crossMemberDelete?: boolean
  /** Core lets another Organization's token remove a Team member. */
  crossTeamMemberDelete?: boolean
  /** Core answers every Team delete with 404, even for the owner. */
  teamDeleteNotFoundForEveryone?: boolean
  /** Revoking an Invitation answers 204 but leaves it pending and listed. */
  revokeKeepsListed?: boolean
  /** Creating an Invitation answers 200, or says its state is something other than pending. */
  createInvitationAs200?: boolean
  invitationNotPending?: boolean
  /** The error code of a refused replay, and of the newest token after the reuse. */
  replayCode?: string
  newestCode?: string
  /** Every email is accompanied by a second one with another subject, or sent twice. */
  extraMail?: boolean
  duplicateMail?: boolean
  /** Core answers every Team route with 404, even for the owner. */
  teamsNotFoundForEveryone?: boolean
  /** Core takes the Organization from an `x-organization-id` header or `organizationId` query. */
  trustOrganizationHeader?: boolean
  /** What is broken in the playbook: see dev-smoke-playbook-fake.ts. */
  playbook?: PlaybookFakeOptions
}

type Mail = { id: string; to: string; subject: string; text: string; visibleAt: number }

/** Starts the five fake servers; `stop()` closes them. */
export function fakeStack(options: FakeOptions = {}) {
  const seen: Seen[] = []
  const mailbox: Mail[] = []
  const users = new Map<string, { password: string; orgId: string; userId: string }>()
  const attempts = new Map<
    string,
    { email: string; secret: string; code: string; password: string; name: string }
  >()
  const tokens = new Map<string, { sid: string; userId: string; usedAt?: number; child?: string }>()
  const revokedSessions = new Set<string>()
  const sessions = new Map<string, { orgId: string; userId: string }>()
  const members: { id: string; userId: string; orgId: string; role: string }[] = []
  const orgs = new Map<string, string>()
  const invitations: { id: string; orgId: string; email: string; state: string }[] = []
  const teams: { id: string; orgId: string; name: string }[] = []
  let counter = 0
  const next = (prefix: string) => `${prefix}_${++counter}_${crypto.randomUUID().slice(0, 8)}`
  const origins = { portal: '' }

  const json = (body: unknown, status = 200) => Response.json(body, { status })
  const error = (status: number, code: string) => json({ error: { code } }, status)

  const addMail = (to: string, subject: string, text: string) => {
    const visibleAt = Date.now() + (options.mailDelayMs ?? 0)
    mailbox.push({ id: next('msg'), to, subject, text, visibleAt })
    if (options.duplicateMail) {
      mailbox.push({ id: next('msg'), to, subject, text, visibleAt })
    }
    if (options.extraMail) {
      mailbox.push({
        id: next('msg'),
        to,
        subject: 'Welcome to Closeline',
        text: 'Welcome. Your Closeline verification code is 999999. Join: https://x.invalid/#invitation=aaaaaaaaaaaaaaaaaaaaaaaa',
        visibleAt,
      })
    }
    if (options.staleMail) {
      mailbox.push({
        id: next('msg'),
        to: `evil-${to}`,
        subject,
        text: 'Your Closeline verification code is 000000. Nothing else here.',
        visibleAt,
      })
    }
  }

  const issue = (userId: string, orgId: string, sid = next('ses'), parent?: string) => {
    const accessToken = options.sameAccessToken ? `at_${userId}_${sid}` : next('at')
    const refreshToken = next('rt')
    sessions.set(accessToken, { orgId, userId })
    tokens.set(refreshToken, { sid, userId })
    if (parent) {
      const old = tokens.get(parent)
      if (old) {
        old.usedAt = Date.now()
        old.child = refreshToken
      }
    }
    return {
      sessionId: sid,
      accessToken,
      accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      refreshToken,
      organization: { id: orgId, role: 'owner' },
    }
  }

  const auth = async (request: Request, url: URL, body: Record<string, unknown>) => {
    const path = url.pathname
    if (path === '/v1/client/sign-ups' && request.method === 'POST') {
      if (options.mail === 'unavailable') {
        return error(503, 'mail.unavailable')
      }
      const id = next('su')
      const secret = next('secret')
      const code = String(100_000 + Math.floor(Math.random() * 900_000))
      attempts.set(id, {
        email: String(body.email),
        secret,
        code,
        password: String(body.password),
        name: String(body.organizationName),
      })
      if (!options.dropMail) {
        const line =
          options.codes === 'none'
            ? 'Your Closeline verification code is in the app.'
            : options.codes === 'other-phrase'
              ? `Your code: ${code}`
              : options.codes === 'two'
                ? `Your Closeline verification code is ${code}. The old one was 654321.`
                : `Your Closeline verification code is ${code}.`
        addMail(String(body.email), 'Your Closeline verification code', line)
      }
      return json({
        id,
        kind: 'sign_up',
        step: { status: 'needs_email_code' },
        attemptSecret: secret,
      })
    }
    const verify = /^\/v1\/client\/sign-ups\/([^/]+)\/verify-email$/.exec(path)
    if (verify) {
      const attempt = attempts.get(verify[1] ?? '')
      if (!attempt || request.headers.get('x-tula-attempt') !== attempt.secret) {
        return error(401, 'auth.unauthenticated')
      }
      if (options.rejectCode || body.code !== attempt.code) {
        return error(422, 'verification.code_invalid')
      }
      const userId = next('usr')
      const orgId = next('org')
      users.set(attempt.email, { password: attempt.password, orgId, userId })
      orgs.set(orgId, attempt.name)
      members.push({ id: next('mem'), userId, orgId, role: 'owner' })
      return json({ id: verify[1], step: { status: 'complete' } })
    }
    if (path === '/v1/client/sign-ins' && request.method === 'POST') {
      const id = next('si')
      const secret = next('secret')
      attempts.set(id, {
        email: String(body.identifier),
        secret,
        code: '',
        password: '',
        name: '',
      })
      return json({
        id,
        kind: 'sign_in',
        step: { status: 'needs_password' },
        attemptSecret: secret,
      })
    }
    const password = /^\/v1\/client\/sign-ins\/([^/]+)\/password$/.exec(path)
    if (password) {
      const attempt = attempts.get(password[1] ?? '')
      const user = attempt ? users.get(attempt.email) : undefined
      if (!attempt || request.headers.get('x-tula-attempt') !== attempt.secret) {
        return error(401, 'auth.unauthenticated')
      }
      if (!user || user.password !== body.password) {
        return error(401, 'auth.invalid_credentials')
      }
      return json({
        id: password[1],
        step: { status: 'complete' },
        session: issue(user.userId, user.orgId),
      })
    }
    if (path === '/v1/client/sessions/refresh' && request.method === 'POST') {
      const token = String(body.refreshToken)
      const found = tokens.get(token)
      if (!found) {
        return error(401, 'session.invalid_token')
      }
      if (revokedSessions.has(found.sid)) {
        return error(401, options.newestCode ?? 'session.reuse_detected')
      }
      const user = [...users.values()].find((candidate) => candidate.userId === found.userId)
      if (!user) {
        return error(401, 'session.invalid_token')
      }
      if (found.usedAt !== undefined && !options.acceptOldRefresh) {
        const child = found.child ? tokens.get(found.child) : undefined
        const withinGrace = Date.now() - found.usedAt < 10_000
        if (!(withinGrace && child && child.usedAt === undefined)) {
          if (!options.reuseKeepsSession) {
            revokedSessions.add(found.sid)
          }
          return error(401, options.replayCode ?? 'session.reuse_detected')
        }
        const again = issue(user.userId, user.orgId, found.sid)
        return json({ ...again, refreshToken: found.child })
      }
      const issued = issue(user.userId, user.orgId, found.sid, token)
      return json(options.reuseRefreshToken ? { ...issued, refreshToken: token } : issued)
    }
    if (path === '/.well-known/jwks.json') {
      return json({ keys: [{ kty: 'OKP', alg: 'EdDSA', kid: 'k' }] })
    }
    return undefined
  }

  const core = async (request: Request, url: URL, body: Record<string, unknown>) => {
    const header = request.headers.get('authorization')
    const session = header ? sessions.get(header.replace(/^Bearer /, '')) : undefined
    if (options.coreOpen && url.pathname === '/v1/organization') {
      return json({ id: 'org_x' })
    }
    if (!session) {
      return error(401, header ? 'auth.token_invalid' : 'auth.unauthenticated')
    }
    let orgId = session.orgId
    if (options.trustOrganizationHeader) {
      orgId =
        request.headers.get('x-organization-id') ?? url.searchParams.get('organizationId') ?? orgId
    }
    const { pathname } = url
    const method = request.method
    if (pathname === '/v1/organization') {
      const shown = options.leak === 'organization' ? [...orgs.keys()][0] : orgId
      return json({
        id: shown,
        name: orgs.get(shown ?? '') ?? 'x',
        region: options.coreRegion ?? 'local',
        status: options.coreStatus ?? 'active',
      })
    }
    if (pathname === '/v1/members' && method === 'GET') {
      const rows = options.leak === 'members' ? members : members.filter((m) => m.orgId === orgId)
      return json({
        items: rows.map(({ id, userId, role }) => ({ id, userId, role })),
        nextCursor: null,
      })
    }
    const member = /^\/v1\/members\/([^/]+)$/.exec(pathname)
    if (member && method === 'DELETE') {
      const found = members.find(
        (m) => m.id === member[1] && (m.orgId === orgId || options.crossMemberDelete)
      )
      if (!found) {
        return error(404, 'member.not_found')
      }
      members.splice(members.indexOf(found), 1)
      return new Response(null, { status: 204 })
    }
    if (member && method === 'PATCH') {
      const found = members.find(
        (m) => m.id === member[1] && (m.orgId === orgId || options.crossMemberWrite)
      )
      if (!found) {
        if (options.silentCrossMemberWrite) {
          const other = members.find((m) => m.id === member[1])
          if (other) {
            other.role = String(body.role)
          }
        }
        return error(404, 'member.not_found')
      }
      found.role = String(body.role)
      return json({ id: found.id, userId: found.userId, role: found.role })
    }
    if (pathname === '/v1/invitations' && method === 'POST') {
      if (
        body.teamId !== undefined &&
        !teams.some((t) => t.id === body.teamId && t.orgId === orgId)
      ) {
        return error(404, 'team.not_found')
      }
      const id = next('inv')
      invitations.push({ id, orgId, email: String(body.email), state: 'pending' })
      if (!options.dropMail) {
        const host = options.wrongLinkHost ? 'https://elsewhere.invalid' : origins.portal
        const token = () =>
          `${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().slice(0, 8)}`
        const link = `${host}/sign-up#invitation=${token()}`
        const links =
          options.links === 'two'
            ? `${link}\n\nOr: ${host}/sign-up#invitation=${token()}`
            : options.links === 'none'
              ? 'ask your admin'
              : link
        addMail(
          String(body.email),
          'You are invited to join "Smoke" on Closeline',
          `You have been invited.\n\nAccept the invitation: ${links}\n\nBye.`
        )
      }
      return json(
        {
          id,
          email: body.email,
          role: body.role,
          state: options.invitationNotPending ? 'sent' : 'pending',
        },
        options.createInvitationAs200 ? 200 : 201
      )
    }
    if (pathname === '/v1/invitations' && method === 'GET') {
      const rows =
        options.leak === 'invitations' ? invitations : invitations.filter((i) => i.orgId === orgId)
      const state = url.searchParams.get('state') ?? 'pending'
      return json({ items: rows.filter((row) => row.state === state), nextCursor: null })
    }
    const revoke = /^\/v1\/invitations\/([^/]+)$/.exec(pathname)
    if (revoke && method === 'DELETE') {
      const found = invitations.find((i) => i.id === revoke[1] && i.orgId === orgId)
      if (options.revokeNotFoundForEveryone) {
        return error(404, 'invitation.not_found')
      }
      if (!found) {
        if (options.silentCrossRevoke) {
          const other = invitations.find((i) => i.id === revoke[1])
          if (other) {
            other.state = 'revoked'
          }
        }
        if (options.revokeAcrossOrganizations) {
          return new Response(null, { status: 204 })
        }
        return error(404, options.revokeWrongCode ? 'thing.gone' : 'invitation.not_found')
      }
      if (!options.revokeKeepsListed) {
        found.state = 'revoked'
      }
      return new Response(null, { status: 204 })
    }
    if (pathname.startsWith('/v1/teams') && options.teamsNotFoundForEveryone) {
      return error(404, 'team.not_found')
    }
    if (pathname === '/v1/teams' && method === 'POST') {
      const team = { id: next('team'), orgId, name: String(body.name) }
      teams.push(team)
      return json({ id: team.id, name: team.name }, 201)
    }
    if (pathname === '/v1/teams' && method === 'GET') {
      const rows = options.leak === 'teams' ? teams : teams.filter((t) => t.orgId === orgId)
      return json({ items: rows.map(({ id, name }) => ({ id, name })), nextCursor: null })
    }
    const team = /^\/v1\/teams\/([^/]+)$/.exec(pathname)
    if (team) {
      const found = teams.find(
        (t) => t.id === team[1] && (t.orgId === orgId || options.crossTeamWrite)
      )
      if (!found) {
        if (options.silentCrossTeamWrite && method === 'PATCH') {
          const other = teams.find((t) => t.id === team[1])
          if (other) {
            other.name = String(body.name)
          }
        }
        return error(404, 'team.not_found')
      }
      if (method === 'PATCH') {
        if (options.teamRenameNotFoundForEveryone) {
          return error(404, 'team.not_found')
        }
        found.name = String(body.name)
        return json({ id: found.id, name: found.name })
      }
      if (method === 'DELETE') {
        if (options.teamDeleteNotFoundForEveryone) {
          return error(404, 'team.not_found')
        }
        teams.splice(teams.indexOf(found), 1)
        return new Response(null, { status: 204 })
      }
    }
    const teamMemberDelete = /^\/v1\/teams\/([^/]+)\/members\/([^/]+)$/.exec(pathname)
    if (teamMemberDelete && method === 'DELETE') {
      if (
        !options.crossTeamMemberDelete &&
        !teams.some((t) => t.id === teamMemberDelete[1] && t.orgId === orgId)
      ) {
        return error(404, 'team.not_found')
      }
      return new Response(null, { status: 204 })
    }
    const teamMember = /^\/v1\/teams\/([^/]+)\/members$/.exec(pathname)
    if (teamMember && method === 'POST') {
      if (!teams.some((t) => t.id === teamMember[1] && t.orgId === orgId)) {
        return error(404, 'team.not_found')
      }
      if (!members.some((m) => m.id === body.membershipId && m.orgId === orgId)) {
        return error(404, 'member.not_found')
      }
      return json({})
    }
    return undefined
  }

  const mail = (url: URL) => {
    if (url.pathname === '/livez') {
      return new Response('ok')
    }
    if (url.pathname === '/api/v1/search') {
      if (options.mailBroken === '500') {
        return new Response('boom', { status: 500 })
      }
      if (options.mailBroken === 'junk') {
        return new Response('<html>not json</html>')
      }
      if (options.mailBroken === 'no-messages') {
        return json({ total: 0 })
      }
      const to = (url.searchParams.get('query') ?? '').replace(/^to:/, '')
      const now = Date.now()
      // Mailpit's `to:` is a substring match and the newest message comes first.
      const messages = mailbox
        .filter((m) => m.visibleAt <= now && m.to.includes(to))
        .reverse()
        .map((m) => ({ ID: m.id, Subject: m.subject, To: [{ Address: m.to }] }))
      return json({ messages, messages_count: messages.length })
    }
    const one = /^\/api\/v1\/message\/([^/]+)$/.exec(url.pathname)
    if (one) {
      const found = mailbox.find((m) => m.id === one[1])
      return found
        ? json({ ID: found.id, Subject: found.subject, Text: found.text, HTML: '' })
        : error(404, 'not_found')
    }
    return undefined
  }

  const playbookHandler = createPlaybookFake(
    (token) => sessions.get(token)?.orgId,
    options.playbook
  )
  const playbookServer = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async (request) => {
      const url = new URL(request.url)
      const multipart = (request.headers.get('content-type') ?? '').startsWith('multipart/')
      seen.push({
        method: request.method,
        path: url.pathname,
        body: multipart ? '(multipart)' : await request.clone().text(),
        key: request.headers.get('idempotency-key'),
      })
      return playbookHandler(request)
    },
  })

  const serve = (which: 'auth' | 'core' | 'portal' | 'mail') =>
    Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: async (request) => {
        const url = new URL(request.url)
        const raw = await request.text()
        seen.push({
          method: request.method,
          path: url.pathname,
          body: raw,
          key: request.headers.get('idempotency-key'),
        })
        if (url.pathname === '/readyz') {
          return json({ status: 'ok' })
        }
        if (which === 'portal') {
          return new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } })
        }
        let body: Record<string, unknown> = {}
        try {
          body = raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>)
        } catch {
          return error(400, 'request.invalid')
        }
        const answer =
          which === 'auth'
            ? await auth(request, url, body)
            : which === 'core'
              ? await core(request, url, body)
              : mail(url)
        return answer ?? new Response('{}', { status: 404 })
      },
    })

  const servers = {
    auth: serve('auth'),
    core: serve('core'),
    portal: serve('portal'),
    mail: serve('mail'),
    playbook: playbookServer,
  }
  const origin = (name: keyof typeof servers) => `http://127.0.0.1:${servers[name].port}`
  origins.portal = origin('portal')
  return {
    seen,
    mailbox,
    targets: {
      auth: origin('auth'),
      core: origin('core'),
      playbook: origin('playbook'),
      portal: origin('portal'),
      mail: origin('mail'),
    },
    stop: () => {
      for (const server of Object.values(servers)) {
        server.stop(true)
      }
    },
  }
}
