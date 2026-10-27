import './test-guard.ts'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash, createPublicKey, verify } from 'node:crypto'
import {
  FAKE_GOOGLE_CLIENT_ID,
  FAKE_GOOGLE_CLIENT_SECRET,
  type FakeGoogle,
  startFakeGoogle,
  subjectOf,
} from './dev-fake-google.ts'

const REDIRECT = 'http://127.0.0.1:3002/v1/client/google/callback'
const MAIL_REDIRECT = 'http://127.0.0.1:3002/mailboxes/connect/callback'
const VERIFIER = 'v'.repeat(64)
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url')

let fake: FakeGoogle

beforeAll(async () => {
  fake = await startFakeGoogle({
    port: 0,
    clientId: FAKE_GOOGLE_CLIENT_ID,
    clientSecret: FAKE_GOOGLE_CLIENT_SECRET,
    redirectUri: REDIRECT,
    mailRedirectUri: MAIL_REDIRECT,
  })
})
afterAll(() => fake.stop())

function authorizeParams(overrides: Record<string, string> = {}): URLSearchParams {
  return new URLSearchParams({
    client_id: FAKE_GOOGLE_CLIENT_ID,
    redirect_uri: REDIRECT,
    response_type: 'code',
    scope: 'openid email profile',
    state: 'state-1',
    nonce: 'nonce-1',
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    ...overrides,
  })
}

/** Approves as `email` and returns the code the redirect carries. */
async function approve(email: string, overrides: Record<string, string> = {}): Promise<string> {
  const form = authorizeParams(overrides)
  form.set('email', email)
  const response = await fetch(`${fake.issuer}/authorize`, {
    method: 'POST',
    body: form,
    redirect: 'manual',
  })
  expect(response.status).toBe(302)
  const back = new URL(response.headers.get('location') ?? '')
  expect(`${back.origin}${back.pathname}`).toBe(REDIRECT)
  expect(back.searchParams.get('state')).toBe(overrides.state ?? 'state-1')
  return back.searchParams.get('code') ?? ''
}

function tokenBody(code: string, overrides: Record<string, string> = {}): URLSearchParams {
  return new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT,
    client_id: FAKE_GOOGLE_CLIENT_ID,
    client_secret: FAKE_GOOGLE_CLIENT_SECRET,
    code_verifier: VERIFIER,
    ...overrides,
  })
}

const exchange = (body: URLSearchParams) => fetch(`${fake.issuer}/token`, { method: 'POST', body })

function claimsOf(idToken: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString())
}

