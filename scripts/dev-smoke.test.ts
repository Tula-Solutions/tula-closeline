import { describe, expect, test } from 'bun:test'
import {
  ACCOUNT_STEPS,
  exitCodeFor,
  formatResult,
  parseSmokeArgs,
  runSmoke,
  type StepResult,
} from './dev-smoke.ts'

type Seen = { method: string; path: string; body: string }

type FakeOptions = {
  /** How auth answers a sign-up: `unavailable` is a stack started without a mailbox. */
  mail?: 'unavailable' | 'sent'
  /** Core answers a request with no token (a broken guard). */
  coreOpen?: boolean
  /** Which core list ignores the Organization in the token and returns every row. */
  leak?: 'invitations' | 'members' | 'organization'
  /** Refresh hands back the same refresh token. */
  reuseRefreshToken?: boolean
  /** Every access token for a user is the same string, as when two are issued in one second. */
  sameAccessToken?: boolean
  /** The mailbox never receives the emails. */
  dropMail?: boolean
  /** Auth refuses every verification code. */
  rejectCode?: boolean
  /** Core's Invitation email links to another host. */
  wrongLinkHost?: boolean
  /** Core refuses to revoke across Organizations with 204 instead of 404. */
  revokeAcrossOrganizations?: boolean
}

type Mail = { id: string; to: string; subject: string; text: string }

/**
 * A stand-in for auth, core, the portal and the Mailpit API, with real behaviour for the calls the
 * smoke test makes: codes in a mailbox, one-use refresh tokens, and Organizations that are
 * separate unless an option makes core leak.
 */
