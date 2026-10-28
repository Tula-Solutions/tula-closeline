// Vendor sandbox credentials for `bun run dev` from Infisical (project Tula-Closeline, environment
// `dev`, one folder per repo). Values are parsed in memory, never written, logged or put in a
// message: every message here names keys only. See "Secrets from Infisical" in
// docs/local-development.md.
import { resolve } from 'node:path'
import {
  captureCommand,
  GOOGLE_CALLBACK_PATH,
  MAIL_CALLBACK_PATH,
  redact,
  type StackEnv,
} from './dev-lib.ts'

const hub = resolve(import.meta.dir, '..')

/** The Infisical folders: `hub` feeds the dev script itself, the others one service each. */
export const FOLDERS = ['hub', 'auth', 'core', 'playbook', 'voice', 'outbound', 'portal'] as const

/** One of {@link FOLDERS}. */
export type Folder = (typeof FOLDERS)[number]

/** Runs `infisical export` for a folder and returns its JSON, or undefined if it failed. */
export type Exporter = (
  folder: Folder,
  abort?: { signal: AbortSignal; force: AbortSignal }
) => Promise<string | undefined>

/** What Infisical holds: the non-empty values, and the names of the keys left empty, per folder. */
export type Loaded = {
  values: Record<Folder, Record<string, string>>
  empty: Record<Folder, string[]>
}

/** Keys that are generated or fixed by this script and so are refused from Infisical. */
const GENERATED =
  /^(DATABASE_URL|INTERNAL_API_TOKENS|AUTH_MASTER_KEY|ENVIRONMENT)$|(POSTGRES|DB|DATABASE)_PASSWORD$|_INTERNAL_(TOKEN|SECRET)$/

const GOOGLE_KEYS = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI'] as const
/** What voice refuses to start on Twilio without. */
const TWILIO_KEYS = [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_API_KEY_SID',
  'TWILIO_API_KEY_SECRET',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_TWIML_APP_SID',
] as const

/** The `infisical export` command line for a folder. */
export function exportCommand(folder: Folder): string[] {
  return ['infisical', 'export', '--env=dev', `--path=/${folder}`, '--format=json']
}

/** Parses one export (`[{key, value}, ...]`); undefined if it is not that shape. */
function parseExport(raw: string): { key: string; value: string }[] | undefined {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!Array.isArray(data)) {
    return undefined
  }
  const rows: { key: string; value: string }[] = []
  for (const row of data) {
    if (typeof row?.key !== 'string' || typeof row?.value !== 'string') {
      return undefined
    }
    rows.push({ key: row.key, value: row.value })
  }
  return rows
}

/**
 * Exports every folder. Any failure (not logged in, no network, no access, unreadable output)
 * returns undefined after one line saying so, and the stack keeps its fake adapters.
 */
export async function loadInfisical(
  exporter: Exporter,
  say: (line: string) => void,
  abort?: { signal: AbortSignal; force: AbortSignal }
): Promise<Loaded | undefined> {
  const values = {} as Loaded['values']
  const empty = {} as Loaded['empty']
  for (const folder of FOLDERS) {
    const raw = await exporter(folder, abort)
    const rows = raw === undefined ? undefined : parseExport(raw)
    if (rows === undefined) {
      say(
        `Infisical unavailable (log in with "infisical login" or set INFISICAL_TOKEN; failed at /${folder}): using the fake and memory adapters`
      )
      return undefined
    }
    values[folder] = {}
    empty[folder] = []
    for (const { key, value } of rows) {
      if (value === '') {
        empty[folder].push(key)
      } else {
        values[folder][key] = value
      }
    }
  }
  return { values, empty }
}

/** Every loaded value, for scrubbing output. */
export function infisicalValues(loaded: Loaded): string[] {
  return FOLDERS.flatMap((folder) => Object.values(loaded.values[folder]))
}

/** Redacts every loaded value from a message. */
export function scrub(text: string, loaded: Loaded | undefined): string {
  return loaded ? redact(text, infisicalValues(loaded)) : text
}

/**
 * The shell environment plus the keys the dev script reads itself: the three `GOOGLE_*` keys from
 * `/auth` (so a full set selects real Google and a partial one is refused) and
 * `CLOSELINE_DEV_PUBLIC_ORIGIN` from `/hub`. A variable set in the shell wins.
 */
