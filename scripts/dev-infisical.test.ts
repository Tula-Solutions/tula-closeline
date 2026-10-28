import './test-guard.ts'
import { describe, expect, test } from 'bun:test'
import { createContext } from './dev.ts'
import {
  applyInfisical,
  exportCommand,
  type Folder,
  infisicalParent,
  loadInfisical,
  scrub,
  vendorReport,
} from './dev-infisical.ts'
import { parseArgs } from './dev-lib.ts'

// The fake values are plain strings; the real CLI is never called.
const GOOGLE_SECRET = 'fake-google-secret-value'
const TWILIO = 'fake-twilio-token-value'

async function must(exporter: Parameters<typeof loadInfisical>[0]) {
  const loaded = await loadInfisical(exporter, () => {})
  if (!loaded) {
    throw new Error('expected the fake export to load')
  }
  return loaded
}

function fakeExporter(
  folders: Partial<Record<Folder, Record<string, string>>>,
  calls: Folder[] = []
) {
  return async (folder: Folder) => {
    calls.push(folder)
    const rows = Object.entries(folders[folder] ?? {}).map(([key, value]) => ({ key, value }))
    return JSON.stringify(rows)
  }
}

const full = fakeExporter({
  auth: {
    GOOGLE_CLIENT_ID: 'gid',
    GOOGLE_CLIENT_SECRET: GOOGLE_SECRET,
    GOOGLE_REDIRECT_URI: 'http://127.0.0.1:3002/v1/client/google/callback',
  },
  voice: { TWILIO_AUTH_TOKEN: TWILIO, TWILIO_ACCOUNT_SID: '' },
})

describe('loadInfisical', () => {
  test('asks for every folder in the dev environment and ignores empty values', async () => {
    const said: string[] = []
    const calls: Folder[] = []
    const loaded = await loadInfisical(fakeExporter({ voice: { A: '', B: 'b' } }, calls), (l) =>
      said.push(l)
    )
    expect(calls).toEqual(['hub', 'auth', 'core', 'playbook', 'voice', 'outbound', 'portal'])
    expect(loaded?.values.voice).toEqual({ B: 'b' })
    expect(loaded?.empty.voice).toEqual(['A'])
    expect(exportCommand('core')).toEqual([
      'infisical',
      'export',
      '--env=dev',
      '--path=/core',
      '--format=json',
    ])
    expect(said).toEqual([])
  })

  test.each([
    ['the export failing', async () => undefined],
    ['unreadable output', async () => `not json ${TWILIO}`],
    ['the wrong shape', async () => '{"key":"a"}'],
  ])('%s falls back with one line that names no value', async (_name, exporter) => {
    const said: string[] = []
    expect(await loadInfisical(exporter, (l) => said.push(l))).toBeUndefined()
    expect(said).toHaveLength(1)
    expect(said[0]).toContain('using the fake and memory adapters')
    expect(said[0]).not.toContain(TWILIO)
  })
})

describe('using the values', () => {
  const stack = {
    compose: {},
    migrate: {},
    auth: { PORT: '3001', DATABASE_URL: 'postgres://generated', GOOGLE_CLIENT_ID: 'fake' },
    core: { INTERNAL_API_TOKENS: 'generated', UNSUBSCRIBE_TOKEN_KEY: 'generated' },
    playbook: {},
    voice: {},
    outbound: {},
    portal: {},
    fakeGoogle: undefined,
  }

  test('adds vendor keys to their service only', async () => {
    const loaded = await must(full)
    const said: string[] = []
    const next = applyInfisical(stack, loaded, (l) => said.push(l))
    expect(next.voice.TWILIO_AUTH_TOKEN).toBe(TWILIO)
    expect(next.voice.TWILIO_ACCOUNT_SID).toBeUndefined()
    expect(next.core.TWILIO_AUTH_TOKEN).toBeUndefined()
  })

  test('a generated key is refused, naming the key and never the value', async () => {
    const loaded = await must(
      fakeExporter({
        auth: { DATABASE_URL: 'postgres://from-infisical', GOOGLE_CLIENT_ID: 'other' },
        core: {
          INTERNAL_API_TOKENS: 'tok-from-infisical',
          UNSUBSCRIBE_TOKEN_KEY: 'k-from-infisical',
        },
      })
    )
    const said: string[] = []
    const next = applyInfisical(stack, loaded, (l) => said.push(l))
    expect(next.auth.DATABASE_URL).toBe('postgres://generated')
    expect(next.auth.GOOGLE_CLIENT_ID).toBe('fake')
    expect(next.core.INTERNAL_API_TOKENS).toBe('generated')
    expect(next.core.UNSUBSCRIBE_TOKEN_KEY).toBe('generated')
    const out = said.join('\n')
    for (const key of ['DATABASE_URL', 'GOOGLE_CLIENT_ID', 'INTERNAL_API_TOKENS']) {
      expect(out).toContain(key)
    }
    expect(out).not.toMatch(/from-infisical|other/)
  })

  test('the three Google keys select real Google; the shell wins; the hub folder sets the tunnel', async () => {
    const loaded = await must(
      fakeExporter({
        hub: { CLOSELINE_DEV_PUBLIC_ORIGIN: 'https://x.example.com' },
        auth: { GOOGLE_CLIENT_ID: 'gid' },
      })
    )
    const parent = infisicalParent({ GOOGLE_CLIENT_ID: 'shell' }, loaded)
    expect(parent.GOOGLE_CLIENT_ID).toBe('shell')
    expect(parent.CLOSELINE_DEV_PUBLIC_ORIGIN).toBe('https://x.example.com')
  })

  test('a shell that sets one Google key keeps all three from the shell', async () => {
    const loaded = await must(
      fakeExporter({ auth: { GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: 'b' } })
    )
    const parent = infisicalParent({ GOOGLE_REDIRECT_URI: 'shell' }, loaded)
    expect(parent.GOOGLE_CLIENT_ID).toBeUndefined()
    expect(parent.GOOGLE_CLIENT_SECRET).toBeUndefined()
  })

  test('values are scrubbed from messages', async () => {
    const loaded = await must(full)
    expect(scrub(`bad ${GOOGLE_SECRET} and ${TWILIO}`, loaded)).toBe(
      'bad [redacted] and [redacted]'
    )
  })

  test('the report names keys only, real and faked', async () => {
    const report = vendorReport(await loadInfisical(full, () => {}))
    expect(report).toContain('real: GOOGLE_CLIENT_ID (/auth)')
    expect(report).toContain('faked: TWILIO_ACCOUNT_SID (/voice)')
    expect(report).not.toContain(TWILIO)
    expect(report).not.toContain(GOOGLE_SECRET)
    expect(vendorReport(undefined)).toContain('off')
  })
})

describe('--no-infisical', () => {
  test('is parsed and keeps the context from reading Infisical', () => {
    expect(parseArgs(['--no-infisical'])).toEqual({ kind: 'up', infisical: false })
    expect(createContext({}, {} as never, false).infisical).toBe(false)
  })
})
