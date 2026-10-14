// The smoke test's own checks, each shown able to fail: a fake breaks one thing and the matching
// step must go red. See hub issue 38.
import './test-guard.ts'
import { describe, expect, test } from 'bun:test'
import { formatResult, runSmoke, type StepResult } from './dev-smoke.ts'
import { type FakeOptions, fakeStack } from './dev-smoke-fake.ts'

const by = (results: StepResult[], name: string) => results.find((result) => result.name === name)
const fast = {
  timeoutMs: 1_000,
  mailWaitMs: 400,
  mailIntervalMs: 20,
  playbookWaitMs: 400,
  playbookIntervalMs: 10,
}
const ISOLATION = 'a second sign-up cannot read the first Organization'
const REPLAY = 'a replayed refresh token is refused and ends its session'
const CODE_STEP = 'read the verification code from the mailbox'
const LINK_STEP = 'the Invitation email and its link reach the mailbox'

async function run(options: FakeOptions = {}, extra: Parameters<typeof runSmoke>[1] = {}) {
  const stack = fakeStack(options)
  try {
    const results = await runSmoke(stack.targets, { ...fast, ...extra })
    return { stack, results }
  } finally {
    stack.stop()
  }
}

describe('isolation: writes and reads by id across Organizations', () => {
  test('a healthy core passes, including the positive controls', async () => {
    const { results, stack } = await run()
    expect(by(results, ISOLATION)?.status).toBe('pass')
    // The first user's own Invitation and Team are changed at the end, so a 404 for everyone fails.
    const calls = stack.seen.map(
      (call) => `${call.method} ${call.path.replace(/_[0-9a-z_]+$/, '')}`
    )
    expect(calls).toContain('DELETE /v1/invitations/inv')
    expect(calls).toContain('PATCH /v1/teams/team')
    expect(calls).toContain('DELETE /v1/teams/team')
  })

  test('a DELETE that 404s for everyone fails the run: the owner cannot revoke their own', async () => {
    const { results } = await run({ revokeNotFoundForEveryone: true })
    const check = by(results, ISOLATION)
    expect(check?.status).toBe('fail')
    expect(check?.detail).toContain('own Invitation')
  })

  test('Team routes that 404 for everyone fail the run', async () => {
    const { results } = await run({ teamsNotFoundForEveryone: true })
    expect(by(results, 'create a Team')?.status).toBe('fail')
    expect(by(results, ISOLATION)?.status).toBe('skip')
  })

  test('a cross-Organization revoke needs the documented code, not just any 404', async () => {
    const { results } = await run({ revokeWrongCode: true })
    const check = by(results, ISOLATION)
    expect(check?.status).toBe('fail')
    expect(check?.detail).toContain('invitation.not_found')
  })

  test('a revoke that answers 404 but still changed the first Organization fails', async () => {
    const { results } = await run({ silentCrossRevoke: true })
    const check = by(results, ISOLATION)
    expect(check?.status).toBe('fail')
    expect(check?.detail).toContain('lost its pending Invitation')
  })

  test('a Team rename that 404s for everyone fails the positive control', async () => {
    const { results } = await run({ teamRenameNotFoundForEveryone: true })
    const check = by(results, ISOLATION)
    expect(check?.status).toBe('fail')
    expect(check?.detail).toContain('own Team')
  })

  test('a cross-Organization revoke that answers 204 fails', async () => {
    const { results } = await run({ revokeAcrossOrganizations: true })
    expect(by(results, ISOLATION)?.detail).toContain('204')
  })

  test('a read that returns the first Organization row to the second token fails the run', async () => {
    const { results } = await run({ leak: 'teams' })
    const check = by(results, ISOLATION)
    expect(check?.status).toBe('fail')
    expect(check?.detail).toContain('GET /v1/teams')
  })

  test.each([
    ['crossTeamWrite', 'PATCH /v1/teams/{teamId}'],
    ['crossMemberWrite', 'PATCH /v1/members/{membershipId}'],
  ] as const)('%s fails the run naming the route', async (option, route) => {
    const { results } = await run({ [option]: true })
    const check = by(results, ISOLATION)
    expect(check?.status).toBe('fail')
    expect(check?.detail).toContain(route)
  })

  test('a core that takes the Organization from a header or query fails the run', async () => {
    const { results } = await run({ trustOrganizationHeader: true })
    const check = by(results, ISOLATION)
    expect(check?.status).toBe('fail')
    expect(check?.detail).toContain('Organization id')
  })

  test('the first Organization id is sent with the second token and ignored', async () => {
    const { stack } = await run()
    const sent = stack.seen.filter((call) => call.path === '/v1/organization')
    expect(sent.length).toBeGreaterThanOrEqual(3)
  })
})

