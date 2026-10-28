import './test-guard.ts'
import { describe, expect, test } from 'bun:test'
import { DEFAULT_PORTS, parseArgs } from './dev-lib.ts'
import { FUNNEL_HINT, startTunnel, type Tailscale, twilioWebhookStep } from './dev-tunnel.ts'

const ORIGIN = 'https://box.example.ts.net'

function status(over: { state?: string; dns?: string; caps?: object } = {}): string {
  return JSON.stringify({
    BackendState: over.state ?? 'Running',
    Self: { DNSName: over.dns ?? 'box.example.ts.net.', CapMap: over.caps ?? { funnel: null } },
  })
}

/** A fake `tailscale` that records every call; `fail` makes a matching call exit 1. */
function fakeTailscale(statusOut: string, fail?: (args: string[]) => string | undefined) {
  const calls: string[][] = []
  const ts: Tailscale = async (args) => {
    calls.push(args)
    if (args[0] === 'status') {
      return { code: 0, out: statusOut }
    }
    const out = fail?.(args)
    return out === undefined ? { code: 0, out: '' } : { code: 1, out }
  }
  return { ts, calls }
}

describe('startTunnel', () => {
  test('resets, then maps /webhooks/twilio to voice and / to the portal; stop resets once', async () => {
    const t = fakeTailscale(status())
    const result = await startTunnel(t.ts, ORIGIN, DEFAULT_PORTS)
    expect(result.ok).toBe(true)
    expect(t.calls.slice(1)).toEqual([
      ['serve', 'reset'],
      [
        'funnel',
        '--bg',
        '--set-path=/webhooks/twilio',
        `http://127.0.0.1:${DEFAULT_PORTS.voice}/webhooks/twilio`,
      ],
      ['funnel', '--bg', `http://127.0.0.1:${DEFAULT_PORTS.portal}`],
    ])
    if (result.ok) {
      await result.tunnel.stop()
      await result.tunnel.stop()
    }
    expect(t.calls.filter((c) => c[0] === 'serve')).toHaveLength(2)
  })

  test('Tailscale missing or stopped is one line and configures nothing', async () => {
    const missing = await startTunnel(async () => ({ code: -1, out: '' }), ORIGIN, DEFAULT_PORTS)
    expect(missing).toEqual({
      ok: false,
      message: '--tunnel needs Tailscale: install it and sign in',
    })
    const t = fakeTailscale(status({ state: 'Stopped' }))
    const stopped = await startTunnel(t.ts, ORIGIN, DEFAULT_PORTS)
    expect(stopped.ok === false && stopped.message).toContain('Tailscale is not running')
    expect(t.calls).toHaveLength(1)
  })

  test('a different host is refused and the message names this machine', async () => {
    const t = fakeTailscale(status())
    const result = await startTunnel(t.ts, 'https://other.example.ts.net', DEFAULT_PORTS)
    expect(result.ok === false && result.message).toContain('https://box.example.ts.net')
    expect(t.calls).toHaveLength(1)
  })

  test('Funnel not enabled, by capability or by the funnel command, prints the hint', async () => {
    const noCap = await startTunnel(
      fakeTailscale(status({ caps: { https: null } })).ts,
      ORIGIN,
      DEFAULT_PORTS
    )
    expect(noCap).toEqual({ ok: false, message: `Funnel is not enabled: ${FUNNEL_HINT}` })
    const t = fakeTailscale(status(), (args) =>
      args[0] === 'funnel' ? 'Funnel is not enabled on your tailnet' : undefined
    )
    const refused = await startTunnel(t.ts, ORIGIN, DEFAULT_PORTS)
    expect(refused.ok === false && refused.message).toContain('Funnel is not enabled')
    // The failed start still resets, so nothing stays public.
    expect(t.calls.at(-1)).toEqual(['serve', 'reset'])
  })

  test('a second mapping that fails resets what the first made', async () => {
    let funnels = 0
    const t = fakeTailscale(status(), (args) =>
      args[0] === 'funnel' && ++funnels === 2 ? 'boom' : undefined
    )
    const result = await startTunnel(t.ts, ORIGIN, DEFAULT_PORTS)
    expect(result.ok).toBe(false)
    expect(t.calls.at(-1)).toEqual(['serve', 'reset'])
  })
})

describe('twilioWebhookStep', () => {
  const answer = (status: number) =>
    (async () => new Response('', { status })) as unknown as typeof fetch
  test('a signature error passes; 404 and 502 fail', async () => {
    expect((await twilioWebhookStep(ORIGIN, answer(403))).status).toBe('pass')
    expect((await twilioWebhookStep(ORIGIN, answer(404))).status).toBe('fail')
    expect((await twilioWebhookStep(ORIGIN, answer(502))).status).toBe('fail')
  })
})

describe('parseArgs --tunnel', () => {
  test('is a start option only', () => {
    expect(parseArgs(['--tunnel'])).toEqual({ kind: 'up', infisical: true, tunnel: true })
    expect(parseArgs(['--tunnel', '--down']).kind).toBe('error')
  })
})
