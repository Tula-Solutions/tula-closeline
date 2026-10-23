// Checks the running dev stack over real HTTP: `bun run dev:smoke [--strict]`. See
// docs/local-development.md.
//
// Every call has a timeout and a bounded retry. A step whose prerequisite cannot run is reported
// as "skipped: <reason>", never as a pass; `--strict` turns a skip into a failure. The sign-up
// code and the Invitation link are read from the local mailbox (Mailpit) that auth and core send
// to; the services have no other way in for the test and none is added. No code, token, password,
// link or address is printed: every message is scrubbed of the values this run has seen.
import { origins, randomHex, requestWithRetry, resolvePorts } from './dev-lib.ts'
import { runGoogleSteps } from './dev-smoke-google.ts'

/** How a step ended. */
export type StepStatus = 'pass' | 'fail' | 'skip'

/** One line of the report. */
export type StepResult = { name: string; status: StepStatus; detail: string }

/** Where the services and the mailbox answer. */
export type SmokeTargets = {
  auth: string
  core: string
  playbook: string
  portal: string
  mail: string
  /** The fake Google provider; without it the Google steps cannot tell the fake from real Google. */
  fakeGoogle?: string
}

/** Tunables of a run; the defaults are what the CLI uses. */
export type SmokeOptions = {
  fetchImpl?: typeof fetch
  /** Longest one HTTP call may take. */
  timeoutMs?: number
  /** Longest to wait for an email to reach the mailbox. */
  mailWaitMs?: number
  /** Pause between looks at the mailbox. */
  mailIntervalMs?: number
  /** Longest to wait for a Call or a Deal import to be processed. */
  playbookWaitMs?: number
  /** Pause between looks at a Call or a Deal import. */
  playbookIntervalMs?: number
}

const MAX_BODY_CHARS = 65_536

/** Where core's local default for DEMO_NOTICE_TO sends the Demo Request team notice. */
const DEMO_NOTICE_TO = 'team@closeline.test'

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
  'refresh through the portal with its Origin',
  'create an Invitation',
  'the Invitation email and its link reach the mailbox',
  'create a Team',
  'a second sign-up cannot read the first Organization',
  'a replayed refresh token is refused and ends its session',
] as const

/** The names of the sales-history steps, in the order they run (they need the signed-in Owner). */
export const SALES_HISTORY_STEPS = [
  'confirm the rights wording',
  'upload a Transcript',
  'the first Call created its Deal, open',
  'the Transcript is processed into Moments, not yet in search',
  'upload a Recording',
  'the Recording is transcribed',
  'import a three-row Deal CSV',
  'the import is applied and the Deal has its Outcome',
  'the Outcome reaches the Moments and the Call is in search',
  'a second Organization cannot see any of the sales history',
  'delete the Call and it is gone',
] as const

/** Bytes of a one-second, 8 kHz, mono, 16-bit PCM WAV of silence: the smallest real Recording. */
export function silentWav(seconds = 1): Uint8Array<ArrayBuffer> {
  const rate = 8000
  const data = rate * seconds * 2
  const bytes = new Uint8Array(44 + data)
  const view = new DataView(bytes.buffer)
  const ascii = (at: number, value: string) => {
    for (let i = 0; i < value.length; i++) {
      view.setUint8(at + i, value.charCodeAt(i))
    }
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + data, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, data, true)
  return bytes
}

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

/** The shape the contract gives every error code: `area.reason`, at most 100 characters. */
const CONTRACT_CODE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/
const NOT_A_CODE = '(not a contract error code)'

/**
 * The `error.code` of a contract error body, undefined if there is none, and a fixed placeholder
 * if it does not have the contract's shape: a service must not be able to put text in the report.
 */
function errorCode(json: unknown): string | undefined {
  const code = text(pick(json, 'error', 'code'))
  if (code === undefined) {
    return undefined
  }
  return code.length <= 100 && CONTRACT_CODE.test(code) ? code : NOT_A_CODE
}

/**
 * A value from a service that is printed in the report: only a short plain word, otherwise a fixed
 * placeholder, so a service cannot put text or terminal escapes in the report.
 */
function plain(value: unknown): string {
  return typeof value === 'string' && /^[a-z0-9_-]{1,32}$/.test(value)
    ? value
    : '(unexpected value)'
}