export function infisicalParent(
  parent: Record<string, string | undefined>,
  loaded: Loaded,
  portalOrigin: string
): Record<string, string | undefined> {
  const out = { ...parent }
  const take = (name: string, value: string | undefined) => {
    if (value !== undefined && (out[name] === undefined || out[name] === '')) {
      out[name] = value
    }
  }
  take('CLOSELINE_DEV_PUBLIC_ORIGIN', loaded.values.hub.CLOSELINE_DEV_PUBLIC_ORIGIN)
  // All three from one source: a shell that sets any of them keeps the whole set. The client id
  // and secret decide whether Google is real; the redirect URI is always derived, never Infisical's.
  const unset = GOOGLE_KEYS.every((name) => out[name] === undefined || out[name] === '')
  const auth = loaded.values.auth
  if (unset && (auth.GOOGLE_CLIENT_ID || auth.GOOGLE_CLIENT_SECRET)) {
    take('GOOGLE_CLIENT_ID', auth.GOOGLE_CLIENT_ID)
    take('GOOGLE_CLIENT_SECRET', auth.GOOGLE_CLIENT_SECRET)
    take('GOOGLE_REDIRECT_URI', `${callbackBase(out, portalOrigin)}${GOOGLE_CALLBACK_PATH}`)
  }
  return out
}

/** The tunnel origin when `CLOSELINE_DEV_PUBLIC_ORIGIN` is set, else the portal's local origin. */
function callbackBase(env: Record<string, string | undefined>, portalOrigin: string): string {
  const origin = env.CLOSELINE_DEV_PUBLIC_ORIGIN
  return origin === undefined || origin === '' ? portalOrigin : origin
}

/**
 * Callback URLs differ between this stack and the AWS dev stage that shares the same Infisical
 * environment, so Infisical's values are never used: the script derives them from the tunnel
 * origin (or the portal's local origin) for the keys that Infisical fills in.
 */
const DERIVED: Record<string, (base: string, tunnel: boolean) => string | undefined> = {
  CALENDAR_REDIRECT_URI: (base) => `${base}/calendar/callback`,
  MAIL_OAUTH_REDIRECT_URI: (base) => `${base}${MAIL_CALLBACK_PATH}`,
  WEBHOOK_BASE_URL: (base, tunnel) => (tunnel ? base : undefined),
  GOOGLE_REDIRECT_URI: () => undefined,
}

/**
 * Adds each folder's values to its service's environment, after the existing allowlist. A value
 * never replaces one the script already set, and a generated key is refused; each refusal is said
 * once, naming the key and the folder.
 */
export function applyInfisical(
  stack: StackEnv,
  loaded: Loaded,
  say: (line: string) => void,
  where: { parent: Record<string, string | undefined>; portalOrigin: string }
): StackEnv {
  const next = { ...stack }
  const base = callbackBase(where.parent, where.portalOrigin)
  const tunnel = base !== where.portalOrigin
  for (const folder of FOLDERS) {
    if (folder === 'hub') {
      continue
    }
    const env = { ...stack[folder] }
    for (const [key, value] of Object.entries(loaded.values[folder])) {
      if (folder === 'voice' && key === 'TELEPHONY_PROVIDER' && value === 'twilio') {
        // Twilio must reach voice's webhooks, so real calls need the tunnel's public origin.
        const missing = TWILIO_KEYS.filter((name) => !loaded.values.voice[name])
        if (missing.length > 0) {
          say(`Infisical /voice: Twilio needs ${missing.join(', ')}; voice keeps its stand-in`)
        } else if (tunnel) {
          env.TELEPHONY_PROVIDER = 'twilio'
          env.WEBHOOK_BASE_URL = base
        } else {
          say(
            'Infisical /voice: Twilio needs --tunnel to reach its webhooks; voice keeps its stand-in'
          )
        }
      } else if (key in DERIVED) {
        const derived = DERIVED[key]?.(base, tunnel)
        if (derived !== undefined) {
          env[key] = derived
        }
      } else if (GENERATED.test(key) || (env[key] !== undefined && env[key] !== value)) {
        say(
          `Infisical /${folder}: ${key} is set by this script and is ignored${key === 'TELEPHONY_PROVIDER' ? " (only 'twilio' switches it)" : ''}`
        )
      } else {
        env[key] = value
      }
    }
    next[folder] = env
  }
  return next
}

/** Which keys come from Infisical (real) and which are left empty (faked), by name only. */
export function vendorReport(loaded: Loaded | undefined): string {
  if (!loaded) {
    return 'Infisical: off, every vendor is faked'
  }
  const names = (pick: (folder: Folder) => string[]) =>
    FOLDERS.flatMap((folder) => pick(folder).map((key) => `${key} (/${folder})`)).join(', ') ||
    'none'
  return `Infisical: real: ${names((f) => Object.keys(loaded.values[f]))}; faked: ${names((f) => loaded.empty[f])}`
}

/** Runs `infisical export` in the hub (the CLI finds `.infisical.json` there); undefined on any failure. */
export function infisicalExporter(
  folder: Folder,
  abort?: { signal: AbortSignal; force: AbortSignal }
): Promise<string | undefined> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  )
  return captureCommand(exportCommand(folder), { cwd: hub, env, timeoutMs: 30_000, ...abort })
}
