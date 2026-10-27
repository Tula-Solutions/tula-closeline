// A fake Google OpenID provider for `bun run dev`, so Sign in with Google works on a laptop with no
// Google Cloud project. It serves discovery, the signing keys, an `/authorize` page where the
// person types (or is hinted) an email, and `/token`, which returns an RS256 ID token (and, for an
// `access_type=offline` request, a refresh token). For outbound's Gmail Mailboxes it also serves
// the `refresh_token` grant, `/revoke` and Gmail's `users.messages.send`; a sent message is kept in
// memory and listed at `GET /fake/sent` (headers only, never the body). It listens on the loopback
// interface only and holds everything in memory. It is run as its own process by
// `dev.ts`: `bun scripts/dev-fake-google.ts` with FAKE_GOOGLE_* variables (see `main` below).
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/** The OAuth client id the fake accepts when `dev.ts` configures auth with it. */
export const FAKE_GOOGLE_CLIENT_ID = 'closeline-dev-fake-google.apps.googleusercontent.test'
/** The client secret of the fake. A fixed development value: the fake is loopback only. */
export const FAKE_GOOGLE_CLIENT_SECRET = 'closeline-dev-fake-google-client-secret'

/** How long an authorization code lives, in milliseconds. */
const CODE_TTL_MS = 10 * 60_000
/** The most codes held at once; the oldest is dropped beyond this. */
const MAX_CODES = 1_000
/** The longest request body read for the OAuth routes. */
const MAX_BODY_BYTES = 16_384
/** The longest body of a Gmail send (a base64url RFC 822 message). */
const MAX_SEND_BYTES = 262_144
/** The most tokens and sent messages held at once; the oldest is dropped beyond this. */
const MAX_HELD = 1_000
const KEY_ID = 'fake-google-1'
const EMAIL_PATTERN = /^[^\s@<>"']{1,64}@[^\s@<>"']{1,255}$/

/** What a running fake offers its caller. */
export type FakeGoogle = {
  /** The issuer: `http://127.0.0.1:<port>`. */
  issuer: string
  hostname: '127.0.0.1'
  port: number
  /** Stops the server. */
  stop: () => void
}

/** The settings of a fake provider. `port: 0` picks a free one (tests). */
export type FakeGoogleOptions = {
  port: number
  clientId: string
  clientSecret: string
  /** The redirect URI it will send a browser back to. */
  redirectUri: string
  /** A second redirect URI (outbound's Mailbox callback), accepted the same way. */
  mailRedirectUri?: string
}

type Pending = {
  email: string
  nonce: string
  challenge: string
  redirectUri: string
  offline: boolean
  at: number
}
type Held = { email: string; refreshToken: string; expiresAt: number }

/** A stable Google-style numeric `sub` for an email, so a returning person is recognised. */
export function subjectOf(email: string): string {
  const digest = createHash('sha256').update(`fake-google:${email.toLowerCase()}`).digest('hex')
  return BigInt(`0x${digest.slice(0, 16)}`)
    .toString()
    .padStart(21, '1')
    .slice(0, 21)
}

function sameSecret(a: string, b: string): boolean {
  const left = createHash('sha256').update(a).digest()
  const right = createHash('sha256').update(b).digest()
  return timingSafeEqual(left, right)
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

const base64url = (data: ArrayBuffer | Uint8Array | string): string =>
  Buffer.from(typeof data === 'string' ? data : new Uint8Array(data)).toString('base64url')

function text(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } })
}

function oauthError(error: string, status = 400): Response {
  return Response.json({ error }, { status, headers: { 'cache-control': 'no-store' } })
}