describe('the fake Google provider', () => {
  test('binds the loopback interface only', () => {
    expect(fake.hostname).toBe('127.0.0.1')
    expect(fake.issuer).toBe(`http://127.0.0.1:${fake.port}`)
  })

  test('discovery names itself as the issuer and its own endpoints', async () => {
    const found = (await (
      await fetch(`${fake.issuer}/.well-known/openid-configuration`)
    ).json()) as Record<string, string>
    expect(found.issuer).toBe(fake.issuer)
    expect(found.authorization_endpoint).toBe(`${fake.issuer}/authorize`)
    expect(found.token_endpoint).toBe(`${fake.issuer}/token`)
    expect(found.jwks_uri).toBe(`${fake.issuer}/jwks`)
  })

  test('the authorize page is plain HTML with the login hint filled in and no script', async () => {
    const hint = 'maya"><script>x</script>@example.com'
    const response = await fetch(
      `${fake.issuer}/authorize?${authorizeParams({ login_hint: hint })}`
    )
    const html = await response.text()
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(html).not.toContain('<script')
    expect(response.headers.get('content-security-policy')).not.toContain('script-src')
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(html).toContain('method="post"')
    expect(html).toContain('&quot;&gt;&lt;script&gt;')
  })

  test('the authorize page refuses another client, redirect URI or missing PKCE', async () => {
    const bad: Record<string, string>[] = [
      { client_id: 'someone-else' },
      { redirect_uri: 'https://evil.example/cb' },
      { code_challenge_method: 'plain' },
      { response_type: 'token' },
    ]
    for (const overrides of bad) {
      const response = await fetch(`${fake.issuer}/authorize?${authorizeParams(overrides)}`, {
        redirect: 'manual',
      })
      expect(response.status).toBe(400)
    }
    const missing = authorizeParams()
    missing.delete('state')
    expect((await fetch(`${fake.issuer}/authorize?${missing}`)).status).toBe(400)
  })

  test('a code becomes an RS256 ID token the published key verifies, with the nonce echoed', async () => {
    const code = await approve('Maya@Example.com')
    const response = await exchange(tokenBody(code))
    expect(response.status).toBe(200)
    const { id_token } = (await response.json()) as { id_token: string }
    const [header, payload, signature] = id_token.split('.')
    expect(JSON.parse(Buffer.from(header ?? '', 'base64url').toString())).toMatchObject({
      alg: 'RS256',
    })
    const keys = (await (await fetch(`${fake.issuer}/jwks`)).json()) as {
      keys: { kid: string }[]
    }
    const jwk = keys.keys[0]
    expect(JSON.parse(Buffer.from(header ?? '', 'base64url').toString()).kid).toBe(jwk?.kid)
    const key = createPublicKey({ key: jwk as never, format: 'jwk' })
    expect(
      verify(
        'sha256',
        Buffer.from(`${header}.${payload}`),
        key,
        Buffer.from(signature ?? '', 'base64url')
      )
    ).toBe(true)
    const claims = claimsOf(id_token)
    expect(claims.iss).toBe(fake.issuer)
    expect(claims.aud).toBe(FAKE_GOOGLE_CLIENT_ID)
    expect(claims.nonce).toBe('nonce-1')
    expect(claims.email).toBe('maya@example.com')
    expect(claims.email_verified).toBe(true)
    expect(typeof claims.exp).toBe('number')
    expect(typeof claims.iat).toBe('number')
  })

  test('sub is stable per email and differs between emails', async () => {
    const claimsFor = async (email: string) => {
      const answer = (await (await exchange(tokenBody(await approve(email)))).json()) as {
        id_token: string
      }
      return claimsOf(answer.id_token)
    }
    const first = await claimsFor('same@example.com')
    const again = await claimsFor('SAME@example.com')
    const other = await claimsFor('other@example.com')
    expect(first.sub).toBe(again.sub)
    expect(first.sub).toBe(subjectOf('same@example.com'))
    expect(first.sub).not.toBe(other.sub)
  })

  test('a wrong verifier, secret, client id or redirect URI is refused, and a code works once', async () => {
    const refusals: Record<string, string>[] = [
      { code_verifier: 'w'.repeat(64) },
      { client_secret: 'wrong-secret' },
      { client_id: 'someone-else' },
      { redirect_uri: 'http://127.0.0.1:3002/elsewhere' },
      { grant_type: 'password' },
    ]
    for (const overrides of refusals) {
      const code = await approve('refuse@example.com')
      const response = await exchange(tokenBody(code, overrides))
      expect(response.status).toBe(400)
      expect(((await response.json()) as { error: string }).error).toBe('invalid_grant')
    }
    const code = await approve('once@example.com')
    expect((await exchange(tokenBody(code))).status).toBe(200)
    expect((await exchange(tokenBody(code))).status).toBe(400)
    expect((await exchange(tokenBody('no-such-code'))).status).toBe(400)
  })

  test('a malformed email is not approved', async () => {
    const form = authorizeParams()
    form.set('email', 'not an email')
    const response = await fetch(`${fake.issuer}/authorize`, {
      method: 'POST',
      body: form,
      redirect: 'manual',
    })
    expect(response.status).toBe(400)
  })

  test('unknown paths are 404', async () => {
    expect((await fetch(`${fake.issuer}/nothing`)).status).toBe(404)
  })
})