describe('refresh: a spent token is refused', () => {
  test('a healthy auth passes and the replay is the only repeated token', async () => {
    const { results, stack } = await run()
    expect(by(results, REPLAY)?.status).toBe('pass')
    const bodies = stack.seen
      .filter((call) => call.path === '/v1/client/sessions/refresh')
      .map((call) => call.body)
    expect(bodies.length - new Set(bodies).size).toBe(1)
  })

  test('an auth that still accepts the old refresh token fails the run', async () => {
    const { results } = await run({ acceptOldRefresh: true })
    const replay = by(results, REPLAY)
    expect(replay?.status).toBe('fail')
    expect(replay?.detail).toContain('session.reuse_detected')
  })

  test('the replay is the last thing the run does, on a throwaway session', async () => {
    const { results } = await run()
    expect(results.at(-1)?.name).toBe(REPLAY)
  })

  test('a session that survives the reuse of an old token fails the run', async () => {
    const { results } = await run({ reuseKeepsSession: true })
    const replay = by(results, REPLAY)
    expect(replay?.status).toBe('fail')
    expect(replay?.detail).toContain('still')
  })
})

describe('the mailbox is read strictly', () => {
  test('a message to another address that contains this one is not used (substring search)', async () => {
    const { results } = await run({ staleMail: true })
    expect(results.filter((result) => result.status !== 'pass')).toEqual([])
  })

  test('an email that arrives late is waited for until the deadline', async () => {
    const { results } = await run({ mailDelayMs: 150 })
    expect(results.filter((result) => result.status !== 'pass')).toEqual([])
  })

  test('an email that never arrives fails as "did not arrive", after the wait', async () => {
    const { results } = await run({ dropMail: true })
    expect(by(results, CODE_STEP)?.detail).toContain('no verification email reached the mailbox')
  })

  test('a message with two codes is an error, not the first code', async () => {
    const { results } = await run({ codes: 'two' })
    const read = by(results, CODE_STEP)
    expect(read?.status).toBe('fail')
    expect(read?.detail).toContain('more than one')
    expect(by(results, 'verify the email code')?.status).toBe('skip')
  })

  test('a message with no code is an error', async () => {
    const { results } = await run({ codes: 'none' })
    expect(by(results, CODE_STEP)?.detail).toContain('no six-digit code')
  })

  test('an Invitation email with two links is an error', async () => {
    const { results } = await run({ links: 'two' })
    const link = by(results, LINK_STEP)
    expect(link?.status).toBe('fail')
    expect(link?.detail).toContain('more than one')
  })

  test('an Invitation email with no link is an error', async () => {
    const { results } = await run({ links: 'none' })
    expect(by(results, LINK_STEP)?.detail).toContain('no accept link')
  })

  test.each([
    ['500', '500'],
    ['junk', 'not what Mailpit sends'],
    ['no-messages', 'not what Mailpit sends'],
  ] as const)(
    'a mailbox that answers %s is a mailbox failure, not a missing email',
    async (mailBroken, wording) => {
      const started = Date.now()
      const { results } = await run({ mailBroken }, { mailWaitMs: 3_000 })
      const read = by(results, CODE_STEP)
      expect(read?.status).toBe('fail')
      expect(read?.detail).toContain('mailbox')
      expect(read?.detail).toContain(wording)
      expect(read?.detail).not.toContain('no verification email reached')
      expect(Date.now() - started).toBeLessThan(2_900)
    }
  )
})