/** Reads a body of at most `limit` bytes, or undefined if it is longer. */
async function boundedText(request: Request, limit = MAX_BODY_BYTES): Promise<string | undefined> {
  const reader = request.body?.getReader()
  if (!reader) {
    return ''
  }
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }
    size += value.byteLength
    if (size > limit) {
      await reader.cancel()
      return undefined
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Starts the fake provider and resolves once it is listening. */
export async function startFakeGoogle(options: FakeGoogleOptions): Promise<FakeGoogle> {
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify']
  )
  const jwk = {
    ...(await crypto.subtle.exportKey('jwk', pair.publicKey)),
    kid: KEY_ID,
    alg: 'RS256',
    use: 'sig',
  }
  const codes = new Map<string, Pending>()
  const redirects = [options.redirectUri, options.mailRedirectUri ?? options.redirectUri]
  const redirectOrigins = [...new Set(redirects.map((uri) => new URL(uri).origin))].join(' ')
  // Refresh tokens by value (the email they were issued for), access tokens by value.
  const refreshTokens = new Map<string, string>()
  const accessTokens = new Map<string, Held>()
  const sent: {
    id: string
    threadId: string
    from: string
    to: string
    subject: string
    at: string
    bytes: number
  }[] = []
  let issuer = ''
  const hold = <T>(map: Map<string, T>, key: string, value: T) => {
    map.set(key, value)
    if (map.size > MAX_HELD) {
      map.delete(map.keys().next().value as string)
    }
  }
  const mintAccessToken = (email: string, refreshToken: string) => {
    const accessToken = `fake-at-${randomBytes(24).toString('base64url')}`
    hold(accessTokens, accessToken, { email, refreshToken, expiresAt: Date.now() + 3_600_000 })
    return accessToken
  }

  /** Checks the parameters of an authorization request; returns why not, or the values. */
  function checkAuthorize(
    params: URLSearchParams
  ):
    | { problem: string }
    | { nonce: string; challenge: string; state: string; redirectUri: string } {
    const get = (name: string) => params.get(name) ?? ''
    if (get('client_id') !== options.clientId) {
      return { problem: 'unknown client_id' }
    }
    if (!redirects.includes(get('redirect_uri'))) {
      return { problem: 'redirect_uri is not the registered one' }
    }
    if (get('response_type') !== 'code') {
      return { problem: 'response_type must be code' }
    }
    if (get('code_challenge_method') !== 'S256' || get('code_challenge') === '') {
      return { problem: 'PKCE S256 is required' }
    }
    if (get('state') === '') {
      return { problem: 'state is required' }
    }
    return {
      nonce: get('nonce'),
      challenge: get('code_challenge'),
      state: get('state'),
      redirectUri: get('redirect_uri'),
    }
  }

  const carried = [
    'client_id',
    'redirect_uri',
    'response_type',
    'scope',
    'state',
    'nonce',
    'access_type',
  ] as const

  function page(params: URLSearchParams): Response {
    const hint = escapeHtml((params.get('login_hint') ?? '').slice(0, 320))
    const hidden = [...carried, 'code_challenge', 'code_challenge_method']
      .map(
        (name) =>
          `<input type="hidden" name="${name}" value="${escapeHtml((params.get(name) ?? '').slice(0, 2048))}">`
      )
      .join('\n      ')
    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Fake Google sign-in</title>
  <style>body{font-family:system-ui,sans-serif;max-width:24rem;margin:4rem auto;padding:0 1rem}input[type=email]{width:100%;padding:.5rem;margin:.5rem 0 1rem;box-sizing:border-box}</style>
</head>
<body>
  <h1>Fake Google</h1>
  <p>Development only. Type the email to sign in as; no password is asked and nothing leaves this machine.</p>
  <form method="post" action="/authorize">
      ${hidden}
    <label for="email">Email</label>
    <input id="email" type="email" name="email" value="${hint}" required autofocus>
    <button type="submit">Continue</button>
  </form>
</body>
</html>
`
    return new Response(html, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        // No script at all; the form may only post back here and the redirect goes to the portal.
        'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${redirectOrigins}; base-uri 'none'`,
        'referrer-policy': 'no-referrer',
      },
    })
  }

  async function approve(request: Request): Promise<Response> {
    const body = await boundedText(request)
    if (body === undefined) {
      return text(413, 'request too large')
    }
    const params = new URLSearchParams(body)
    const checked = checkAuthorize(params)
    if ('problem' in checked) {
      return text(400, checked.problem)
    }
    const email = (params.get('email') ?? '').trim().toLowerCase()
    if (!EMAIL_PATTERN.test(email)) {
      return text(400, 'a valid email is required')
    }
    const now = Date.now()
    for (const [key, entry] of codes) {
      if (now - entry.at > CODE_TTL_MS || codes.size >= MAX_CODES) {
        codes.delete(key)
      } else {
        break
      }
    }
    const code = randomBytes(24).toString('base64url')
    codes.set(code, {
      email,
      nonce: checked.nonce,
      challenge: checked.challenge,
      redirectUri: checked.redirectUri,
      offline: params.get('access_type') === 'offline',
      at: now,
    })
    const back = new URL(checked.redirectUri)
    back.searchParams.set('code', code)
    back.searchParams.set('state', checked.state)
    return new Response(null, {
      status: 302,
      headers: { location: back.toString(), 'cache-control': 'no-store' },
    })
  }

  async function idToken(entry: Pending): Promise<string> {
    const now = Math.floor(Date.now() / 1000)
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: KEY_ID }))
    const payload = base64url(
      JSON.stringify({
        iss: issuer,
        aud: options.clientId,
        sub: subjectOf(entry.email),
        email: entry.email,
        email_verified: true,
        name: entry.email.split('@')[0],
        nonce: entry.nonce,
        iat: now,
        exp: now + 3600,
      })
    )
    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      pair.privateKey,
      new TextEncoder().encode(`${header}.${payload}`)
    )
    return `${header}.${payload}.${base64url(signature)}`
  }

  const clientOk = (form: URLSearchParams) =>
    form.get('client_id') === options.clientId &&
    sameSecret(form.get('client_secret') ?? '', options.clientSecret)

  async function token(request: Request): Promise<Response> {
    const body = await boundedText(request)
    if (body === undefined) {
      return oauthError('invalid_request', 413)
    }
    const form = new URLSearchParams(body)
    if (form.get('grant_type') === 'refresh_token') {
      const email = refreshTokens.get(form.get('refresh_token') ?? '')
      if (!clientOk(form) || email === undefined) {
        return oauthError('invalid_grant')
      }
      return Response.json(
        {
          access_token: mintAccessToken(email, form.get('refresh_token') ?? ''),
          token_type: 'Bearer',
          expires_in: 3600,
        },
        { headers: { 'cache-control': 'no-store' } }
      )
    }
    const code = form.get('code') ?? ''
    // A code is spent by the first attempt, right or wrong.
    const entry = codes.get(code)
    codes.delete(code)
    if (
      form.get('grant_type') !== 'authorization_code' ||
      !entry ||
      Date.now() - entry.at > CODE_TTL_MS ||
      !clientOk(form) ||
      form.get('redirect_uri') !== entry.redirectUri ||
      !sameSecret(
        createHash('sha256')
          .update(form.get('code_verifier') ?? '')
          .digest('base64url'),
        entry.challenge
      )
    ) {
      return oauthError('invalid_grant')
    }
    const refreshToken = entry.offline ? `fake-rt-${randomBytes(24).toString('base64url')}` : ''
    if (entry.offline) {
      hold(refreshTokens, refreshToken, entry.email)
    }
    return Response.json(
      {
        id_token: await idToken(entry),
        access_token: mintAccessToken(entry.email, refreshToken),
        ...(entry.offline ? { refresh_token: refreshToken } : {}),
        token_type: 'Bearer',
        expires_in: 3600,
      },
      { headers: { 'cache-control': 'no-store' } }
    )
  }

  async function revoke(request: Request): Promise<Response> {
    const body = await boundedText(request)
    if (body === undefined) {
      return oauthError('invalid_request', 413)
    }
    const value = new URLSearchParams(body).get('token') ?? ''
    if (refreshTokens.delete(value)) {
      // Revoking a refresh token ends the access tokens made from it, as Google does.
      for (const [key, held] of accessTokens) {
        if (held.refreshToken === value) {
          accessTokens.delete(key)
        }
      }
      return new Response(null, { status: 200 })
    }
    return accessTokens.delete(value)
      ? new Response(null, { status: 200 })
      : oauthError('invalid_token')
  }

  async function send(request: Request): Promise<Response> {
    const bearer = /^Bearer (.+)$/.exec(request.headers.get('authorization') ?? '')?.[1] ?? ''
    const held = accessTokens.get(bearer)
    if (held === undefined || held.expiresAt < Date.now()) {
      return Response.json({ error: { code: 401, status: 'UNAUTHENTICATED' } }, { status: 401 })
    }
    const body = await boundedText(request, MAX_SEND_BYTES)
    let payload: { raw?: unknown; threadId?: unknown } = {}
    try {
      payload = body === undefined ? {} : JSON.parse(body)
    } catch {
      // answered below as a bad request
    }
    if (typeof payload.raw !== 'string' || payload.raw === '') {
      return Response.json({ error: { code: 400, status: 'INVALID_ARGUMENT' } }, { status: 400 })
    }
    // Only the headers are kept for inspection; the body of a message is never stored or logged.
    const message = Buffer.from(payload.raw, 'base64url').toString('utf8')
    const head = message.split(/\r?\n\r?\n/, 1)[0] ?? ''
    const header = (name: string) =>
      new RegExp(`^${name}:[ \\t]*(.*)$`, 'im').exec(head)?.[1]?.trim() ?? ''
    const id = randomBytes(8).toString('hex')
    const threadId = typeof payload.threadId === 'string' ? payload.threadId : id
    sent.push({
      id,
      threadId,
      from: held.email,
      to: header('To'),
      subject: header('Subject'),
      at: new Date().toISOString(),
      bytes: Buffer.byteLength(message),
    })
    if (sent.length > MAX_HELD) {
      sent.shift()
    }
    return Response.json({ id, threadId, labelIds: ['SENT'] })
  }

  // No Host or Origin check and a constant client secret: this listens on loopback only, and auth's
  // state-and-cookie binding stops a forged callback, so neither adds protection here.
  const server = Bun.serve({
    port: options.port,
    hostname: '127.0.0.1',
    maxRequestBodySize: MAX_SEND_BYTES,
    async fetch(request) {
      const url = new URL(request.url)
      const { pathname } = url
      if (request.method === 'GET' && pathname === '/.well-known/openid-configuration') {
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
        })
      }
      if (request.method === 'GET' && pathname === '/jwks') {
        return Response.json({ keys: [jwk] })
      }
      if (request.method === 'GET' && pathname === '/readyz') {
        return text(200, 'ok')
      }
      if (request.method === 'GET' && pathname === '/authorize') {
        const checked = checkAuthorize(url.searchParams)
        return 'problem' in checked ? text(400, checked.problem) : page(url.searchParams)
      }
      if (request.method === 'POST' && pathname === '/authorize') {
        return approve(request)
      }
      if (request.method === 'POST' && pathname === '/token') {
        return token(request)
      }
      if (request.method === 'POST' && pathname === '/revoke') {
        return revoke(request)
      }
      if (request.method === 'POST' && pathname === '/gmail/v1/users/me/messages/send') {
        return send(request)
      }
      if (request.method === 'GET' && pathname === '/fake/sent') {
        return Response.json({ messages: sent }, { headers: { 'cache-control': 'no-store' } })
      }
      return text(404, 'not found')
    },
  })
  const port = server.port ?? options.port
  issuer = `http://127.0.0.1:${port}`
  return { issuer, hostname: '127.0.0.1', port, stop: () => void server.stop(true) }
}

if (import.meta.main) {
  const env = process.env
  const port = Number(env.FAKE_GOOGLE_PORT)
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !env.FAKE_GOOGLE_REDIRECT_URI) {
    process.stderr.write(
      'fake-google: FAKE_GOOGLE_PORT and FAKE_GOOGLE_REDIRECT_URI are required\n'
    )
    process.exit(2)
  }
  const fake = await startFakeGoogle({
    port,
    clientId: env.FAKE_GOOGLE_CLIENT_ID ?? FAKE_GOOGLE_CLIENT_ID,
    clientSecret: env.FAKE_GOOGLE_CLIENT_SECRET ?? FAKE_GOOGLE_CLIENT_SECRET,
    redirectUri: env.FAKE_GOOGLE_REDIRECT_URI,
    mailRedirectUri: env.FAKE_GOOGLE_MAIL_REDIRECT_URI,
  })
  process.stdout.write(`fake Google listening on ${fake.issuer} (loopback only)\n`)
  const stop = () => {
    fake.stop()
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  process.on('SIGHUP', stop)
}