/** The forms a value can take in a message: as is, URL-encoded (either case), JSON-escaped. */
function forms(value: string): string[] {
  const encoded = encodeURIComponent(value)
  return [
    value,
    encoded,
    encoded.replace(/%[0-9A-F]{2}/g, (hex) => hex.toLowerCase()),
    JSON.stringify(value).slice(1, -1),
  ]
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
  members?: { userIds: string[]; membershipIds: string[] }
  invitation?: { id: string; email: string }
  team?: { id: string; name: string }
  rights?: true
  transcript?: { id: string; dealId: string; dealRecordId: string }
  dealOpen?: true
  transcriptReady?: true
  recording?: { id: string }
  dealImport?: { id: string }
  hidden?: true
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
  const remember = (...values: (string | null | undefined)[]) => {
    for (const value of values) {
      if (value) {
        seen.add(value)
      }
    }
  }
  /** A value this run makes up: registered the moment it exists, so it can never be printed. */
  const minted = (value: string) => {
    remember(value)
    return value
  }
  const hide = (message: string) => {
    let out = message
    const all = [...seen].flatMap(forms).sort((a, b) => b.length - a.length)
    for (const value of all) {
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

  // The mailbox. Mailpit's `to:` search is a substring match, so the answer is filtered here: one
  // message, to exactly this address, with this subject. A message that is late is waited for
  // until the deadline; a mailbox that answers wrongly is a mailbox failure, reported at once.
  type Mailed = { ok: true; text: string } | { ok: false; late: boolean; detail: string }
  const mailBroken = (detail: string): Mailed => ({ ok: false, late: false, detail })
  const mailbox = async (to: string, subject: string): Promise<Mailed> => {
    const deadline = Date.now() + (options.mailWaitMs ?? 15_000)
    for (;;) {
      const query = encodeURIComponent(`to:${to}`)
      const found = await call('GET', `${targets.mail}/api/v1/search?query=${query}&limit=10`)
      if (found.status !== 200) {
        return mailBroken(`the mailbox answered ${found.status} to the search`)
      }
      const messages = pick(found.json, 'messages')
      if (!Array.isArray(messages)) {
        return mailBroken('the mailbox search reply is not what Mailpit sends')
      }
      const matches = messages.filter((message) => {
        const recipients = pick(message, 'To')
        return (
          text(pick(message, 'Subject'))?.includes(subject) === true &&
          Array.isArray(recipients) &&
          recipients.some((recipient) => pick(recipient, 'Address') === to)
        )
      })
      if (matches.length > 1) {
        return mailBroken('the mailbox holds more than one such email for this address')
      }
      const id = text(pick(matches[0], 'ID'))
      if (matches.length === 1 && id) {
        const message = await call(
          'GET',
          `${targets.mail}/api/v1/message/${encodeURIComponent(id)}`
        )
        const body = text(pick(message.json, 'Text'))
        if (message.status !== 200 || body === undefined) {
          return mailBroken(`the mailbox answered ${message.status} for the message`)
        }
        return { ok: true, text: body }
      }
      if (Date.now() >= deadline) {
        return { ok: false, late: true, detail: '' }
      }
      await Bun.sleep(options.mailIntervalMs ?? 200)
    }
  }
  /** Why an email could not be read, as a step failure. */
  const unread = (mailed: Extract<Mailed, { ok: false }>, what: string) =>
    mailed.late
      ? fail(`no ${what} email reached the mailbox in time`)
      : fail(`mailbox failure: ${mailed.detail}`)
  /** The one six-digit code in a verification email, or why there is not exactly one. */
  const codeIn = (body: string): { code: string } | { problem: string } => {
    const phrased = [...body.matchAll(/verification code is (\d{6})(?!\d)/g)]
    const numbers = body.match(/(?<!\d)\d{6}(?!\d)/g) ?? []
    if (phrased.length > 1 || numbers.length > 1) {
      return { problem: 'the verification email holds more than one code' }
    }
    const code = phrased[0]?.[1]
    return code === undefined
      ? { problem: 'the verification email has no six-digit code' }
      : { code }
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
      : fail(
          `GET / answered ${response.status} ${type
            .split(';')[0]
            ?.replace(/[^a-z0-9/+.-]/g, '?')
            .slice(0, 40)}`
        )
  })

  await step(
    'core: a Demo Request is accepted, replayed, and its team notice is mailed',
    async () => {
      // Public route, no token. The team notice goes to the local default of DEMO_NOTICE_TO.
      remember(DEMO_NOTICE_TO)
      const company = minted(`Smoke-${crypto.randomUUID().slice(0, 8)}`)
      const key = minted(`smoke-${crypto.randomUUID()}`)
      const body = {
        name: 'Smoke Visitor',
        workEmail: 'smoke.visitor@example.test',
        companyName: company,
        message: 'Sent by dev:smoke.',
        sourcePage: '/smoke',
      }
      const url = `${targets.core}/v1/marketing/demo-requests`
      const headers = { 'idempotency-key': key }
      const first = await call('POST', url, { headers, body })
      if (first.status === 429) {
        return skip(
          'the per-address rate limit is spent (10 an hour); wait, or stop the stack with --down --volumes'
        )
      }
      const id = text(pick(first.json, 'id'))
      if (first.status !== 201 || id === undefined) {
        return fail(`POST answered ${first.status} ${errorCode(first.json) ?? ''}`.trim())
      }
      const replay = await call('POST', url, { headers, body })
      if (replay.status !== 200 || text(pick(replay.json, 'id')) !== id) {
        return fail(`the same key and body answered ${replay.status}, not 200 with the first id`)
      }
      const mailed = await mailbox(DEMO_NOTICE_TO, `Demo Request from ${company}`)
      if (!mailed.ok) {
        return unread(mailed, 'Demo Request team notice')
      }
      return mailed.text.includes(id) ? pass() : fail('the team notice does not name the request')
    }
  )

  await step('core: a Demo Request with a bad body is marketing.invalid_request', async () => {
    const response = await call('POST', `${targets.core}/v1/marketing/demo-requests`, {
      headers: { 'idempotency-key': minted(`smoke-${crypto.randomUUID()}`) },
      body: { name: minted('Bad Visitor'), workEmail: minted('not-an-email') },
    })
    if (response.status === 429) {
      return skip('the per-address rate limit is spent (10 an hour)')
    }
    return response.status === 400 && errorCode(response.json) === 'marketing.invalid_request'
      ? pass()
      : fail(`answered ${response.status} ${errorCode(response.json) ?? ''}`.trim())
  })

  await step('playbook is ready', async () => {
    const response = await request(`${targets.playbook}/readyz`)
    await response.body?.cancel()
    return response.status === 200 ? pass() : fail(`GET /readyz answered ${response.status}`)
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
      {
        headers: { authorization: `Bearer ${minted(randomHex(24))}` },
        expected: 'auth.token_invalid',
      },
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
  const email = minted(`smoke-${runId}@closeline-smoke.test`)
  const inviteeEmail = minted(`invitee-${runId}@closeline-smoke.test`)
  const crossEmail = minted(`cross-${runId}@closeline-smoke.test`)
  const password = minted(`${randomHex(16)}-Aa1`)

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
    const mailed = await mailbox(email, 'verification code')
    if (!mailed.ok) {
      return unread(mailed, 'verification')
    }
    const found = codeIn(mailed.text)
    if ('problem' in found) {
      return fail(found.problem)
    }
    remember(found.code)
    state.code = found.code
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
    return pass(`${plain(pick(found.json, 'status'))}, ${plain(pick(found.json, 'region'))}`)
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
    state.members = {
      userIds: items.map((item) => text(pick(item, 'userId')) ?? ''),
      membershipIds: items.map((item) => text(pick(item, 'id')) ?? ''),
    }
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
    // Only the refresh token must change: an access token carries the session id and a
    // one-second issue time, so one issued in the same second as the last is the same string.
    if (next.refreshToken === session.refreshToken) {
      return fail('refresh did not rotate the refresh token')
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

  // The browser path: the portal calls only its own origin, its dev server proxies to auth, and
  // auth must allow that Origin (SESSION_ALLOWED_ORIGINS), or the portal cannot load (issue 86).
  await flow('refresh through the portal with its Origin', ['session'], [], async () => {
    const session = state.session
    if (!session) {
      return fail('no session')
    }
    const portalOrigin = new URL(targets.portal).origin
    const found = await call('POST', `${targets.portal}/v1/client/sessions/refresh`, {
      headers: { origin: portalOrigin },
      body: { refreshToken: session.refreshToken },
      once: true,
    })
    const next = sessionFrom(found.json)
    if (found.status !== 200 || !next) {
      return fail(
        `POST ${portalOrigin}/v1/client/sessions/refresh with Origin ${portalOrigin} answered ${found.status} ${errorCode(found.json) ?? ''}; auth needs SESSION_ALLOWED_ORIGINS=${portalOrigin}`.trim()
      )
    }
    state.session = next
    return pass('auth allows the portal origin')
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
    if (found.status !== 201) {
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
      const mailed = await mailbox(inviteeEmail, 'invited')
      if (!mailed.ok) {
        return unread(mailed, 'Invitation')
      }
      const links = mailed.text.match(/https?:\/\/[^\s"<>]*#invitation=[^\s"<>]*/g) ?? []
      remember(...links)
      if (links.length > 1) {
        return fail('the Invitation email holds more than one accept link')
      }
      const link = links[0]
      if (link === undefined) {
        return fail('the Invitation email has no accept link')
      }
      const token = link.split('#invitation=')[1] ?? ''
      remember(token)
      if (!/^[A-Za-z0-9_-]{22,256}$/.test(token)) {
        return fail('the accept link has no valid invitation token')
      }
      const url = new URL(link)
      if (url.origin !== new URL(targets.portal).origin || url.pathname !== '/sign-up') {
        return fail('the accept link does not point at the portal sign-up page')
      }
      return pass('the link points at the portal sign-up page')
    }
  )

  await flow('create a Team', ['session'], ['team'], async () => {
    const session = state.session
    if (!session) {
      return fail('no session')
    }
    const name = `Smoke team ${runId}`
    const found = await call('POST', `${targets.core}/v1/teams`, {
      headers: { ...authed(session), 'idempotency-key': `smoke-${runId}-team` },
      body: { name },
      once: true,
    })
    const id = text(pick(found.json, 'id'))
    if (found.status !== 201 || !id) {
      return fail(`POST /v1/teams answered ${found.status} ${errorCode(found.json) ?? ''}`.trim())
    }
    state.team = { id, name }
    remember(id)
    return pass()
  })

  await flow(
    'a second sign-up cannot read the first Organization',
    ['session', 'members', 'invitation', 'team'],
    [],
    async () => {
      const invitation = state.invitation
      const firstMembers = state.members
      const team = state.team
      if (!state.session || !firstMembers || !invitation || !team) {
        return fail('missing the first Organization')
      }
      // An access token lasts 60 s, so the first user gets a fresh one for the checks below.
      const firstIn = await signIn(email, password)
      if ('error' in firstIn) {
        return fail(firstIn.error ?? 'the first sign-in failed')
      }
      const first = firstIn.session
      const email2 = minted(`second-${runId}@closeline-smoke.test`)
      const password2 = minted(`${randomHex(16)}-Aa1`)
      const started = await startSignUp(email2, password2, `Smoke second ${runId}`)
      if (started.status !== 200 || !started.id || !started.secret) {
        return fail(`the second sign-up answered ${started.status} ${started.code ?? ''}`.trim())
      }
      const mailed = await mailbox(email2, 'verification code')
      if (!mailed.ok) {
        return unread(mailed, 'second verification')
      }
      const found = codeIn(mailed.text)
      if ('problem' in found) {
        return fail(`the second sign-up: ${found.problem}`)
      }
      remember(found.code)
      const verified = await verify({ id: started.id, secret: started.secret }, found.code)
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
      const other = authed(token)
      if (token.organizationId === first.organizationId) {
        return fail('the second user was put into the first Organization')
      }
      const firstIds = [
        first.organizationId,
        invitation.id,
        invitation.email,
        email,
        team.id,
        ...firstMembers.userIds,
        ...firstMembers.membershipIds,
      ].filter((value) => value !== '')
      const leaks = (json: unknown) => {
        const body = JSON.stringify(json) ?? ''
        return firstIds.filter((value) => body.includes(value))
      }
      const core = (path: string) => `${targets.core}${path}`
      const status = (response: { status: number; json: unknown }) =>
        `${response.status} ${errorCode(response.json) ?? ''}`.trim()

      // 1. Reads with the second token: its own Organization, nothing of the first.
      const reads = {
        'GET /v1/organization': await call('GET', core('/v1/organization'), { headers: other }),
        'GET /v1/members': await call('GET', core('/v1/members'), { headers: other }),
        'GET /v1/invitations': await call('GET', core('/v1/invitations'), { headers: other }),
        'GET /v1/teams': await call('GET', core('/v1/teams'), { headers: other }),
      }
      for (const [label, response] of Object.entries(reads)) {
        if (response.status !== 200) {
          return fail(`${label} answered ${status(response)} for the second user`)
        }
        if (leaks(response.json).length > 0) {
          return fail(`${label} returned data of the first Organization to the second user`)
        }
      }
      if (pick(reads['GET /v1/organization'].json, 'id') !== token.organizationId) {
        return fail('core returned an Organization other than the one in the second token')
      }
      const ownMembers = pick(reads['GET /v1/members'].json, 'items')
      if (!Array.isArray(ownMembers) || ownMembers.length !== 1) {
        return fail('the second user does not see exactly their own member')
      }
      const ownMembershipId = text(pick(ownMembers[0], 'id')) ?? ''

      // 2. The first Organization id sent with the second token, where a service might read it:
      //    ignored (the second Organization answers) or refused, never obeyed.
      const sentWith = [
        ['header', '/v1/organization', { 'x-organization-id': first.organizationId }],
        ['query', `/v1/organization?organizationId=${first.organizationId}`, {}],
        ['header', '/v1/invitations', { 'x-organization-id': first.organizationId }],
        ['query', `/v1/invitations?organizationId=${first.organizationId}`, {}],
      ] as const
      for (const [where, path, extra] of sentWith) {
        const response = await call('GET', core(path), { headers: { ...other, ...extra } })
        const refused = [400, 403, 404, 422].includes(response.status)
        const ignored =
          response.status === 200 &&
          leaks(response.json).length === 0 &&
          (path.startsWith('/v1/organization')
            ? pick(response.json, 'id') === token.organizationId
            : true)
        if (!(refused || ignored)) {
          return fail(
            `core obeyed an Organization id sent in a ${where} with the second token: GET ${path.split('?')[0]} answered ${response.status}`
          )
        }
      }

      // 3. Writes by id against the first Organization with the second token: the documented
      //    not-found, and nothing changes.
      const writes: {
        label: string
        method: string
        path: string
        body?: unknown
        code: string
      }[] = [
        {
          label: 'DELETE /v1/invitations/{invitationId}',
          method: 'DELETE',
          path: `/v1/invitations/${invitation.id}`,
          code: 'invitation.not_found',
        },
        {
          label: 'PATCH /v1/teams/{teamId}',
          method: 'PATCH',
          path: `/v1/teams/${team.id}`,
          body: { name: 'taken over' },
          code: 'team.not_found',
        },
        {
          label: 'DELETE /v1/teams/{teamId}',
          method: 'DELETE',
          path: `/v1/teams/${team.id}`,
          code: 'team.not_found',
        },
        {
          label: 'POST /v1/teams/{teamId}/members',
          method: 'POST',
          path: `/v1/teams/${team.id}/members`,
          body: { membershipId: ownMembershipId },
          code: 'team.not_found',
        },
        {
          label: 'PATCH /v1/members/{membershipId}',
          method: 'PATCH',
          path: `/v1/members/${firstMembers.membershipIds[0] ?? ''}`,
          body: { role: 'rep' },
          code: 'member.not_found',
        },
        {
          label: 'DELETE /v1/members/{membershipId}',
          method: 'DELETE',
          path: `/v1/members/${firstMembers.membershipIds[0] ?? ''}`,
          code: 'member.not_found',
        },
        {
          label: 'DELETE /v1/teams/{teamId}/members/{membershipId}',
          method: 'DELETE',
          path: `/v1/teams/${team.id}/members/${ownMembershipId}`,
          code: 'team.not_found',
        },
        {
          label: 'POST /v1/invitations with the first Organization teamId',
          method: 'POST',
          path: '/v1/invitations',
          body: { email: crossEmail, role: 'rep', teamId: team.id },
          code: 'team.not_found',
        },
      ]
      for (const [index, write] of writes.entries()) {
        const response = await call(write.method, core(write.path), {
          headers: {
            ...other,
            'idempotency-key': `smoke-${runId}-x${index}`,
          },
          body: write.body,
          once: true,
        })
        if (response.status !== 404 || errorCode(response.json) !== write.code) {
          return fail(
            `${write.label} by the second user answered ${status(response)}, not 404 ${write.code}`
          )
        }
      }

      // 4. The first Organization is as it was.
      const stillInvitations = await call('GET', core('/v1/invitations'), {
        headers: authed(first),
      })
      const invitationItems = pick(stillInvitations.json, 'items')
      const stillPending =
        Array.isArray(invitationItems) &&
        invitationItems.some(
          (item) => pick(item, 'id') === invitation.id && pick(item, 'state') === 'pending'
        )
      if (!stillPending) {
        return fail('the first Organization lost its pending Invitation')
      }
      const stillTeams = await call('GET', core('/v1/teams'), { headers: authed(first) })
      const teamItems = pick(stillTeams.json, 'items')
      const stillTeam =
        Array.isArray(teamItems) &&
        teamItems.some((item) => pick(item, 'id') === team.id && pick(item, 'name') === team.name)
      if (!stillTeam) {
        return fail('the first Organization lost its Team or its name was changed')
      }
      const stillMembers = await call('GET', core('/v1/members'), { headers: authed(first) })
      const memberItems = pick(stillMembers.json, 'items')
      if (
        !Array.isArray(memberItems) ||
        !memberItems.some(
          (item) =>
            pick(item, 'id') === firstMembers.membershipIds[0] && pick(item, 'role') === 'owner'
        )
      ) {
        return fail('the first Organization member is no longer its Owner')
      }

      // 5. Positive controls: the first user can do to their own what the second could not, so a
      //    route that answers 404 to everyone fails here and not as a pass above.
      const renamed = await call('PATCH', core(`/v1/teams/${team.id}`), {
        headers: authed(first),
        body: { name: `${team.name} renamed` },
        once: true,
      })
      if (renamed.status !== 200) {
        return fail(
          `the first user could not rename their own Team: PATCH /v1/teams/{teamId} answered ${status(renamed)}`
        )
      }
      const removed = await call('DELETE', core(`/v1/teams/${team.id}`), {
        headers: authed(first),
        once: true,
      })
      if (removed.status !== 204) {
        return fail(
          `the first user could not delete their own Team: DELETE /v1/teams/{teamId} answered ${status(removed)}`
        )
      }
      const revoked = await call('DELETE', core(`/v1/invitations/${invitation.id}`), {
        headers: authed(first),
        once: true,
      })
      if (revoked.status !== 204) {
        return fail(
          `the first user could not revoke their own Invitation: DELETE /v1/invitations/{invitationId} answered ${status(revoked)}`
        )
      }
      const after = await call('GET', core('/v1/invitations'), { headers: authed(first) })
      const afterItems = pick(after.json, 'items')
      if (
        !Array.isArray(afterItems) ||
        afterItems.some((item) => pick(item, 'id') === invitation.id)
      ) {
        return fail('the revoked Invitation is still listed as pending')
      }
      return pass(
        'different Organizations; nothing of the first was returned or changed; the first can change its own'
      )
    }
  )

  // The sales history, as the Owner: rights, a Transcript, a Recording and a Deal CSV, all through
  // the playbook's public routes, then a second Organization that must see none of it. An access
  // token lasts 60 s and a wait can be longer, so each phase signs in again.
  const playbook = (path: string) => `${targets.playbook}${path}`
  const salesIds: string[] = []
  const dealId = minted(`smoke-${runId}-a`)
  const dealIdLost = minted(`smoke-${runId}-b`)
  const dealIdThird = minted(`smoke-${runId}-c`)
  const waitMs = options.playbookWaitMs ?? 90_000
  const idle = options.playbookIntervalMs ?? 500
  const statusOf = (response: { status: number; json: unknown }) =>
    `${response.status} ${errorCode(response.json) ?? ''}`.trim()

  /** A fresh Owner session, or why there is none. */
  const owner = async (): Promise<{ session: Session } | { problem: string }> => {
    const signedIn = await signIn(email, password)
    return 'error' in signedIn
      ? { problem: `the sign-in for the sales history failed: ${signedIn.error}` }
      : { session: signedIn.session }
  }

  /** One multipart upload, sent once. Text fields go before the file, as the playbook requires. */
  const upload = async (
    path: string,
    session: Session,
    fields: Record<string, string>,
    file: { name: string; type: string; bytes: string | Uint8Array<ArrayBuffer> },
    key: string
  ) => {
    const form = new FormData()
    for (const [name, value] of Object.entries(fields)) {
      form.append(name, value)
    }
    form.append('file', new File([file.bytes], file.name, { type: file.type }))
    const response = await request(playbook(path), {
      method: 'POST',
      idempotent: false,
      headers: { ...authed(session), 'idempotency-key': key },
      body: form,
    })
    return { status: response.status, json: await readJson(response) }
  }

  /** Reads `path` as the Owner (signing in again when the token is old) until `done` or the wait ends. */
  const waitFor = async (
    path: string,
    done: (json: unknown) => 'yes' | 'no' | { failed: string }
  ): Promise<{ json: unknown } | { problem: string }> => {
    const deadline = Date.now() + waitMs
    let current = await owner()
    let signedAt = Date.now()
    for (;;) {
      if (Date.now() >= deadline) {
        return { problem: `not finished within ${Math.round(waitMs / 1000)} s` }
      }
      if ('problem' in current) {
        return current
      }
      if (Date.now() - signedAt > 40_000) {
        current = await owner()
        signedAt = Date.now()
        continue
      }
      const found = await call('GET', playbook(path), { headers: authed(current.session) })
      if (found.status !== 200) {
        return {
          problem: `GET ${path.replace(/[a-z]+_[0-9a-f]{32}/g, '{id}')} answered ${statusOf(found)}`,
        }
      }
      const verdict = done(found.json)
      if (verdict === 'yes') {
        return { json: found.json }
      }
      if (verdict !== 'no') {
        return { problem: verdict.failed }
      }
      await Bun.sleep(idle)
    }
  }

  await flow('confirm the rights wording', ['session'], ['rights'], async () => {
    const who = await owner()
    if ('problem' in who) {
      return fail(who.problem)
    }
    const headers = authed(who.session)
    const before = await call('GET', playbook('/v1/playbook/rights-confirmation'), { headers })
    const version = pick(before.json, 'currentWordingVersion')
    if (before.status !== 200 || typeof version !== 'number') {
      return fail(`GET /v1/playbook/rights-confirmation answered ${statusOf(before)}`)
    }
    if (pick(before.json, 'confirmed') !== false) {
      return fail('a new Organization already has a rights confirmation')
    }
    const refused = await upload(
      '/v1/playbook/calls',
      who.session,
      { dealId, rep: JSON.stringify({ by: 'speaker', label: 'Rep' }) },
      { name: 'call.txt', type: 'text/plain', bytes: 'Rep: hello\nProspect: hi\n' },
      `smoke-${runId}-norights`
    )
    if (refused.status !== 403 || errorCode(refused.json) !== 'rights.confirmation_required') {
      return fail(
        `a Call upload before the confirmation answered ${statusOf(refused)}, not 403 rights.confirmation_required`
      )
    }
    const put = await call('PUT', playbook('/v1/playbook/rights-confirmation'), {
      headers,
      body: { wordingVersion: version },
    })
    if (put.status !== 200 || pick(put.json, 'confirmed') !== true) {
      return fail(`PUT /v1/playbook/rights-confirmation answered ${statusOf(put)}`)
    }
    state.rights = true
    return pass(`wording version ${version}`)
  })

  await flow('upload a Transcript', ['rights'], ['transcript'], async () => {
    const who = await owner()
    if ('problem' in who) {
      return fail(who.problem)
    }
    const transcriptText = [
      'Rep: Thanks for taking the time today.',
      'Prospect: Happy to, we are looking at tools for our team.',
      'Rep: What is the biggest problem you want to solve?',
      'Prospect: Onboarding takes too long and the price worries me.',
      'Rep: Understood, let me show how others cut that in half.',
      'Prospect: That would help, send me a proposal.',
      '',
    ].join('\n')
    const sent = await upload(
      '/v1/playbook/calls',
      who.session,
      { dealId, rep: JSON.stringify({ by: 'speaker', label: 'Rep' }) },
      { name: 'smoke-call.txt', type: 'text/plain', bytes: transcriptText },
      `smoke-${runId}-transcript`
    )
    const id = text(pick(sent.json, 'id'))
    const record = text(pick(sent.json, 'dealRecordId'))
    if (sent.status !== 201 || !id || !record) {
      return fail(`POST /v1/playbook/calls answered ${statusOf(sent)}`)
    }
    if (pick(sent.json, 'kind') !== 'transcript' || pick(sent.json, 'state') !== 'uploaded') {
      return fail(
        `the new Call is ${plain(pick(sent.json, 'kind'))} in state ${plain(pick(sent.json, 'state'))}`
      )
    }
    remember(id, record)
    salesIds.push(id, record)
    state.transcript = { id, dealId, dealRecordId: record }
    return pass()
  })

  await flow('the first Call created its Deal, open', ['transcript'], ['dealOpen'], async () => {
    const who = await owner()
    const first = state.transcript
    if ('problem' in who || !first) {
      return fail('problem' in who ? who.problem : 'no Transcript')
    }
    const found = await call('POST', playbook('/v1/playbook/deals/lookup'), {
      headers: authed(who.session),
      body: { dealId: first.dealId },
    })
    if (found.status !== 200 || pick(found.json, 'id') !== first.dealRecordId) {
      return fail(`POST /v1/playbook/deals/lookup answered ${statusOf(found)}`)
    }
    const outcome = pick(found.json, 'outcome')
    if (outcome !== 'open') {
      return fail(`the new Deal is ${plain(outcome)}, not open`)
    }
    // The Deal's own callCount is not read: the Calls of the Deal are listed instead.
    const listed = await call(
      'GET',
      playbook(`/v1/playbook/calls?dealRecordId=${first.dealRecordId}`),
      { headers: authed(who.session) }
    )
    const items = pick(listed.json, 'items')
    if (
      listed.status !== 200 ||
      !Array.isArray(items) ||
      items.length !== 1 ||
      pick(items[0], 'id') !== first.id
    ) {
      return fail(`the Deal does not list the Call: ${statusOf(listed)}`)
    }
    state.dealOpen = true
    return pass()
  })

  await flow(
    'the Transcript is processed into Moments, not yet in search',
    ['transcript'],
    ['transcriptReady'],
    async () => {
      const first = state.transcript
      if (!first) {
        return fail('no Transcript')
      }
      const done = await waitFor(`/v1/playbook/calls/${first.id}`, (json) => {
        const state_ = pick(json, 'state')
        if (state_ === 'failed') {
          return { failed: `the Call failed: ${plain(pick(json, 'failureReason'))}` }
        }
        return state_ === 'ready' ? 'yes' : 'no'
      })
      if ('problem' in done) {
        return fail(done.problem)
      }
      // The contract: a Call is in search only when it is ready and its Deal is won.
      if (pick(done.json, 'inSearch') !== false) {
        return fail('the Call of an open Deal is in search')
      }
      state.transcriptReady = true
      return pass('ready; its Deal is open, so it is not in search')
    }
  )

  await flow('upload a Recording', ['rights'], ['recording'], async () => {
    const who = await owner()
    if ('problem' in who) {
      return fail(who.problem)
    }
    const sent = await upload(
      '/v1/playbook/calls',
      who.session,
      { dealId: dealIdLost },
      { name: 'smoke-call.wav', type: 'audio/wav', bytes: silentWav() },
      `smoke-${runId}-recording`
    )
    const id = text(pick(sent.json, 'id'))
    if (sent.status !== 201 || !id) {
      return fail(`POST /v1/playbook/calls (Recording) answered ${statusOf(sent)}`)
    }
    if (pick(sent.json, 'kind') !== 'recording') {
      return fail('the new Call is not a Recording')
    }
    remember(id)
    salesIds.push(id)
    state.recording = { id }
    return pass()
  })

  await flow('the Recording is transcribed', ['recording'], [], async () => {
    const recording = state.recording
    if (!recording) {
      return fail('no Recording')
    }
    const done = await waitFor(`/v1/playbook/calls/${recording.id}`, (json) => {
      const state_ = pick(json, 'state')
      if (state_ === 'failed') {
        return { failed: `the Recording failed: ${plain(pick(json, 'failureReason'))}` }
      }
      return state_ === 'awaiting_rep' || state_ === 'ready' ? 'yes' : 'no'
    })
    return 'problem' in done ? fail(done.problem) : pass(plain(pick(done.json, 'state')))
  })

  await flow('import a three-row Deal CSV', ['rights', 'transcript'], ['dealImport'], async () => {
    const who = await owner()
    const first = state.transcript
    if ('problem' in who || !first) {
      return fail('problem' in who ? who.problem : 'no Transcript')
    }
    const csv = [
      'deal_id,outcome,closed_at,amount,currency,name',
      `${dealId},won,2025-01-15,1200.50,USD,Smoke won`,
      `${dealIdLost},lost,2025-02-01,300,USD,Smoke lost`,
      `${dealIdThird},won,2025-03-10,,,`,
      '',
    ].join('\n')
    const sent = await upload(
      '/v1/playbook/deal-imports',
      who.session,
      {},
      { name: 'smoke-deals.csv', type: 'text/csv', bytes: csv },
      `smoke-${runId}-import`
    )
    const id = text(pick(sent.json, 'id'))
    if (sent.status !== 202 || !id) {
      return fail(`POST /v1/playbook/deal-imports answered ${statusOf(sent)}`)
    }
    remember(id)
    salesIds.push(id)
    state.dealImport = { id }
    return pass()
  })

  await flow(
    'the import is applied and the Deal has its Outcome',
    ['dealImport', 'transcript'],
    [],
    async () => {
      const imported = state.dealImport
      const first = state.transcript
      if (!imported || !first) {
        return fail('no import')
      }
      const done = await waitFor(`/v1/playbook/deal-imports/${imported.id}`, (json) => {
        const state_ = pick(json, 'state')
        if (state_ === 'failed') {
          return { failed: `the import failed: ${plain(pick(json, 'failureReason'))}` }
        }
        return state_ === 'completed' ? 'yes' : 'no'
      })
      if ('problem' in done) {
        return fail(done.problem)
      }
      const counts = ['rowCount', 'appliedCount', 'rejectedCount'].map((key) =>
        pick(done.json, key)
      )
      if (counts.join() !== '3,3,0') {
        return fail(
          `the import counted rows/applied/rejected as ${counts.map((c) => (typeof c === 'number' ? c : '?')).join('/')}, not 3/3/0`
        )
      }
      const who = await owner()
      if ('problem' in who) {
        return fail(who.problem)
      }
      const headers = authed(who.session)
      const rows = await call('GET', playbook(`/v1/playbook/deal-imports/${imported.id}/rows`), {
        headers,
      })
      const items = pick(rows.json, 'items')
      if (rows.status !== 200 || !Array.isArray(items) || items.length !== 3) {
        return fail(
          `GET /v1/playbook/deal-imports/{id}/rows answered ${statusOf(rows)} with ${Array.isArray(items) ? items.length : 'no'} rows, not 3`
        )
      }
      const found = await call('POST', playbook('/v1/playbook/deals/lookup'), {
        headers,
        body: { dealId: first.dealId },
      })
      if (
        found.status !== 200 ||
        pick(found.json, 'outcome') !== 'won' ||
        pick(found.json, 'appearedInImport') !== true
      ) {
        return fail(
          `the Deal of the Transcript is ${plain(pick(found.json, 'outcome'))} after the import, not won`
        )
      }
      const listed = await call('GET', playbook('/v1/playbook/deals?limit=100'), { headers })
      const deals = pick(listed.json, 'items')
      if (listed.status !== 200 || !Array.isArray(deals) || deals.length !== 3) {
        return fail(
          `the Deal list holds ${Array.isArray(deals) ? deals.length : 'no'} Deals, not 3`
        )
      }
      return pass('3 rows applied, 0 rejected; the Transcript Deal is won')
    }
  )

  await flow(
    'the Outcome reaches the Moments and the Call is in search',
    ['transcriptReady', 'dealImport', 'transcript'],
    [],
    async () => {
      const first = state.transcript
      if (!first) {
        return fail('no Transcript')
      }
      const done = await waitFor(`/v1/playbook/calls/${first.id}`, (json) =>
        pick(json, 'inSearch') === true ? 'yes' : 'no'
      )
      return 'problem' in done
        ? fail(`the Call of a won Deal did not reach search: ${done.problem}`)
        : pass('the re-tag job ran; ready and won, so in search')
    }
  )

  await flow(
    'a second Organization cannot see any of the sales history',
    ['transcript', 'dealImport', 'recording'],
    ['hidden'],
    async () => {
      const first = state.transcript
      const imported = state.dealImport
      const recording = state.recording
      if (!first || !imported || !recording) {
        return fail('missing the first Organization sales history')
      }
      const email2 = minted(`sales-${runId}@closeline-smoke.test`)
      const password2 = minted(`${randomHex(16)}-Aa1`)
      const started = await startSignUp(email2, password2, `Smoke sales ${runId}`)
      if (started.status !== 200 || !started.id || !started.secret) {
        return fail(
          `the sign-up for the sales check answered ${started.status} ${started.code ?? ''}`.trim()
        )
      }
      const mailed = await mailbox(email2, 'verification code')
      if (!mailed.ok) {
        return unread(mailed, 'verification')
      }
      const found = codeIn(mailed.text)
      if ('problem' in found) {
        return fail(`the sign-up for the sales check: ${found.problem}`)
      }
      remember(found.code)
      const verified = await verify({ id: started.id, secret: started.secret }, found.code)
      if (verified.status !== 200) {
        return fail(
          `the sales-check verify answered ${verified.status} ${verified.code ?? ''}`.trim()
        )
      }
      const second = await signIn(email2, password2)
      if ('error' in second) {
        return fail(second.error ?? 'the sales-check sign-in failed')
      }
      const other = authed(second.session)
      const firstIds = [...salesIds, dealId, dealIdLost, dealIdThird]
      const leaks = (json: unknown) => {
        const body = JSON.stringify(json) ?? ''
        return firstIds.filter((value) => body.includes(value))
      }

      // Its own rights are not confirmed: the first Organization's confirmation does not carry over.
      const rights = await call('GET', playbook('/v1/playbook/rights-confirmation'), {
        headers: other,
      })
      if (rights.status !== 200 || pick(rights.json, 'confirmed') !== false) {
        return fail('the second Organization shows a rights confirmation it never made')
      }
      // The second Organization owns a Deal, a Call and an import of its own, so a list that always
      // answers empty cannot pass: each must show its own and none of the first's.
      const ownDealId = minted(`smoke-${runId}-own`)
      const confirmedOwn = await call('PUT', playbook('/v1/playbook/rights-confirmation'), {
        headers: other,
        body: { wordingVersion: pick(rights.json, 'currentWordingVersion') },
      })
      if (confirmedOwn.status !== 200) {
        return fail(
          `the second Organization could not confirm its rights: ${statusOf(confirmedOwn)}`
        )
      }
      const ownCall = await upload(
        '/v1/playbook/calls',
        second.session,
        { dealId: ownDealId, rep: JSON.stringify({ by: 'speaker', label: 'Rep' }) },
        {
          name: 'own-call.txt',
          type: 'text/plain',
          bytes: 'Rep: hello there\nProspect: hi, go on\n',
        },
        `smoke-${runId}-own-call`
      )
      const ownCallId = text(pick(ownCall.json, 'id'))
      const ownDealRecord = text(pick(ownCall.json, 'dealRecordId'))
      const ownImport = await upload(
        '/v1/playbook/deal-imports',
        second.session,
        {},
        {
          name: 'own-deals.csv',
          type: 'text/csv',
          bytes: `deal_id,outcome,closed_at,amount,currency\n${ownDealId}-csv,won,,,\n`,
        },
        `smoke-${runId}-own-import`
      )
      const ownImportId = text(pick(ownImport.json, 'id'))
      if (ownCall.status !== 201 || !ownCallId || !ownDealRecord) {
        return fail(`the second Organization own Call upload answered ${statusOf(ownCall)}`)
      }
      if (ownImport.status !== 202 || !ownImportId) {
        return fail(`the second Organization own import upload answered ${statusOf(ownImport)}`)
      }
      remember(ownCallId, ownDealRecord, ownImportId)
      const lists: [string, string, string][] = [
        ['GET /v1/playbook/calls', '/v1/playbook/calls', ownCallId],
        ['GET /v1/playbook/deals', '/v1/playbook/deals', ownDealRecord],
        ['GET /v1/playbook/deal-imports', '/v1/playbook/deal-imports', ownImportId],
      ]
      for (const [label, path, own] of lists) {
        const listed = await call('GET', playbook(path), { headers: other })
        const items = pick(listed.json, 'items')
        if (listed.status !== 200 || !Array.isArray(items)) {
          return fail(`${label} answered ${statusOf(listed)} for the second Organization`)
        }
        if (leaks(listed.json).length > 0) {
          return fail(`${label} returned sales history of the first Organization`)
        }
        if (!items.some((item) => pick(item, 'id') === own)) {
          return fail(`${label} does not list the second Organization's own item`)
        }
      }
      const deleted = await call('GET', playbook('/v1/playbook/calls?state=deleted'), {
        headers: other,
      })
      if (leaks(deleted.json).length > 0) {
        return fail('the list of deleted Calls returned a Call of the first Organization')
      }
      const byId: [string, string, string, string, unknown?][] = [
        ['GET', `/v1/playbook/calls/${first.id}`, 'call.not_found', 'a Transcript'],
        ['GET', `/v1/playbook/calls/${recording.id}`, 'call.not_found', 'a Recording'],
        ['DELETE', `/v1/playbook/calls/${first.id}`, 'call.not_found', 'delete a Call'],
        ['POST', `/v1/playbook/calls/${first.id}/restore`, 'call.not_found', 'restore a Call'],
        [
          'PUT',
          `/v1/playbook/calls/${first.id}/rep`,
          'call.not_found',
          'change a Rep',
          { rep: { by: 'speaker', label: 'Prospect' } },
        ],
        ['GET', `/v1/playbook/deals/${first.dealRecordId}`, 'deal.not_found', 'a Deal'],
        [
          'PUT',
          `/v1/playbook/deals/${first.dealRecordId}/outcome`,
          'deal.not_found',
          'set an Outcome',
          { outcome: 'lost' },
        ],
        ['GET', `/v1/playbook/deal-imports/${imported.id}`, 'deal_import.not_found', 'an import'],
        [
          'GET',
          `/v1/playbook/deal-imports/${imported.id}/rows`,
          'deal_import.not_found',
          'an import report',
        ],
      ]
      for (const [method, path, code, what, body] of byId) {
        const response = await call(method, playbook(path), {
          headers: other,
          body,
          once: method !== 'GET',
        })
        if (response.status !== 404 || errorCode(response.json) !== code) {
          return fail(
            `reaching ${what} of the first Organization answered ${statusOf(response)}, not 404 ${code}`
          )
        }
      }
      const lookup = await call('POST', playbook('/v1/playbook/deals/lookup'), {
        headers: other,
        body: { dealId },
      })
      if (lookup.status !== 404 || errorCode(lookup.json) !== 'deal.not_found') {
        return fail(
          `looking up the Deal of the first Organization answered ${statusOf(lookup)}, not 404 deal.not_found`
        )
      }
      // Positive control: the first Organization's data is still all there and unchanged.
      const again = await owner()
      if ('problem' in again) {
        return fail(again.problem)
      }
      const still = await call('GET', playbook(`/v1/playbook/calls/${first.id}`), {
        headers: authed(again.session),
      })
      if (still.status !== 200 || pick(still.json, 'state') === 'deleted') {
        return fail('the first Call changed or went missing during the second Organization checks')
      }
      state.hidden = true
      return pass(
        'its own items listed and none of the first; every id answered 404 with its documented code; the first is unchanged'
      )
    }
  )

  await flow('delete the Call and it is gone', ['transcript', 'hidden'], [], async () => {
    const who = await owner()
    const first = state.transcript
    if ('problem' in who || !first) {
      return fail('problem' in who ? who.problem : 'no Transcript')
    }
    const headers = authed(who.session)
    const removed = await call('DELETE', playbook(`/v1/playbook/calls/${first.id}`), {
      headers,
      once: true,
    })
    if (
      removed.status !== 200 ||
      pick(removed.json, 'state') !== 'deleted' ||
      pick(removed.json, 'inSearch') !== false
    ) {
      return fail(
        `DELETE /v1/playbook/calls/{id} answered ${statusOf(removed)} and the Call is not deleted and out of search`
      )
    }
    const read = await call('GET', playbook(`/v1/playbook/calls/${first.id}`), { headers })
    if (read.status !== 200 || pick(read.json, 'state') !== 'deleted') {
      return fail(
        `the Call reads as ${plain(pick(read.json, 'state'))} after the delete, not deleted`
      )
    }
    const listed = await call('GET', playbook('/v1/playbook/calls?limit=100'), { headers })
    const items = pick(listed.json, 'items')
    if (
      listed.status !== 200 ||
      !Array.isArray(items) ||
      items.some((item) => pick(item, 'id') === first.id)
    ) {
      return fail('the deleted Call is still in the list of Calls')
    }
    const again = await call('DELETE', playbook(`/v1/playbook/calls/${first.id}`), {
      headers,
      once: true,
    })
    if (again.status !== 200 || pick(again.json, 'state') !== 'deleted') {
      return fail('deleting a deleted Call again did not answer 200 deleted')
    }
    return pass('state deleted, out of search and out of the list')
  })

  // Sign in with Google, against the stack's fake provider. Independent of the account steps.
  await runGoogleSteps({
    targets,
    request,
    step: async (name, body) => {
      await step(name, body)
      return results.at(-1)?.status ?? 'fail'
    },
    record: (result) => results.push(result),
    remember,
    runId,
  })

  // Last, on a session made only for this: reusing a refresh token may end the whole session.
  await flow(
    'a replayed refresh token is refused and ends its session',
    ['session'],
    [],
    async () => {
      const throwaway = await signIn(email, password)
      if ('error' in throwaway) {
        return fail(throwaway.error ?? 'the sign-in for the replay failed')
      }
      const refreshWith = async (refreshToken: string) => {
        const response = await call('POST', `${targets.auth}/v1/client/sessions/refresh`, {
          body: { refreshToken },
          once: true,
        })
        return {
          status: response.status,
          code: errorCode(response.json),
          session: sessionFrom(response.json),
        }
      }
      const spent = throwaway.session.refreshToken
      const second = await refreshWith(spent)
      const third = second.session ? await refreshWith(second.session.refreshToken) : undefined
      if (second.status !== 200 || !second.session || third?.status !== 200 || !third.session) {
        return fail(
          `two ordinary refreshes did not work: ${second.status} ${second.code ?? ''}, ${third?.status ?? 'not tried'} ${third?.code ?? ''}`.trim()
        )
      }
      const replay = await refreshWith(spent)
      if (replay.status !== 401 || replay.code !== 'session.reuse_detected') {
        return fail(
          `replaying a spent refresh token answered ${replay.status} ${replay.code ?? ''}, not 401 session.reuse_detected`.replace(
            '  ',
            ' '
          )
        )
      }
      const newest = await refreshWith(third.session.refreshToken)
      if (newest.status === 200) {
        return fail('the session is still usable after a refresh token was reused')
      }
      if (
        newest.status !== 401 ||
        !['session.reuse_detected', 'session.revoked'].includes(newest.code ?? '')
      ) {
        return fail(
          `the newest refresh token of a reused session answered ${newest.status} ${newest.code ?? ''}, not 401 session.revoked`
        )
      }
      return pass('the spent token was refused and the session ended')
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
 * skipped step also gives 1, so a skip cannot hide a gap; it is the mode for CI once a workflow
 * runs the stack (hub issue 38; none does yet).
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
