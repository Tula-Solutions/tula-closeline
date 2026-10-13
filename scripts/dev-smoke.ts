// Checks the running dev stack over real HTTP: `bun run dev:smoke [--strict]`. See
// docs/local-development.md.
//
// Every call has a timeout and a bounded retry. A step whose prerequisite cannot run is reported
// as "skipped: <reason>", never as a pass; `--strict` turns a skip into a failure. The sign-up
// code and the Invitation link are read from the local mailbox (Mailpit) that auth and core send
// to; the services have no other way in for the test and none is added. No code, token, password,
// link or address is printed: every message is scrubbed of the values this run has seen.
import { origins, randomHex, requestWithRetry, resolvePorts } from './dev-lib.ts'

/** How a step ended. */
export type StepStatus = 'pass' | 'fail' | 'skip'

/** One line of the report. */
export type StepResult = { name: string; status: StepStatus; detail: string }

/** Where the services and the mailbox answer. */
export type SmokeTargets = { auth: string; core: string; portal: string; mail: string }

/** Tunables of a run; the defaults are what the CLI uses. */
export type SmokeOptions = {
  fetchImpl?: typeof fetch
  /** Longest one HTTP call may take. */
  timeoutMs?: number
  /** Longest to wait for an email to reach the mailbox. */
  mailWaitMs?: number
  /** Pause between looks at the mailbox. */
  mailIntervalMs?: number
}

const MAX_BODY_CHARS = 65_536

type Outcome = { status: StepStatus; detail: string }
type Json = Record<string, unknown>

/** The names of the steps that need a signed-up user, in the order they run. */
export const ACCOUNT_STEPS = [
  'sign up (starts, emails a code)',
  'read the verification code from the mailbox',
  'verify the email code',
  'sign in',
  'core: GET /v1/organization with the access token',
  'core: GET /v1/members with the access token',
  'refresh the session',
  'create an Invitation',
  'the Invitation email and its link reach the mailbox',
  'a second sign-up cannot read the first Organization',
] as const

/** An object's property, or undefined for anything that is not an object. */
function pick(value: unknown, ...path: string[]): unknown {
  let current = value
  for (const key of path) {
    if (typeof current !== 'object' || current === null) {
      return undefined
    }
    current = (current as Json)[key]
  }
  return current
}

const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

/** The `error.code` of a contract error body, or undefined. */
function errorCode(json: unknown): string | undefined {
  return text(pick(json, 'error', 'code'))
}

async function readJson(response: Response): Promise<unknown> {
  const body = (await response.text()).slice(0, MAX_BODY_CHARS)
  try {
    return JSON.parse(body)
  } catch {
    return undefined
  }
}

/** A signed-in session as the smoke test holds it. */
type Session = { accessToken: string; refreshToken: string; organizationId: string }

/** What one run knows, and why anything it does not know is missing. */
type State = {
  attempt?: { id: string; secret: string }
  code?: string
  verified?: true
  session?: Session
  members?: { userIds: string[] }
  invitation?: { id: string; email: string }
}

/**
 * Runs the smoke flow against `targets` and returns one result per step. A step that throws is a
 * failure whose detail is the error's message with every value seen in this run removed.
 */
