// The Sign in with Google steps of `bun run dev:smoke`. They play the browser against the stack's
// fake Google provider (scripts/dev-fake-google.ts): start, the provider's page, approval, the
// callback through the portal, complete, /me, a second sign-in and a replayed callback. Only a URL
// on the fake provider's own address is ever followed; when the stack uses real Google the steps
// after `start` are skipped, because real Google needs a person. No address, cookie, attempt, state
// or code is printed (the caller scrubs every value passed to `remember`).
import type { SmokeTargets, StepResult, StepStatus } from './dev-smoke.ts'

/** The names of the Google steps, in the order they run (after the account steps). */
export const GOOGLE_STEPS = [
  'google: auth-options says Google is on',
  'google: start returns an authorization URL on the fake provider',
  'google: the fake provider shows its sign-in page',
  'google: approving a new email redirects to the callback on the portal',
  'google: the callback through the portal sends a new person to sign-up',
  'google: complete with an Organization name gives a session',
  'google: /me shows the signed-in person',
  'google: a second sign-in with the same email goes straight to the app with a refresh cookie',
  'google: a replayed callback is refused with oidc.state_invalid',
] as const

/** What the steps need from the smoke run that calls them. */
export type GoogleKit = {
  targets: SmokeTargets
  /** One HTTP request with a timeout and no redirect followed; `idempotent: false` sends once. */
  request: (url: string, init?: RequestInit & { idempotent?: boolean }) => Promise<Response>
  /** Runs a step, records its result and returns how it ended. */
  step: (
    name: string,
    body: () => Promise<{ status: StepStatus; detail: string }>
  ) => Promise<StepStatus>
  /** Adds a result without running anything (a step blocked by an earlier one). */
  record: (result: StepResult) => void
  /** Registers values that must never appear in a message. */
  remember: (...values: (string | null | undefined)[]) => void
  /** This run's random id, for names that must be fresh. */
  runId: string
}

type Outcome = { status: StepStatus; detail: string }
const pass = (detail = ''): Outcome => ({ status: 'pass', detail })
const fail = (detail: string): Outcome => ({ status: 'fail', detail })
const skip = (detail: string): Outcome => ({ status: 'skip', detail })

const REFRESH_COOKIE = /^(?:__Secure-)?tula_refresh=[^;\s]+/
const OIDC_COOKIE = /^((?:__Secure-)?tula_oidc)=([^;\s]+)/
const ATTEMPT_ID = /^[A-Za-z0-9_-]{1,128}$/
const ERROR_CODE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/

const asText = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined

async function jsonOf(response: Response): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse((await response.text()).slice(0, 65_536))
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** The values of a URL's query that must not be printed (not the fixed words like S256). */
function secretParams(url: URL): (string | null)[] {
  return ['state', 'nonce', 'code', 'code_challenge'].map((name) => url.searchParams.get(name))
}

/** A short plain error code from a redirect, or a placeholder, so a service cannot print text. */
function codeOf(value: string | null): string {
  return value !== null && value.length <= 100 && ERROR_CODE.test(value) ? value : '(none)'
}