describe('nothing secret is printed, in any form', () => {
  type Call = { method: string; url: string; headers: Headers; body: string }
  const encodings = (value: string) => [
    value,
    encodeURIComponent(value),
    encodeURIComponent(value).replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()),
    JSON.stringify(value).slice(1, -1),
  ]

  /** Makes a fetch that fails the matching call two ways: a thrown error and an error body. */
  const echoing = (
    mode: 'throws' | 'body',
    matches: (call: Call) => boolean,
    secretOf: (call: Call) => string[]
  ) => {
    const captured: string[] = []
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      const call: Call = {
        method: init?.method ?? 'GET',
        url,
        headers: new Headers(init?.headers),
        body: typeof init?.body === 'string' ? init.body : '',
      }
      if (!matches(call)) {
        return fetch(input, init)
      }
      const secrets = secretOf(call)
      captured.push(...secrets)
      const echoed = secrets.flatMap(encodings).join(' ')
      if (mode === 'throws') {
        throw new Error(`socket closed after sending ${echoed}`)
      }
      return Response.json({ error: { code: echoed, message: echoed } }, { status: 500 })
    }) as typeof fetch
    return { fetchImpl, captured }
  }

  const header = (call: Call, name: string) => call.headers.get(name) ?? ''
  const field = (call: Call, name: string) =>
    String((JSON.parse(call.body || '{}') as Record<string, unknown>)[name] ?? '')
  const kinds: {
    kind: string
    matches: (call: Call) => boolean
    secretOf: (call: Call) => string[]
  }[] = [
    {
      kind: 'email',
      matches: (c) => c.url.includes('/api/v1/search') && c.url.includes('smoke-'),
      secretOf: (c) => [
        decodeURIComponent(new URL(c.url).searchParams.get('query') ?? '').slice(3),
      ],
    },
    {
      kind: 'password',
      matches: (c) => c.url.includes('/sign-ins/') && c.url.endsWith('/password'),
      secretOf: (c) => [field(c, 'password')],
    },
    {
      kind: 'attempt secret',
      matches: (c) => c.url.includes('/verify-email'),
      secretOf: (c) => [header(c, 'x-tula-attempt')],
    },
    {
      kind: 'verification code',
      matches: (c) => c.url.includes('/verify-email'),
      secretOf: (c) => [field(c, 'code')],
    },
    {
      kind: 'invitee address',
      matches: (c) => c.url.endsWith('/v1/invitations') && c.method === 'POST',
      secretOf: (c) => [field(c, 'email')],
    },
    {
      kind: 'access token',
      matches: (c) => c.url.endsWith('/v1/members'),
      secretOf: (c) => [header(c, 'authorization').replace(/^Bearer /, '')],
    },
    {
      kind: 'sign-in attempt secret',
      matches: (c) => c.url.includes('/sign-ins/') && c.url.endsWith('/password'),
      secretOf: (c) => [header(c, 'x-tula-attempt')],
    },
    {
      kind: 'refresh token',
      matches: (c) => c.url.endsWith('/sessions/refresh'),
      secretOf: (c) => [field(c, 'refreshToken')],
    },
  ]

  test.each(kinds.flatMap((k) => [[k, 'throws'] as const, [k, 'body'] as const]))(
    'a $0.kind echoed into a %s is not printed, raw or encoded',
    async ({ matches, secretOf }, mode) => {
      const stack = fakeStack()
      const echo = echoing(mode, matches, secretOf)
      const results = await runSmoke(stack.targets, { ...fast, fetchImpl: echo.fetchImpl })
      stack.stop()
      const report = results.map(formatResult).join('\n')
      expect(echo.captured.length).toBeGreaterThan(0)
      expect(results.some((result) => result.status === 'fail')).toBe(true)
      for (const secret of echo.captured) {
        expect(secret.length).toBeGreaterThan(5)
        for (const form of encodings(secret)) {
          expect(report).not.toContain(form)
        }
      }
    }
  )

  test('an Invitation link echoed into a thrown error is not printed', async () => {
    const stack = fakeStack()
    let link = ''
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      const text = stack.mailbox.map((m) => m.text).join('\n')
      link = /https?:\/\/\S+#invitation=\S+/.exec(text)?.[0] ?? ''
      if (link !== '' && url.includes('/v1/client/sign-ups') && init?.method === 'POST') {
        throw new Error(`reset by peer after ${link} ${encodeURIComponent(link)}`)
      }
      return fetch(input, init)
    }) as typeof fetch
    const results = await runSmoke(stack.targets, { ...fast, fetchImpl })
    stack.stop()
    const report = results.map(formatResult).join('\n')
    expect(link).toContain('#invitation=')
    expect(by(results, ISOLATION)?.status).toBe('fail')
    for (const form of encodings(link)) {
      expect(report).not.toContain(form)
    }
    expect(report).not.toContain('invitation=')
  })

  test('an error code is printed only if it has the contract shape', async () => {
    const stack = fakeStack({ rejectCode: true })
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes('/verify-email')) {
        return Response.json({ error: { code: 'hunter2 secret-value' } }, { status: 422 })
      }
      return fetch(input, init)
    }) as typeof fetch
    const results = await runSmoke(stack.targets, { ...fast, fetchImpl })
    stack.stop()
    const verify = by(results, 'verify the email code')
    expect(verify?.detail).not.toContain('hunter2')
    expect(verify?.detail).toContain('not a contract error code')
  })

  test('an error code of the contract shape is printed as it is', async () => {
    const { results } = await run({ rejectCode: true })
    expect(by(results, 'verify the email code')?.detail).toContain('verification.code_invalid')
  })
})

