// `bun run dev --tunnel`: puts the portal and voice's Twilio webhooks on the public internet
// through Tailscale Funnel for the life of the stack. Every `tailscale` call goes through an
// injected runner, so tests never touch the real Tailscale. See "Open the stack from another
// device" in docs/local-development.md.
import type { Ports } from './dev-lib.ts'

/** Runs `tailscale <args>`; `out` is stdout and stderr together, `code` is -1 if it could not run. */
export type Tailscale = (args: string[]) => Promise<{ code: number; out: string }>

/** What to do when Funnel is not enabled for this machine. */
export const FUNNEL_HINT =
  'enable Funnel for this machine: https://tailscale.com/kb/1223/funnel (admin console, Access controls, funnel node attribute)'

/** The public path voice owns: Twilio's webhooks. Everything else goes to the portal. */
export const TWILIO_PATH = '/webhooks/twilio'

/** The `tailscale` argument lists, in order, that map the public host to the local ports. */
export function funnelMappings(ports: Ports): string[][] {
  return [
    [
      'funnel',
      '--bg',
      `--set-path=${TWILIO_PATH}`,
      `http://127.0.0.1:${ports.voice}${TWILIO_PATH}`,
    ],
    ['funnel', '--bg', `http://127.0.0.1:${ports.portal}`],
  ]
}

/** A running tunnel; `stop` removes every mapping and may be called any number of times. */
export type Tunnel = { stop: () => Promise<void> }

/**
 * Checks Tailscale (running, this machine is `origin`, Funnel allowed), clears any old config and
 * maps the host. Returns one line saying what is wrong, or the tunnel. Nothing stays configured
 * after a failure.
 */
export async function startTunnel(
  ts: Tailscale,
  origin: string,
  ports: Ports
): Promise<{ ok: true; tunnel: Tunnel } | { ok: false; message: string }> {
  const status = await ts(['status', '--json'])
  let self: { BackendState?: string; Self?: { DNSName?: string; CapMap?: object } } = {}
  try {
    self = JSON.parse(status.out)
  } catch {
    // Tailscale is missing or not answering; handled below.
  }
  if (status.code !== 0 || self.BackendState === undefined) {
    return { ok: false, message: '--tunnel needs Tailscale: install it and sign in' }
  }
  if (self.BackendState !== 'Running') {
    return {
      ok: false,
      message: `Tailscale is not running (state ${self.BackendState}): start it and sign in`,
    }
  }
  const host = self.Self?.DNSName?.replace(/\.$/, '').toLowerCase()
  if (!host || `https://${host}` !== origin) {
    return {
      ok: false,
      message: `CLOSELINE_DEV_PUBLIC_ORIGIN must be this machine's Tailscale name, https://${host ?? '<machine>.<tailnet>.ts.net'} (got ${origin})`,
    }
  }
  if (!(self.Self?.CapMap && 'funnel' in self.Self.CapMap)) {
    return { ok: false, message: `Funnel is not enabled: ${FUNNEL_HINT}` }
  }
  let stopped: Promise<void> | undefined
  const stop = () => {
    // Reset also drops a half-made config; a failing reset has nothing more to undo here.
    stopped ??= ts(['serve', 'reset']).then(() => {})
    return stopped
  }
  // A stale "listener already exists for port 443" is cleared by a reset first.
  await ts(['serve', 'reset'])
  for (const args of funnelMappings(ports)) {
    const result = await ts(args)
    if (result.code !== 0) {
      await stop()
      return {
        ok: false,
        message: /not enabled|not allowed|disabled/i.test(result.out)
          ? `Funnel is not enabled: ${FUNNEL_HINT}`
          : 'tailscale funnel failed; run `tailscale funnel status` to see why',
      }
    }
  }
  return { ok: true, tunnel: { stop } }
}

/**
 * The smoke step for `--tunnel`: an unsigned POST to Twilio's status webhook through the public
 * host must reach voice, which answers with its signature error; a 404 or a 5xx means the Funnel
 * mapping or the proxy is wrong.
 */
export async function twilioWebhookStep(
  origin: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ name: string; status: 'pass' | 'fail'; detail: string }> {
  const name = 'tunnel: Twilio webhook reaches voice'
  try {
    const response = await fetchImpl(`${origin}${TWILIO_PATH}/status`, {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
    })
    await response.body?.cancel()
    return response.status === 404 || response.status >= 500
      ? { name, status: 'fail', detail: `POST ${TWILIO_PATH}/status answered ${response.status}` }
      : { name, status: 'pass', detail: `voice answered ${response.status} without a signature` }
  } catch {
    return { name, status: 'fail', detail: `POST ${TWILIO_PATH}/status did not answer` }
  }
}