/** Runs the Google steps and records one result for each. */
export async function runGoogleSteps(kit: GoogleKit): Promise<void> {
  const { targets, request, remember } = kit
  const portal = targets.portal
  const email = `google-${kit.runId}@closeline-smoke.test`
  remember(email)
  const json = { 'content-type': 'application/json' }
  const callbackPath = '/v1/client/google/callback'

  /** Starts an attempt as the portal would: the authorization URL and the attempt cookie. */
  const begin = async (
    intent: 'sign_in' | 'sign_up'
  ): Promise<{ problem: string } | { url: URL; cookie: string }> => {
    const response = await request(`${targets.auth}/v1/client/google/start`, {
      method: 'POST',
      headers: { ...json, origin: portal },
      body: JSON.stringify({ intent }),
      idempotent: false,
    })
    const body = await jsonOf(response)
    const authorizationUrl = asText(body.authorizationUrl)
    const cookie = response.headers
      .getSetCookie()
      .map((value) => OIDC_COOKIE.exec(value))
      .find((match) => match !== null)
    if (response.status !== 200 || !authorizationUrl || !cookie) {
      return { problem: `POST /v1/client/google/start answered ${response.status}` }
    }
    const url = URL.canParse(authorizationUrl) ? new URL(authorizationUrl) : undefined
    if (!url) {
      return { problem: 'the authorization URL is not a URL' }
    }
    remember(cookie[2], authorizationUrl, ...secretParams(url))
    return { url, cookie: `${cookie[1]}=${cookie[2]}` }
  }

  /** Approves as `email` at the fake provider; the callback URL on the portal it redirects to. */
  const approve = async (authorize: URL): Promise<{ problem: string } | { callback: string }> => {
    const issuer = targets.fakeGoogle ?? ''
    const form = new URLSearchParams(authorize.searchParams)
    form.set('email', email)
    const response = await request(`${issuer}/authorize`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      idempotent: false,
    })
    const location = response.headers.get('location')
    const back = location !== null && URL.canParse(location) ? new URL(location) : undefined
    if (response.status !== 302 || !back) {
      return { problem: `POST /authorize at the fake provider answered ${response.status}` }
    }
    remember(back.toString(), ...secretParams(back))
    if (back.origin !== portal || back.pathname !== callbackPath) {
      return { problem: 'the fake provider redirected somewhere other than the portal callback' }
    }
    if (!back.searchParams.get('code') || !back.searchParams.get('state')) {
      return { problem: 'the redirect back carries no code and state' }
    }
    return { callback: back.toString() }
  }

  /** The callback as the browser sends it: through the portal, with the attempt cookie. */
  const callback = async (url: string, cookie: string) => {
    const response = await request(url, { headers: { cookie } })
    await response.body?.cancel()
    const location = response.headers.get('location')
    const to = location === null ? undefined : new URL(location, portal)
    return { status: response.status, to, cookies: response.headers.getSetCookie() }
  }

  let blocker: string | undefined
  let attempt: string | undefined
  let cookie = ''
  let authorize: URL | undefined
  let callbackUrl = ''
  let accessToken = ''
  let replay: { url: string; cookie: string } | undefined

  const run = async (name: string, body: () => Promise<Outcome>) => {
    if (blocker !== undefined) {
      kit.record({ name, status: 'skip', detail: `blocked by ${blocker}` })
      return
    }
    const status = await kit.step(name, body)
    if (status !== 'pass') {
      blocker = `"${name}" (${status === 'skip' ? 'skipped' : 'failed'})`
    }
  }

  await run(GOOGLE_STEPS[0], async () => {
    const response = await request(`${targets.auth}/v1/client/auth-options`)
    const body = await jsonOf(response)
    const google = (body.providers as { google?: unknown } | undefined)?.google
    if (response.status !== 200 || typeof google !== 'boolean') {
      return fail(`GET /v1/client/auth-options answered ${response.status}`)
    }
    return google
      ? pass()
      : skip(
          'Sign in with Google is off in this stack: auth was started without its GOOGLE_* settings'
        )
  })

  await run(GOOGLE_STEPS[1], async () => {
    if (targets.fakeGoogle === undefined) {
      return skip('no fake Google provider address is known for this run')
    }
    const started = await begin('sign_up')
    if ('problem' in started) {
      return fail(started.problem)
    }
    if (started.url.hostname === 'accounts.google.com') {
      return skip(
        'the stack uses real Google (GOOGLE_* are set); the rest of the flow needs a person in a browser'
      )
    }
    if (started.url.origin !== targets.fakeGoogle || started.url.pathname !== '/authorize') {
      return fail('the authorization URL is neither on the fake provider nor on Google')
    }
    authorize = started.url
    cookie = started.cookie
    return pass()
  })

  await run(GOOGLE_STEPS[2], async () => {
    const response = await request(authorize?.toString() ?? '')
    const type = response.headers.get('content-type') ?? ''
    const html = await response.text()
    return response.status === 200 && type.includes('text/html') && html.includes('<form')
      ? pass()
      : fail(`GET /authorize at the fake provider answered ${response.status}, not its page`)
  })

  await run(GOOGLE_STEPS[3], async () => {
    const approved = await approve(authorize as URL)
    if ('problem' in approved) {
      return fail(approved.problem)
    }
    callbackUrl = approved.callback
    return pass()
  })

  await run(GOOGLE_STEPS[4], async () => {
    const found = await callback(callbackUrl, cookie)
    const id = found.to?.searchParams.get('attempt') ?? ''
    if (found.status !== 302 || found.to?.pathname !== '/sign-up/google' || !ATTEMPT_ID.test(id)) {
      return fail(
        `the callback answered ${found.status} to ${found.to?.pathname === '/sign-in' ? `/sign-in?error=${codeOf(found.to.searchParams.get('error'))}` : 'another place'}, not a 302 to /sign-up/google?attempt=`
      )
    }
    remember(id)
    attempt = id
    return pass()
  })

  await run(GOOGLE_STEPS[5], async () => {
    const response = await request(`${targets.auth}/v1/client/google/complete`, {
      method: 'POST',
      headers: { ...json, origin: portal, cookie },
      body: JSON.stringify({ attemptId: attempt, organizationName: `Google ${kit.runId}` }),
      idempotent: false,
    })
    const body = await jsonOf(response)
    const session = body.session as { accessToken?: unknown } | undefined
    const token = asText(session?.accessToken)
    const step = (body.step as { status?: unknown } | undefined)?.status
    const error = asText((body.error as { code?: unknown } | undefined)?.code)
    if (response.status !== 200 || !token || step !== 'complete') {
      return fail(
        `POST /v1/client/google/complete answered ${response.status} ${codeOf(error ?? null) === '(none)' ? '' : codeOf(error ?? null)}`.trim()
      )
    }
    remember(token)
    accessToken = token
    return response.headers.getSetCookie().some((value) => REFRESH_COOKIE.test(value))
      ? pass()
      : fail('complete gave a session but set no refresh cookie')
  })

  await run(GOOGLE_STEPS[6], async () => {
    const response = await request(`${targets.auth}/v1/client/me`, {
      headers: { authorization: `Bearer ${accessToken}` },
    })
    const body = await jsonOf(response)
    if (response.status !== 200) {
      return fail(`GET /v1/client/me answered ${response.status}`)
    }
    return body.email === email ? pass() : fail('/me shows another address than the one signed in')
  })

  await run(GOOGLE_STEPS[7], async () => {
    const started = await begin('sign_in')
    if ('problem' in started) {
      return fail(started.problem)
    }
    const approved = await approve(started.url)
    if ('problem' in approved) {
      return fail(approved.problem)
    }
    replay = { url: approved.callback, cookie: started.cookie }
    const found = await callback(approved.callback, started.cookie)
    if (found.status !== 302 || found.to?.origin !== portal) {
      return fail(`the second callback answered ${found.status}, not a 302 to the app`)
    }
    if (found.to.pathname === '/sign-up/google') {
      return fail('the second sign-in was sent to sign-up again: the person is not recognised')
    }
    if (found.to.pathname === '/sign-in') {
      return fail(`the second sign-in was refused: ${codeOf(found.to.searchParams.get('error'))}`)
    }
    return found.cookies.some((value) => REFRESH_COOKIE.test(value))
      ? pass()
      : fail('the second sign-in went to the app but set no refresh cookie')
  })

  await run(GOOGLE_STEPS[8], async () => {
    const found = await callback(replay?.url ?? '', replay?.cookie ?? '')
    const code = codeOf(found.to?.searchParams.get('error') ?? null)
    return found.status === 302 &&
      found.to?.pathname === '/sign-in' &&
      code === 'oidc.state_invalid'
      ? pass()
      : fail(
          `the replayed callback answered ${found.status} to ${found.to?.pathname === '/sign-in' ? code : 'another place'}, not 302 to /sign-in?error=oidc.state_invalid`
        )
  })
}