function fakeStack(options: FakeOptions = {}) {
  const seen: Seen[] = []
  const mailbox: Mail[] = []
  const users = new Map<string, { password: string; orgId: string; userId: string; ok: boolean }>()
  const attempts = new Map<
    string,
    { email: string; secret: string; code: string; password: string; name: string }
  >()
  const spentRefresh = new Set<string>()
  const refreshOwner = new Map<string, string>()
  const sessions = new Map<string, { orgId: string; userId: string }>()
  const members: { id: string; userId: string; orgId: string; role: string }[] = []
  const orgs = new Map<string, string>()
  const invitations: { id: string; orgId: string; email: string; state: string }[] = []
  let counter = 0
  const next = (prefix: string) => `${prefix}_${++counter}_${crypto.randomUUID().slice(0, 8)}`
  const coreTargets = { portal: '' }

  const json = (body: unknown, status = 200) => Response.json(body, { status })
  const error = (status: number, code: string) => json({ error: { code } }, status)

  const issue = (userId: string, orgId: string) => {
    const accessToken = options.sameAccessToken ? `at_${userId}` : next('at')
    const refreshToken = next('rt')
    sessions.set(accessToken, { orgId, userId })
    refreshOwner.set(refreshToken, userId)
    return {
      sessionId: next('ses'),
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
        mailbox.push({
          id: next('msg'),
          to: String(body.email),
          subject: 'Your Closeline verification code',
          text: `Your Closeline verification code is ${code}.`,
        })
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
      users.set(attempt.email, { password: attempt.password, orgId, userId, ok: true })
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
      const userId = refreshOwner.get(token)
      if (!userId || spentRefresh.has(token)) {
        return error(401, 'auth.token_invalid')
      }
      spentRefresh.add(token)
      const user = [...users.values()].find((candidate) => candidate.userId === userId)
      if (!user) {
        return error(401, 'auth.token_invalid')
      }
      const issued = issue(userId, user.orgId)
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
    const { orgId } = session
    if (url.pathname === '/v1/organization') {
      const shown = options.leak === 'organization' ? [...orgs.keys()][0] : orgId
      return json({
        id: shown,
        name: orgs.get(shown ?? '') ?? 'x',
        region: 'local',
        status: 'active',
      })
    }
    if (url.pathname === '/v1/members') {
      const rows = options.leak === 'members' ? members : members.filter((m) => m.orgId === orgId)
      return json({
        items: rows.map(({ id, userId, role }) => ({ id, userId, role })),
        nextCursor: null,
      })
    }
    if (url.pathname === '/v1/invitations' && request.method === 'POST') {
      const id = next('inv')
      invitations.push({ id, orgId, email: String(body.email), state: 'pending' })
      if (!options.dropMail) {
        const host = options.wrongLinkHost ? 'https://elsewhere.invalid' : coreTargets.portal
        mailbox.push({
          id: next('msg'),
          to: String(body.email),
          subject: 'You are invited to join "Smoke" on Closeline',
          text: `You have been invited.\n\nAccept the invitation: ${host}/sign-up#invitation=${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().slice(0, 8)}\n\nBye.`,
        })
      }
      return json({ id, email: body.email, role: body.role, state: 'pending' }, 201)
    }
    if (url.pathname === '/v1/invitations' && request.method === 'GET') {
      const rows =
        options.leak === 'invitations' ? invitations : invitations.filter((i) => i.orgId === orgId)
      return json({ items: rows, nextCursor: null })
    }
    const revoke = /^\/v1\/invitations\/([^/]+)$/.exec(url.pathname)
    if (revoke && request.method === 'DELETE') {
      const found = invitations.find((i) => i.id === revoke[1] && i.orgId === orgId)
      if (!found) {
        return options.revokeAcrossOrganizations
          ? new Response(null, { status: 204 })
          : error(404, 'invitation.not_found')
      }
      found.state = 'revoked'
      return new Response(null, { status: 204 })
    }
    return undefined
  }

  const mail = (url: URL) => {
    if (url.pathname === '/livez') {
      return new Response('ok')
    }
    if (url.pathname === '/api/v1/search') {
      const to = (url.searchParams.get('query') ?? '').replace(/^to:/, '')
      const messages = mailbox
        .filter((m) => m.to === to)
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

  const serve = (which: 'auth' | 'core' | 'portal' | 'mail') =>
    Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: async (request) => {
        const url = new URL(request.url)
        const raw = await request.text()
        seen.push({ method: request.method, path: url.pathname, body: raw })
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
  }
  const origin = (name: keyof typeof servers) => `http://127.0.0.1:${servers[name].port}`
  coreTargets.portal = origin('portal')
  return {
    seen,
    mailbox,
    targets: {
      auth: origin('auth'),
      core: origin('core'),
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

const by = (results: StepResult[], name: string) => results.find((result) => result.name === name)
const fast = { timeoutMs: 1_000, mailWaitMs: 400, mailIntervalMs: 20 }

async function run(options: FakeOptions = {}, extra: Parameters<typeof runSmoke>[1] = {}) {
  const stack = fakeStack(options)
  try {
    const results = await runSmoke(stack.targets, { ...fast, ...extra })
    return { stack, results }
  } finally {
    stack.stop()
  }
}

describe('runSmoke against a healthy stack', () => {
  test('every step passes and none is skipped, so --strict is green', async () => {
    const { results } = await run()
    expect(results.filter((result) => result.status !== 'pass')).toEqual([])
    for (const name of ACCOUNT_STEPS) {
      expect(by(results, name)?.status).toBe('pass')
    }
    expect(exitCodeFor(results, true)).toBe(0)
  })

  test('the mailbox is checked for readiness', async () => {
    const { results } = await run()
    expect(by(results, 'the mailbox is ready')?.status).toBe('pass')
  })

  test('each sign-up is sent once and every refresh token is used once', async () => {
    const { stack } = await run()
    expect(stack.seen.filter((call) => call.path === '/v1/client/sign-ups')).toHaveLength(2)
    expect(stack.seen.filter((call) => call.path === '/v1/client/sessions/refresh')).toHaveLength(1)
    expect(
      stack.seen.filter((call) => call.path === '/v1/invitations' && call.method === 'POST')
    ).toHaveLength(1)
  })

  test('the sign-up uses a reserved .test domain and a fresh address each run', async () => {
    const first = await run()
    const second = await run()
    const emails = [first, second].map(({ stack }) => {
      const body = stack.seen.find((call) => call.path === '/v1/client/sign-ups')?.body ?? '{}'
      return (JSON.parse(body) as { email: string }).email
    })
    expect(emails[0]).toMatch(/^smoke-[0-9a-f]+@[a-z-]+\.test$/)
    expect(emails[0]).not.toBe(emails[1])
  })

  test('never puts a password, code, token, link or address in the report', async () => {
    const { stack, results } = await run()
    const report = results.map(formatResult).join('\n')
    const signUp = JSON.parse(
      stack.seen.find((call) => call.path === '/v1/client/sign-ups')?.body ?? '{}'
    ) as { email: string; password: string }
    const secrets = [
      signUp.password,
      signUp.email,
      ...stack.mailbox.flatMap((mail) => [
        mail.to,
        /\d{6}/.exec(mail.text)?.[0] ?? '',
        /#invitation=(\S+)/.exec(mail.text)?.[1] ?? '',
      ]),
    ].filter((value) => value !== '')
    expect(secrets.length).toBeGreaterThan(4)
    for (const secret of secrets) {
      expect(report).not.toContain(secret)
    }
    expect(report).not.toMatch(/bearer|invitation=|at_\d|rt_\d/i)
  })
})

describe('runSmoke without a mailbox for auth', () => {
  test('a 503 mail.unavailable skips the sign-up and every step that needs it, with the reason', async () => {
    const { stack, results } = await run({ mail: 'unavailable' })
    expect(results.filter((result) => result.status === 'fail')).toEqual([])
    const signUp = by(results, 'sign up (starts, emails a code)')
    expect(signUp?.status).toBe('skip')
    expect(signUp?.detail).toContain('mail.unavailable')
    expect(results.filter((result) => result.status === 'skip')).toHaveLength(ACCOUNT_STEPS.length)
    const verify = by(results, 'verify the email code')
    expect(verify?.status).toBe('skip')
    expect(verify?.detail).toContain('blocked by')
    expect(formatResult(signUp as StepResult)).toStartWith('SKIP  sign up')
    expect(formatResult(signUp as StepResult)).toContain('skipped: ')
    expect(exitCodeFor(results)).toBe(0)
    expect(exitCodeFor(results, true)).toBe(1)
    expect(stack.seen.filter((call) => call.path === '/v1/client/sign-ups')).toHaveLength(1)
  })
})

describe('refresh', () => {
  test('an access token that is the same string as the last one is fine: only the refresh token must rotate', async () => {
    const { results } = await run({ sameAccessToken: true })
    expect(by(results, 'refresh the session')?.status).toBe('pass')
    expect(results.filter((result) => result.status !== 'pass')).toEqual([])
  })

  test('a refresh that hands back the same refresh token fails', async () => {
    const { results } = await run({ reuseRefreshToken: true })
    const refresh = by(results, 'refresh the session')
    expect(refresh?.status).toBe('fail')
    expect(refresh?.detail).toContain('did not rotate')
  })
})

describe('a failing step blocks only what needs it', () => {
  test('a rejected code fails that step; sign-in and everything after it is skipped as blocked', async () => {
    const { results } = await run({ rejectCode: true })
    const verify = by(results, 'verify the email code')
    expect(verify?.status).toBe('fail')
    expect(verify?.detail).toContain('422')
    expect(verify?.detail).toContain('verification.code_invalid')
    expect(by(results, 'sign in')?.detail).toContain('blocked by "verify the email code" (failed)')
    for (const name of ACCOUNT_STEPS.slice(3)) {
      const blocked = by(results, name)
      expect(blocked?.status).toBe('skip')
      expect(blocked?.detail).toContain('blocked by "')
    }
    expect(by(results, 'read the verification code from the mailbox')?.status).toBe('pass')
    expect(exitCodeFor(results)).toBe(1)
  })

  test('an email that never reaches the mailbox is a failure after a bounded wait', async () => {
    const started = Date.now()
    const { results } = await run({ dropMail: true })
    const read = by(results, 'read the verification code from the mailbox')
    expect(read?.status).toBe('fail')
    expect(read?.detail).toContain('no verification email')
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(by(results, 'verify the email code')?.status).toBe('skip')
  })

  test('a link that does not point at the portal sign-up page fails the Invitation email step', async () => {
    const { results } = await run({ wrongLinkHost: true })
    const link = by(results, 'the Invitation email and its link reach the mailbox')
    expect(link?.status).toBe('fail')
    expect(link?.detail).toContain('portal sign-up page')
    expect(link?.detail).not.toContain('elsewhere')
  })

  test('a core that answers without a token fails the run', async () => {
    const { results } = await run({ coreOpen: true })
    const refusal = by(results, 'core refuses a request without a valid token')
    expect(refusal?.status).toBe('fail')
    expect(refusal?.detail).toContain('200')
    expect(exitCodeFor(results)).toBe(1)
  })

  test('a service that is down is a failure naming the step', async () => {
    const stack = fakeStack()
    stack.stop()
    const results = await runSmoke(stack.targets, { timeoutMs: 100, mailWaitMs: 50 })
    expect(by(results, 'auth is ready')?.status).toBe('fail')
    expect(by(results, 'the mailbox is ready')?.status).toBe('fail')
    expect(exitCodeFor(results)).toBe(1)
  })
})

describe('Organization isolation', () => {
  test.each([
    ['invitations', 'GET /v1/invitations'],
    ['members', 'GET /v1/members'],
    ['organization', 'GET /v1/organization'],
  ] as const)('a core that leaks %s to the second user fails the check', async (leak, label) => {
    const { results } = await run({ leak })
    const check = by(results, 'a second sign-up cannot read the first Organization')
    expect(check?.status).toBe('fail')
    expect(check?.detail).toContain(label)
    expect(exitCodeFor(results, true)).toBe(1)
  })

  test('a leaking answer is named but never printed', async () => {
    const { stack, results } = await run({ leak: 'invitations' })
    const check = by(results, 'a second sign-up cannot read the first Organization')
    const invite = stack.seen.find(
      (call) => call.path === '/v1/invitations' && call.method === 'POST'
    )
    const email = (JSON.parse(invite?.body ?? '{}') as { email: string }).email
    expect(check?.detail).toContain('returned data of the first Organization')
    expect(check?.detail).not.toContain(email)
  })

  test('a core that lets the second user revoke the first Invitation fails the check', async () => {
    const { results } = await run({ revokeAcrossOrganizations: true })
    const check = by(results, 'a second sign-up cannot read the first Organization')
    expect(check?.status).toBe('fail')
    expect(check?.detail).toContain('204')
  })

  test('the second user is a different person in a different Organization', async () => {
    const { stack } = await run()
    const signUps = stack.seen.filter((call) => call.path === '/v1/client/sign-ups')
    const emails = signUps.map((call) => (JSON.parse(call.body) as { email: string }).email)
    expect(new Set(emails).size).toBe(2)
  })
})

describe('what a failure message may contain', () => {
  test('a transport error that quotes a secret has it removed', async () => {
    const stack = fakeStack()
    let token: string | undefined
    const wrapped = (async (input: string | URL | Request, init?: RequestInit) => {
      const header = new Headers(init?.headers).get('authorization')
      if (header && String(input).includes('/v1/members')) {
        token = header.replace(/^Bearer /, '')
        throw new Error(`socket closed while sending ${header}`)
      }
      return fetch(input, init)
    }) as typeof fetch
    const results = await runSmoke(stack.targets, { ...fast, fetchImpl: wrapped })
    stack.stop()
    const members = by(results, 'core: GET /v1/members with the access token')
    expect(members?.status).toBe('fail')
    expect(token).toBeDefined()
    expect(members?.detail).not.toContain(token as string)
    expect(members?.detail).toContain('[hidden]')
  })
})

describe('--strict', () => {
  test('parses the flag and refuses anything else', () => {
    expect(parseSmokeArgs([])).toEqual({ strict: false })
    expect(parseSmokeArgs(['--strict'])).toEqual({ strict: true })
    expect(parseSmokeArgs(['--loose'])).toEqual({ error: 'unknown argument: --loose' })
  })

  test('strict still passes when nothing is skipped or failed', () => {
    const results: StepResult[] = [{ name: 'a', status: 'pass', detail: '' }]
    expect(exitCodeFor(results, true)).toBe(0)
  })

  test('a skip passes normally and fails under strict', () => {
    const results: StepResult[] = [{ name: 'a', status: 'skip', detail: 'x' }]
    expect(exitCodeFor(results)).toBe(0)
    expect(exitCodeFor(results, true)).toBe(1)
  })
})
