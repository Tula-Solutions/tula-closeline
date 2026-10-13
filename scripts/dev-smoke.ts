// Checks the running dev stack over real HTTP: `bun run dev:smoke`. See docs/local-development.md.
//
// Every call has a timeout and a bounded retry. A step the stack cannot run yet is reported as
// "skipped: <reason>", never as a pass and never as a failure. No token, code or password is
// printed, and none of the services is given a way in for the test.
import { origins, randomHex, requestWithRetry, resolvePorts } from './dev-lib.ts'

/** How a step ended. */
export type StepStatus = 'pass' | 'fail' | 'skip'

/** One line of the report. */
export type StepResult = { name: string; status: StepStatus; detail: string }

/** Where the three services answer. */
export type SmokeTargets = { auth: string; core: string; portal: string }

/** Why the account steps cannot run, once known. */
type Blocked = { reason: string } | undefined

const MAX_BODY_CHARS = 65_536

/** The steps that need a signed-in user, in the order the flow runs them. */
export const ACCOUNT_STEPS = [
  'verify the email code',
  'sign in',
  'core: GET /v1/organization with the access token',
  'core: GET /v1/members with the access token',
  'refresh the session',
  'create an Invitation',
  'a second sign-up cannot read the first Organization',
] as const

type Outcome = { status: StepStatus; detail: string }

/** The `error.code` of a contract error body, or undefined. */
function errorCode(json: unknown): string | undefined {
  const code = (json as { error?: { code?: unknown } } | undefined)?.error?.code
  return typeof code === 'string' ? code : undefined
}

async function readJson(response: Response): Promise<unknown> {
  const text = (await response.text()).slice(0, MAX_BODY_CHARS)
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * Runs the smoke flow against `targets` and returns one result per step. A step that throws is a
 * failure whose detail is the error's message.
 */
export async function runSmoke(
  targets: SmokeTargets,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}
): Promise<StepResult[]> {
  const results: StepResult[] = []
  const request = (url: string, init: RequestInit & { idempotent?: boolean } = {}) =>
    requestWithRetry(url, init, { fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs })

  const step = async (name: string, body: () => Promise<Outcome>) => {
    try {
      results.push({ name, ...(await body()) })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'failed'
      results.push({ name, status: 'fail', detail: message })
    }
  }
  const pass = (detail = ''): Outcome => ({ status: 'pass', detail })
  const fail = (detail: string): Outcome => ({ status: 'fail', detail })

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

  await step('auth publishes its signing keys', async () => {
    const response = await request(`${targets.auth}/.well-known/jwks.json`)
    const json = (await readJson(response)) as { keys?: { alg?: unknown }[] } | undefined
    if (response.status !== 200 || !Array.isArray(json?.keys) || json.keys.length === 0) {
      return fail(`GET /.well-known/jwks.json answered ${response.status} with no keys`)
    }
    return json.keys.every((key) => key.alg === 'EdDSA')
      ? pass(`${json.keys.length} key(s)`)
      : fail('a published key is not EdDSA')
  })

  await step('core refuses a request without a valid token', async () => {
    const cases: { headers: Record<string, string>; expected: string }[] = [
      { headers: {}, expected: 'auth.unauthenticated' },
      { headers: { authorization: `Bearer ${randomHex(24)}` }, expected: 'auth.token_invalid' },
    ]
    for (const { headers, expected } of cases) {
      const response = await request(`${targets.core}/v1/organization`, { headers })
      const code = errorCode(await readJson(response))
      if (response.status !== 401 || code !== expected) {
        return fail(
          `GET /v1/organization answered ${response.status} ${code ?? ''}, not 401 ${expected}`
        )
      }
    }
    return pass()
  })

  // The flow: a new user who creates an Organization. The password is random and never printed.
  let blocked: Blocked
  const email = `smoke-${randomHex(6)}@example.com`
  const password = `${randomHex(16)}-Aa1`
  await step('sign up (starts, emails a code)', async () => {
    const response = await request(`${targets.auth}/v1/client/sign-ups`, {
      method: 'POST',
      idempotent: false,
      headers: { 'content-type': 'application/json', 'x-tula-client': 'server' },
      body: JSON.stringify({ email, password, organizationName: `Smoke ${randomHex(3)}` }),
    })
    const json = await readJson(response)
    const code = errorCode(json)
    if (response.status === 503 && code === 'mail.unavailable') {
      blocked = {
        reason:
          'auth has no mail provider, so no verification code is sent (answered 503 mail.unavailable); ' +
          'there is no local mail stand-in to read it from (tula-closeline-auth src/container.ts, ' +
          'src/adapters/unconfigured/mailer.ts)',
      }
      return { status: 'skip', detail: blocked.reason }
    }
    if (response.status !== 200) {
      return fail(`POST /v1/client/sign-ups answered ${response.status} ${code ?? ''}`.trim())
    }
    blocked = {
      reason:
        'the sign-up started and a code was sent, but no local mail stand-in exposes it, ' +
        'and the services offer no other way to read it',
    }
    return { status: 'skip', detail: `started; ${blocked.reason}` }
  })

  for (const name of ACCOUNT_STEPS) {
    const reason = (blocked as Blocked)?.reason ?? 'the sign-up step did not run'
    results.push({
      name,
      status: 'skip',
      detail: `needs a signed-up user; ${reason.split(';')[0]}`,
    })
  }
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
 * skipped step also gives 1: the mode CI uses once the services have a local mail stand-in
 * (hub issue 38), so a skip there cannot hide a gap.
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