describe('more cross-Organization writes, and every check pinned by a break', () => {
  test.each([
    ['crossMemberDelete', 'DELETE /v1/members/{membershipId}'],
    ['crossTeamMemberDelete', 'DELETE /v1/teams/{teamId}/members/{membershipId}'],
  ] as const)('%s fails the run naming the route', async (option, route) => {
    const { results } = await run({ [option]: true })
    const check = by(results, ISOLATION)
    expect(check?.status).toBe('fail')
    expect(check?.detail).toContain(route)
  })

  test.each([
    ['silentCrossTeamWrite', 'lost its Team or its name was changed'],
    ['silentCrossMemberWrite', 'no longer its Owner'],
    ['revokeKeepsListed', 'still listed as pending'],
    ['teamDeleteNotFoundForEveryone', 'could not delete their own Team'],
  ] as const)('%s fails the run: "%s"', async (option, wording) => {
    const { results } = await run({ [option]: true })
    const check = by(results, ISOLATION)
    expect(check?.status).toBe('fail')
    expect(check?.detail).toContain(wording)
  })

  test('creating an Invitation must answer 201 exactly, as core documents', async () => {
    const { results } = await run({ createInvitationAs200: true })
    const created = by(results, 'create an Invitation')
    expect(created?.status).toBe('fail')
    expect(created?.detail).toContain('200')
  })

  test('a created Invitation must be pending', async () => {
    const { results } = await run({ invitationNotPending: true })
    expect(by(results, 'create an Invitation')?.status).toBe('fail')
  })

  test('a replay refused with another code fails', async () => {
    const { results } = await run({ replayCode: 'session.invalid_token' })
    const replay = by(results, REPLAY)
    expect(replay?.status).toBe('fail')
    expect(replay?.detail).toContain('session.reuse_detected')
  })

  test('the newest token of a reused session refused with an unrelated code fails', async () => {
    const { results } = await run({ newestCode: 'auth.unauthenticated' })
    const replay = by(results, REPLAY)
    expect(replay?.status).toBe('fail')
    expect(replay?.detail).toContain('session.revoked')
  })

  test('the Idempotency-Key of every write is unique to that request within the run', async () => {
    const { stack } = await run()
    const byKey = new Map<string, Set<string>>()
    for (const call of stack.seen) {
      if (call.key) {
        byKey.set(
          call.key,
          (byKey.get(call.key) ?? new Set()).add(`${call.method} ${call.path} ${call.body}`)
        )
      }
    }
    expect(byKey.size).toBeGreaterThanOrEqual(8)
    for (const requests of byKey.values()) {
      expect(requests.size).toBe(1)
    }
  })
})