export async function runSmoke(
  targets: SmokeTargets,
  options: SmokeOptions = {}
): Promise<StepResult[]> {
  const results: StepResult[] = []
  const seen = new Set<string>()
  const remember = (...values: (string | undefined)[]) => {
    for (const value of values) {
      if (value) {
        seen.add(value)
      }
    }
  }
  const hide = (message: string) => {
    let out = message
    for (const value of seen) {
      out = out.split(value).join('[hidden]')
    }
    return out
  }

  const request = (url: string, init: RequestInit & { idempotent?: boolean } = {}) =>
    requestWithRetry(url, init, { fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs })

  const call = async (
    method: string,
    url: string,
    send: { headers?: Record<string, string>; body?: unknown; once?: boolean } = {}
  ) => {
    const response = await request(url, {
      method,
      idempotent: send.once ? false : undefined,
      headers: {
        ...(send.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...send.headers,
      },
      body: send.body === undefined ? undefined : JSON.stringify(send.body),
    })
    return { status: response.status, json: await readJson(response) }
  }
  const authed = (session: Session) => ({ authorization: `Bearer ${session.accessToken}` })
  const client = { 'x-tula-client': 'server' }

  const step = async (name: string, body: () => Promise<Outcome>) => {
    try {
      const outcome = await body()
      results.push({ name, status: outcome.status, detail: hide(outcome.detail) })
    } catch (error) {
      results.push({
        name,
        status: 'fail',
        detail: hide(error instanceof Error ? error.message : 'failed'),
      })
    }
  }
  const pass = (detail = ''): Outcome => ({ status: 'pass', detail })
  const fail = (detail: string): Outcome => ({ status: 'fail', detail })
  const skip = (detail: string): Outcome => ({ status: 'skip', detail })

  // The mailbox: the newest message to `to` whose subject has `subject`, waited for with a bound.
  const mailbox = async (to: string, subject: string): Promise<string | undefined> => {
    const deadline = Date.now() + (options.mailWaitMs ?? 15_000)
    for (;;) {
      const query = encodeURIComponent(`to:${to}`)
      const found = await call('GET', `${targets.mail}/api/v1/search?query=${query}&limit=10`)
      const messages = pick(found.json, 'messages')
      if (found.status === 200 && Array.isArray(messages)) {
        const match = messages.find((message) => text(pick(message, 'Subject'))?.includes(subject))
        const id = text(pick(match, 'ID'))
        if (id) {
          const message = await call(
            'GET',
            `${targets.mail}/api/v1/message/${encodeURIComponent(id)}`
          )
          const body = text(pick(message.json, 'Text'))
          if (message.status === 200 && body !== undefined) {
            return body
          }
        }
      }
      if (Date.now() >= deadline) {
        return undefined
      }
      await Bun.sleep(options.mailIntervalMs ?? 200)
    }
  }

  await step('auth is ready', async () => {
    const response = await request(`${targets.auth}/readyz`)
    return response.status === 200 ? pass() : fail(`GET /readyz answered ${response.status}`)
  })

  await step('core is ready', async () => {
    const response = await request(`${targets.core}/readyz`)
    return response.status === 200 ? pass() : fail(`GET /readyz answered ${response.status}`)
  })

  await step('portal is served', async () => {
    const response = await request(`${targets.portal}/`)
    const type = response.headers.get('content-type') ?? ''
    await response.body?.cancel()
    return response.status === 200 && type.includes('text/html')
      ? pass()
      : fail(`GET / answered ${response.status} ${type}`)
  })

  await step('the mailbox is ready', async () => {
    const response = await request(`${targets.mail}/livez`)
    await response.body?.cancel()
    return response.status === 200 ? pass() : fail(`GET /livez answered ${response.status}`)
  })

  await step('auth publishes its signing keys', async () => {
    const found = await call('GET', `${targets.auth}/.well-known/jwks.json`)
    const keys = pick(found.json, 'keys')
    if (found.status !== 200 || !Array.isArray(keys) || keys.length === 0) {
      return fail(`GET /.well-known/jwks.json answered ${found.status} with no keys`)
    }
    return keys.every((key) => pick(key, 'alg') === 'EdDSA')
      ? pass(`${keys.length} key(s)`)
      : fail('a published key is not EdDSA')
  })

  await step('core refuses a request without a valid token', async () => {
    const cases: { headers: Record<string, string>; expected: string }[] = [
      { headers: {}, expected: 'auth.unauthenticated' },
      { headers: { authorization: `Bearer ${randomHex(24)}` }, expected: 'auth.token_invalid' },
    ]
    for (const { headers, expected } of cases) {
      const found = await call('GET', `${targets.core}/v1/organization`, { headers })
      const code = errorCode(found.json)
      if (found.status !== 401 || code !== expected) {
        return fail(
          `GET /v1/organization answered ${found.status} ${code ?? ''}, not 401 ${expected}`
        )
      }
    }
    return pass()
  })

  // The account flow. Each step names what it needs; if an earlier step did not provide it, the
  // step is skipped, "blocked by" that step, so nothing is hidden and nothing runs on a guess.
  const state: State = {}
  const missing = new Map<string, string>()
  const flow = async (
    name: string,
    needs: (keyof State)[],
    gives: (keyof State)[],
    body: () => Promise<Outcome>
  ) => {
    const lacking = needs.find((key) => state[key] === undefined)
    if (lacking !== undefined) {
      results.push({
        name,
        status: 'skip',
        detail: `blocked by ${missing.get(lacking) ?? 'an earlier step that did not provide it'}`,
      })
    } else {
      await step(name, body)
    }
    const last = results.at(-1)
    if (last !== undefined && last.status !== 'pass') {
      for (const key of gives) {
        if (state[key] === undefined) {
          missing.set(key, `"${name}" (${last.status === 'skip' ? 'skipped' : 'failed'})`)
        }
      }
    }
  }

  /** Starts a sign-up for `email`; the attempt, or a reason it did not start. */
  const startSignUp = async (email: string, password: string, organizationName: string) => {
    remember(email, password)
    const found = await call('POST', `${targets.auth}/v1/client/sign-ups`, {
      headers: client,
      body: { email, password, organizationName },
      once: true,
    })
    const id = text(pick(found.json, 'id'))
    const secret = text(pick(found.json, 'attemptSecret'))
    remember(secret)
    return { status: found.status, code: errorCode(found.json), id, secret }
  }

  /** Verifies a sign-up attempt with the code from the mailbox. */
  const verify = async (attempt: { id: string; secret: string }, code: string) => {
    const found = await call(
      'POST',
      `${targets.auth}/v1/client/sign-ups/${attempt.id}/verify-email`,
      {
        headers: { ...client, 'x-tula-attempt': attempt.secret },
        body: { code },
        once: true,
      }
    )
    return { status: found.status, code: errorCode(found.json) }
  }

  /** Signs in with an email and password; the session, or what went wrong. */
  const signIn = async (email: string, password: string) => {
    const start = await call('POST', `${targets.auth}/v1/client/sign-ins`, {
      headers: client,
      body: { identifier: email },
      once: true,
    })
    const id = text(pick(start.json, 'id'))
    const secret = text(pick(start.json, 'attemptSecret'))
    remember(secret)
    if (start.status !== 200 || !id || !secret) {
      return {
        error:
          `POST /v1/client/sign-ins answered ${start.status} ${errorCode(start.json) ?? ''}`.trim(),
      }
    }
    const done = await call('POST', `${targets.auth}/v1/client/sign-ins/${id}/password`, {
      headers: { ...client, 'x-tula-attempt': secret },
      body: { password },
      once: true,
    })
    const session = sessionFrom(done.json)
    if (done.status !== 200 || !session) {
      return {
        error:
          `POST /v1/client/sign-ins/{id}/password answered ${done.status} ${errorCode(done.json) ?? ''}`.trim(),
      }
    }
    return { session }
  }

  const sessionFrom = (json: unknown): Session | undefined => {
    const accessToken =
      text(pick(json, 'session', 'accessToken')) ?? text(pick(json, 'accessToken'))
    const refreshToken =
      text(pick(json, 'session', 'refreshToken')) ?? text(pick(json, 'refreshToken'))
    const organizationId =
      text(pick(json, 'session', 'organization', 'id')) ?? text(pick(json, 'organization', 'id'))
    remember(accessToken, refreshToken)
    return accessToken && refreshToken && organizationId
      ? { accessToken, refreshToken, organizationId }
      : undefined
  }

  const runId = randomHex(6)
  const email = `smoke-${runId}@closeline-smoke.test`
  const inviteeEmail = `invitee-${runId}@closeline-smoke.test`
  const password = `${randomHex(16)}-Aa1`
  remember(inviteeEmail)

  await flow('sign up (starts, emails a code)', [], ['attempt'], async () => {
    const started = await startSignUp(email, password, `Smoke ${runId}`)
    if (started.status === 503 && started.code === 'mail.unavailable') {
      return skip(
        'auth answered 503 mail.unavailable: it was started without MAIL_LOCAL_URL, so it has no mailbox to send to'
      )
    }
    if (started.status !== 200 || !started.id || !started.secret) {
      return fail(
        `POST /v1/client/sign-ups answered ${started.status} ${started.code ?? ''}`.trim()
      )
    }
    state.attempt = { id: started.id, secret: started.secret }
    return pass()
  })

  await flow('read the verification code from the mailbox', ['attempt'], ['code'], async () => {
    const body = await mailbox(email, 'verification code')
    if (body === undefined) {
      return fail('no verification email reached the mailbox in time')
    }
    const code = /verification code is (\d{6})/.exec(body)?.[1]
    if (!code) {
      return fail('the verification email has no six-digit code')
    }
    remember(code)
    state.code = code
    return pass()
  })

  await flow('verify the email code', ['attempt', 'code'], ['verified'], async () => {
    const attempt = state.attempt
    const code = state.code
    if (!attempt || !code) {
      return fail('missing attempt or code')
    }
    const done = await verify(attempt, code)
    if (done.status !== 200) {
      return fail(
        `POST /v1/client/sign-ups/{id}/verify-email answered ${done.status} ${done.code ?? ''}`.trim()
      )
    }
    state.verified = true
    return pass()
  })

  await flow('sign in', ['verified'], ['session'], async () => {
    const signedIn = await signIn(email, password)
    if ('error' in signedIn) {
      return fail(signedIn.error ?? 'sign-in failed')
    }
    state.session = signedIn.session
    return pass()
  })

  await flow('core: GET /v1/organization with the access token', ['session'], [], async () => {
    const session = state.session
    if (!session) {
      return fail('no session')
    }
    const found = await call('GET', `${targets.core}/v1/organization`, { headers: authed(session) })
    if (found.status !== 200) {
      return fail(
        `GET /v1/organization answered ${found.status} ${errorCode(found.json) ?? ''}`.trim()
      )
    }
    if (pick(found.json, 'id') !== session.organizationId) {
      return fail('core returned an Organization other than the one in the token')
    }
    return pass(
      `${text(pick(found.json, 'status')) ?? 'no status'}, ${text(pick(found.json, 'region')) ?? 'no region'}`
    )
  })

  await flow('core: GET /v1/members with the access token', ['session'], ['members'], async () => {
    const session = state.session
    if (!session) {
      return fail('no session')
    }
    const found = await call('GET', `${targets.core}/v1/members`, { headers: authed(session) })
    const items = pick(found.json, 'items')
    if (found.status !== 200 || !Array.isArray(items)) {
      return fail(`GET /v1/members answered ${found.status} ${errorCode(found.json) ?? ''}`.trim())
    }
    const owners = items.filter((item) => pick(item, 'role') === 'owner')
    if (items.length !== 1 || owners.length !== 1) {
      return fail(
        `expected one member who is the Owner, got ${items.length} member(s), ${owners.length} Owner(s)`
      )
    }
    state.members = { userIds: items.map((item) => text(pick(item, 'userId')) ?? '') }
    remember(...state.members.userIds)
    return pass('1 member, the Owner')
  })

  await flow('refresh the session', ['session'], [], async () => {
    const session = state.session
    if (!session) {
      return fail('no session')
    }
    const found = await call('POST', `${targets.auth}/v1/client/sessions/refresh`, {
      body: { refreshToken: session.refreshToken },
      once: true,
    })
    const next = sessionFrom(found.json)
    if (found.status !== 200 || !next) {
      return fail(
        `POST /v1/client/sessions/refresh answered ${found.status} ${errorCode(found.json) ?? ''}`.trim()
      )
    }
    if (next.accessToken === session.accessToken || next.refreshToken === session.refreshToken) {
      return fail('refresh returned a token that was not renewed')
    }
    if (next.organizationId !== session.organizationId) {
      return fail('refresh changed the Organization in the session')
    }
    state.session = next
    const again = await call('GET', `${targets.core}/v1/organization`, { headers: authed(next) })
    return again.status === 200
      ? pass('the new access token works at core')
      : fail(
          `the refreshed access token was refused at core: ${again.status} ${errorCode(again.json) ?? ''}`.trim()
        )
  })

  await flow('create an Invitation', ['session'], ['invitation'], async () => {
    const session = state.session
    if (!session) {
      return fail('no session')
    }
    const found = await call('POST', `${targets.core}/v1/invitations`, {
      headers: { ...authed(session), 'idempotency-key': `smoke-${runId}-invite` },
      body: { email: inviteeEmail, role: 'rep' },
      once: true,
    })
    const id = text(pick(found.json, 'id'))
    if (found.status !== 201 && found.status !== 200) {
      return fail(
        `POST /v1/invitations answered ${found.status} ${errorCode(found.json) ?? ''}`.trim()
      )
    }
    if (!id || pick(found.json, 'state') !== 'pending') {
      return fail('the Invitation answer has no id or is not pending')
    }
    state.invitation = { id, email: inviteeEmail }
    remember(id)
    return pass('pending')
  })

  await flow(
    'the Invitation email and its link reach the mailbox',
    ['invitation'],
    [],
    async () => {
      const body = await mailbox(inviteeEmail, 'invited')
      if (body === undefined) {
        return fail('no Invitation email reached the mailbox in time')
      }
      const link = /https?:\/\/[^\s"<>]+#invitation=([A-Za-z0-9_-]{22,256})/.exec(body)
      if (!link) {
        return fail('the Invitation email has no accept link')
      }
      remember(link[0], link[1])
      const url = new URL(link[0])
      if (url.origin !== new URL(targets.portal).origin || url.pathname !== '/sign-up') {
        return fail('the accept link does not point at the portal sign-up page')
      }
      return pass('the link points at the portal sign-up page')
    }
  )

  await flow(
    'a second sign-up cannot read the first Organization',
    ['session', 'members', 'invitation'],
    [],
    async () => {
      const first = state.session
      const firstMembers = state.members
      const invitation = state.invitation
      if (!first || !firstMembers || !invitation) {
        return fail('missing the first Organization')
      }
      const email2 = `second-${runId}@closeline-smoke.test`
      const password2 = `${randomHex(16)}-Aa1`
      const started = await startSignUp(email2, password2, `Smoke second ${runId}`)
      if (started.status !== 200 || !started.id || !started.secret) {
        return fail(`the second sign-up answered ${started.status} ${started.code ?? ''}`.trim())
      }
      const body = await mailbox(email2, 'verification code')
      const code = body === undefined ? undefined : /verification code is (\d{6})/.exec(body)?.[1]
      if (!code) {
        return fail('the second sign-up code did not reach the mailbox')
      }
      remember(code)
      const verified = await verify({ id: started.id, secret: started.secret }, code)
      if (verified.status !== 200) {
        return fail(
          `the second sign-up verify answered ${verified.status} ${verified.code ?? ''}`.trim()
        )
      }
      const second = await signIn(email2, password2)
      if ('error' in second) {
        return fail(second.error ?? 'the second sign-in failed')
      }
      const token = second.session
      if (token.organizationId === first.organizationId) {
        return fail('the second user was put into the first Organization')
      }
      const leaks = (json: unknown) => {
        const body = JSON.stringify(json) ?? ''
        return [
          first.organizationId,
          invitation.id,
          invitation.email,
          email,
          ...firstMembers.userIds,
        ].filter((value) => value !== '' && body.includes(value))
      }
      const reads = [
        [
          'GET /v1/organization',
          await call('GET', `${targets.core}/v1/organization`, { headers: authed(token) }),
        ],
        [
          'GET /v1/members',
          await call('GET', `${targets.core}/v1/members`, { headers: authed(token) }),
        ],
        [
          'GET /v1/invitations',
          await call('GET', `${targets.core}/v1/invitations`, { headers: authed(token) }),
        ],
      ] as const
      for (const [label, found] of reads) {
        if (found.status !== 200) {
          return fail(
            `${label} answered ${found.status} ${errorCode(found.json) ?? ''} for the second user`.trim()
          )
        }
        if (leaks(found.json).length > 0) {
          return fail(`${label} returned data of the first Organization to the second user`)
        }
      }
      if (pick(reads[0][1].json, 'id') !== token.organizationId) {
        return fail('core returned an Organization other than the one in the second token')
      }
      const members = pick(reads[1][1].json, 'items')
      if (!Array.isArray(members) || members.length !== 1) {
        return fail('the second user does not see exactly their own member')
      }
      // A write across the boundary: the second token must not be able to revoke the first
      // Organization's Invitation, and the first token must still see it pending.
      const revoke = await call('DELETE', `${targets.core}/v1/invitations/${invitation.id}`, {
        headers: authed(token),
        once: true,
      })
      if (revoke.status !== 404) {
        return fail(
          `DELETE of the first Organization's Invitation by the second user answered ${revoke.status}, not 404`
        )
      }
      const still = await call('GET', `${targets.core}/v1/invitations`, { headers: authed(first) })
      const items = pick(still.json, 'items')
      const stillPending =
        Array.isArray(items) &&
        items.some(
          (item) => pick(item, 'id') === invitation.id && pick(item, 'state') === 'pending'
        )
      return stillPending
        ? pass('different Organizations; nothing of the first was returned or changed')
        : fail('the first Organization lost its pending Invitation')
    }
  )

  return results
}

/** One report line for a step. */
export function formatResult(result: StepResult): string {
  const label = { pass: 'PASS', fail: 'FAIL', skip: 'SKIP' }[result.status]
  if (result.status === 'skip') {
    return `${label}  ${result.name}: skipped: ${result.detail}`
  }
  return `${label}  ${result.name}${result.detail ? `: ${result.detail}` : ''}`
}

/** The smoke command line: `--strict` makes a skipped step an error. */
export function parseSmokeArgs(argv: readonly string[]): { strict: boolean } | { error: string } {
  let strict = false
  for (const arg of argv) {
    if (arg === '--strict') {
      strict = true
    } else {
      return { error: `unknown argument: ${arg}` }
    }
  }
  return { strict }
}

/**
 * The process exit code for a set of results: 1 if any step failed, else 0. With `strict`, a
 * skipped step also gives 1, so a skip cannot hide a gap; CI uses it now that the stack has a
 * local mailbox (hub issue 38).
 */
export function exitCodeFor(results: readonly StepResult[], strict = false): number {
  return results.some((result) => result.status === 'fail' || (strict && result.status === 'skip'))
    ? 1
    : 0
}

if (import.meta.main) {
  const args = parseSmokeArgs(process.argv.slice(2))
  if ('error' in args) {
    process.stderr.write(`${args.error}\nusage: bun run dev:smoke [--strict]\n`)
    process.exit(2)
  }
  const targets = origins(resolvePorts(process.env))
  const results = await runSmoke(targets)
  for (const result of results) {
    process.stdout.write(`${formatResult(result)}\n`)
  }
  const count = (status: StepStatus) => results.filter((result) => result.status === status).length
  process.stdout.write(
    `\n${count('pass')} passed, ${count('fail')} failed, ${count('skip')} skipped\n`
  )
  if (args.strict && count('skip') > 0) {
    process.stdout.write('--strict: a skipped step is an error\n')
  }
  process.exit(exitCodeFor(results, args.strict))
}