describe('the fake Google provider as a Gmail Mailbox provider', () => {
  const offline = { access_type: 'offline', redirect_uri: MAIL_REDIRECT }

  async function connect(email: string) {
    const code = await approveAt(email, offline)
    const body = (await (
      await exchange(tokenBody(code, { redirect_uri: MAIL_REDIRECT }))
    ).json()) as Record<string, unknown>
    return body
  }

  /** Approves with the mail redirect and returns the code (the shared helper checks REDIRECT). */
  async function approveAt(email: string, overrides: Record<string, string>): Promise<string> {
    const form = authorizeParams(overrides)
    form.set('email', email)
    const response = await fetch(`${fake.issuer}/authorize`, {
      method: 'POST',
      body: form,
      redirect: 'manual',
    })
    expect(response.status).toBe(302)
    const back = new URL(response.headers.get('location') ?? '')
    expect(`${back.origin}${back.pathname}`).toBe(MAIL_REDIRECT)
    return back.searchParams.get('code') ?? ''
  }

  const raw = (headers: string, body = 'hello') =>
    Buffer.from(`${headers}\r\n\r\n${body}`).toString('base64url')
  const post = (path: string, init: RequestInit) =>
    fetch(`${fake.issuer}${path}`, { method: 'POST', ...init })

  test('access_type=offline returns a refresh token and an ID token with the Gmail claims', async () => {
    const body = await connect('Rep@Example.com')
    expect(body.refresh_token).toEqual(expect.any(String))
    expect(body.access_token).toEqual(expect.any(String))
    expect(body.expires_in).toBe(3600)
    expect(claimsOf(body.id_token as string)).toMatchObject({
      email: 'rep@example.com',
      email_verified: true,
      name: 'rep',
    })
  })

  test('without access_type=offline there is no refresh token (sign-in is unchanged)', async () => {
    const code = await approve('plain@example.com')
    const body = (await (await exchange(tokenBody(code))).json()) as Record<string, unknown>
    expect(body.refresh_token).toBeUndefined()
  })

  test('the refresh_token grant gives a new access token to the right client only', async () => {
    const { refresh_token: refreshToken } = await connect('refresh@example.com')
    const grant = (overrides: Record<string, string> = {}) =>
      post('/token', {
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken as string,
          client_id: FAKE_GOOGLE_CLIENT_ID,
          client_secret: FAKE_GOOGLE_CLIENT_SECRET,
          ...overrides,
        }),
      })
    const ok = await grant()
    expect(ok.status).toBe(200)
    expect(((await ok.json()) as Record<string, unknown>).access_token).toEqual(expect.any(String))
    expect((await grant({ client_secret: 'wrong' })).status).toBe(400)
    const unknown = await grant({ refresh_token: 'fake-rt-unknown' })
    expect(unknown.status).toBe(400)
    expect(((await unknown.json()) as { error: string }).error).toBe('invalid_grant')
  })

  test('revoke ends the refresh token and its access tokens; a repeat is 400', async () => {
    const { refresh_token: refreshToken, access_token: accessToken } =
      await connect('revoke@example.com')
    const revoke = (token: string) => post('/revoke', { body: new URLSearchParams({ token }) })
    expect((await revoke(refreshToken as string)).status).toBe(200)
    expect((await revoke(refreshToken as string)).status).toBe(400)
    const sendNow = await post('/gmail/v1/users/me/messages/send', {
      headers: { authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ raw: raw('To: a@b.test') }),
    })
    expect(sendNow.status).toBe(401)
    const refresh = await post('/token', {
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken as string,
        client_id: FAKE_GOOGLE_CLIENT_ID,
        client_secret: FAKE_GOOGLE_CLIENT_SECRET,
      }),
    })
    expect(refresh.status).toBe(400)
  })

  test('send keeps the message in memory and lists its headers, never the body', async () => {
    const { access_token: accessToken } = await connect('sender@example.com')
    const sent = await post('/gmail/v1/users/me/messages/send', {
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        raw: raw(
          'From: sender@example.com\r\nTo: prospect@example.test\r\nSubject: Hi there',
          'SECRET-BODY'
        ),
        threadId: 'thread-1',
      }),
    })
    expect(sent.status).toBe(200)
    expect(await sent.json()).toMatchObject({ id: expect.any(String), threadId: 'thread-1' })
    const listing = await (await fetch(`${fake.issuer}/fake/sent`)).text()
    expect(JSON.parse(listing).messages.at(-1)).toMatchObject({
      from: 'sender@example.com',
      to: 'prospect@example.test',
      subject: 'Hi there',
    })
    expect(listing).not.toContain('SECRET-BODY')
  })

  test('send refuses a missing or unknown token and an empty message', async () => {
    const { access_token: accessToken } = await connect('bad@example.com')
    const attempt = (headers: Record<string, string>, body: unknown) =>
      post('/gmail/v1/users/me/messages/send', { headers, body: JSON.stringify(body) })
    expect((await attempt({}, { raw: raw('To: a@b.test') })).status).toBe(401)
    expect((await attempt({ authorization: 'Bearer nope' }, { raw: 'x' })).status).toBe(401)
    expect((await attempt({ authorization: `Bearer ${accessToken}` }, {})).status).toBe(400)
  })

  test('the mail redirect URI is accepted and an unregistered one is not', async () => {
    const bad = authorizeParams({ redirect_uri: 'http://127.0.0.1:3002/other' })
    expect((await fetch(`${fake.issuer}/authorize?${bad}`)).status).toBe(400)
    const good = authorizeParams({ redirect_uri: MAIL_REDIRECT })
    expect((await fetch(`${fake.issuer}/authorize?${good}`)).status).toBe(200)
  })
})