describe('the mailbox match is pinned', () => {
  test('a six-digit number without the "verification code is" phrase is not a code', async () => {
    const { results } = await run({ codes: 'other-phrase' })
    const read = by(results, CODE_STEP)
    expect(read?.status).toBe('fail')
    expect(read?.detail).toContain('no six-digit code')
  })

  test('an email with another subject to the same address is ignored', async () => {
    const { results } = await run({ extraMail: true })
    expect(results.filter((result) => result.status !== 'pass')).toEqual([])
  })

  test('two emails with the right subject to this address are an error, not the newest', async () => {
    const { results } = await run({ duplicateMail: true })
    const read = by(results, CODE_STEP)
    expect(read?.status).toBe('fail')
    expect(read?.detail).toContain('more than one such email')
  })
})

describe('values from a service that reach the report', () => {
  test('core status and region are printed when plain', async () => {
    const { results } = await run()
    expect(by(results, 'core: GET /v1/organization with the access token')?.detail).toBe(
      'active, local'
    )
  })

  test.each([
    ['coreRegion', '\u001b[2J\u001b[31mowned'],
    ['coreStatus', 'active\nPASS everything'],
    ['coreRegion', 'x'.repeat(33)],
  ] as const)('%s %j is replaced by a fixed placeholder', async (option, value) => {
    const { results } = await run({ [option]: value })
    const report = results.map(formatResult).join('\n')
    expect(report).not.toContain('\u001b')
    expect(report).not.toContain('PASS everything')
    expect(by(results, 'core: GET /v1/organization with the access token')?.detail).toContain(
      '(unexpected value)'
    )
  })
})

describe('every value the run makes is registered before it is first used', () => {
  type Call = { method: string; url: string; headers: Headers; body: string }
  const carried = (call: Call): string[] => {
    const body = (() => {
      try {
        return JSON.parse(call.body || '{}') as Record<string, unknown>
      } catch {
        return {}
      }
    })()
    const fromBody = ['email', 'password', 'identifier', 'code', 'refreshToken'].map((name) =>
      String(body[name] ?? '')
    )
    const query = new URL(call.url).searchParams.get('query')
    return [
      ...fromBody,
      call.headers.get('authorization')?.replace(/^Bearer /, '') ?? '',
      call.headers.get('x-tula-attempt') ?? '',
      query ? query.replace(/^to:/, '') : '',
    ].filter((value) => value.length > 5)
  }
  const forms = (value: string) => [value, encodeURIComponent(value)]

  test('a throw on each call in turn never prints what that call carries', async () => {
    const asCall = (input: string | URL | Request, init?: RequestInit): Call => ({
      method: init?.method ?? 'GET',
      url: String(input),
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : '',
    })
    let total = 0
    {
      const stack = fakeStack()
      const counting = (async (input: string | URL | Request, init?: RequestInit) => {
        total++
        return fetch(input, init)
      }) as typeof fetch
      await runSmoke(stack.targets, { ...fast, fetchImpl: counting })
      stack.stop()
    }
    expect(total).toBeGreaterThan(50)
    const leaked: string[] = []
    for (let n = 1; n <= total; n++) {
      const stack = fakeStack()
      let count = 0
      const failing = new Set<string>()
      const seenValues: string[] = []
      const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
        const call = asCall(input, init)
        const signature = `${call.method} ${call.url} ${call.body} ${call.headers.get('authorization')}`
        count++
        if (count === n) {
          failing.add(signature)
        }
        if (failing.has(signature)) {
          seenValues.push(...carried(call))
          throw new Error(
            `reset while sending ${call.method} ${call.url} ${JSON.stringify([...call.headers])} ${call.body}`
          )
        }
        return fetch(input, init)
      }) as typeof fetch
      const results = await runSmoke(stack.targets, { ...fast, fetchImpl })
      stack.stop()
      const report = results.map(formatResult).join('\n')
      for (const value of seenValues) {
        for (const form of forms(value)) {
          if (report.includes(form)) {
            leaked.push(`call ${n}`)
          }
        }
      }
    }
    expect(leaked).toEqual([])
  }, 300_000)
})
