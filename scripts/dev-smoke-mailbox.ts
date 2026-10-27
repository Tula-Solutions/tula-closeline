// The Mailbox steps of `bun run dev:smoke`: connect a Gmail Mailbox through the stack's fake Google
// provider (scripts/dev-fake-google.ts), playing the browser, then ask outbound to send one test
// message and look for it at the fake's inspection route. Only the fake's own address is followed.
// No token, code, state or address is printed (the caller scrubs every value passed to `remember`).
import type { SmokeTargets, StepStatus } from './dev-smoke.ts'

/** The names of the Mailbox steps, in the order they run (after the Lines steps). */
export const MAILBOX_STEPS = [
  'mailbox: connecting a Gmail Mailbox through the fake provider gives a Mailbox',
  'mailbox: a test message sent through the Mailbox reaches the fake provider',
] as const

/**
 * Why the second step is skipped when outbound's test-send route answers 404. That route is added
 * with contract v0.52.0 and outbound's Mailbox branch; until both are in the stack there is nothing
 * to call. A 404 that names a missing Mailbox is a failure, not this.
 */
export const TEST_SEND_SKIP =
  'outbound has no test-send route yet (it needs contract v0.52.0 and the outbound Mailbox change merged)'

/** The path of outbound's test-send route; align with the contract once v0.52.0 is in. */
const testSendPath = (mailboxId: string) => `/v1/mailboxes/${mailboxId}/test-send`

/** What the steps need from the smoke run that calls them. */
export type MailboxKit = {
  targets: SmokeTargets
  request: (url: string, init?: RequestInit & { idempotent?: boolean }) => Promise<Response>
  step: (
    name: string,
    body: () => Promise<{ status: StepStatus; detail: string }>
  ) => Promise<StepStatus>
  remember: (...values: (string | null | undefined)[]) => void
  runId: string
  /** The signed-in Owner's access token; undefined when the sign-in steps did not provide one. */
  accessToken?: string
}

type Outcome = { status: StepStatus; detail: string }
const pass = (detail = ''): Outcome => ({ status: 'pass', detail })
const fail = (detail: string): Outcome => ({ status: 'fail', detail })
const skip = (detail: string): Outcome => ({ status: 'skip', detail })

async function jsonOf(response: Response): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse((await response.text()).slice(0, 65_536))
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

const asText = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined

const codeOf = (body: Record<string, unknown>): string | undefined => {
  const error = body.error
  return typeof error === 'object' && error !== null
    ? asText((error as Record<string, unknown>).code)
    : undefined
}

/** Runs the Mailbox steps and records one result for each. */
export async function runMailboxSteps(kit: MailboxKit): Promise<void> {
  const { targets, request, remember, step } = kit
  const address = `mailbox-${kit.runId}@closeline-smoke.test`
  remember(address)
  let mailboxId: string | undefined

  await step(MAILBOX_STEPS[0], async () => {
    if (!kit.accessToken) {
      return skip('blocked by the sign-in steps')
    }
    if (!targets.outbound) {
      return skip('no outbound address was given')
    }
    if (!targets.fakeGoogle) {
      return skip('the stack uses real Google, which needs a person to consent')
    }
    const headers = (key: string) => ({
      authorization: `Bearer ${kit.accessToken}`,
      'content-type': 'application/json',
      'idempotency-key': `mailbox-${kit.runId}-${key}`,
    })
    const started = await request(`${targets.outbound}/v1/mailboxes/connect`, {
      method: 'POST',
      headers: headers('start'),
      body: JSON.stringify({ provider: 'gmail' }),
      idempotent: false,
    })
    const authorizationUrl = asText((await jsonOf(started)).authorizationUrl)
    const url =
      authorizationUrl !== undefined && URL.canParse(authorizationUrl)
        ? new URL(authorizationUrl)
        : undefined
    if (started.status !== 201 || !url) {
      return fail(`POST /v1/mailboxes/connect answered ${started.status}`)
    }
    remember(
      authorizationUrl,
      url.searchParams.get('state'),
      url.searchParams.get('code_challenge')
    )
    if (url.origin !== targets.fakeGoogle) {
      return fail('the authorization URL is not on the fake provider')
    }
    if (url.searchParams.get('access_type') !== 'offline') {
      return fail('the authorization URL does not ask for offline access')
    }
    const form = new URLSearchParams(url.searchParams)
    form.set('email', address)
    const approved = await request(`${targets.fakeGoogle}/authorize`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      idempotent: false,
    })
    const location = approved.headers.get('location')
    const back = location !== null && URL.canParse(location) ? new URL(location) : undefined
    await approved.body?.cancel()
    const code = back?.searchParams.get('code')
    const state = back?.searchParams.get('state')
    remember(location, code, state)
    if (approved.status !== 302 || !back || !code || !state) {
      return fail(`approving at the fake provider answered ${approved.status} without a code`)
    }
    if (back.origin !== targets.portal) {
      return fail('the fake provider redirected somewhere other than the portal')
    }
    const done = await request(`${targets.outbound}/v1/mailboxes/connect/complete`, {
      method: 'POST',
      headers: headers('complete'),
      body: JSON.stringify({ code, state }),
      idempotent: false,
    })
    const body = await jsonOf(done)
    mailboxId = asText(body.id)
    if (done.status !== 201 || !mailboxId) {
      return fail(
        `POST /v1/mailboxes/connect/complete answered ${done.status} ${codeOf(body) ?? ''}`.trim()
      )
    }
    return pass('connected through the fake provider')
  })

  await step(MAILBOX_STEPS[1], async () => {
    if (mailboxId === undefined || !targets.outbound || !targets.fakeGoogle) {
      return skip(`blocked by "${MAILBOX_STEPS[0]}"`)
    }
    const sent = await request(`${targets.outbound}${testSendPath(mailboxId)}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${kit.accessToken}`,
        'content-type': 'application/json',
        'idempotency-key': `mailbox-${kit.runId}-test-send`,
      },
      body: JSON.stringify({ to: address }),
      idempotent: false,
    })
    const body = await jsonOf(sent)
    if (sent.status === 404 && codeOf(body) !== 'mailbox.not_found') {
      return skip(TEST_SEND_SKIP)
    }
    if (sent.status < 200 || sent.status > 299) {
      return fail(`the test-send route answered ${sent.status} ${codeOf(body) ?? ''}`.trim())
    }
    const listing = await jsonOf(await request(`${targets.fakeGoogle}/fake/sent`))
    const messages = Array.isArray(listing.messages) ? listing.messages : []
    const found = messages.some(
      (message) =>
        typeof message === 'object' &&
        message !== null &&
        (message as Record<string, unknown>).to === address
    )
    return found
      ? pass('the fake provider holds the sent message')
      : fail('the fake provider has no message to the test address')
  })
}
