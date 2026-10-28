// Vendor sandbox credentials for `bun run dev` from Infisical (project Tula-Closeline, environment
// `dev`, one folder per repo). Values are parsed in memory, never written, logged or put in a
// message: every message here names keys only. See "Secrets from Infisical" in
// docs/local-development.md.
import { resolve } from 'node:path'
import { captureCommand, redact, type StackEnv } from './dev-lib.ts'

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
  loaded: Loaded
): Record<string, string | undefined> {
  const out = { ...parent }
  const take = (name: string, value: string | undefined) => {
    if (value !== undefined && (out[name] === undefined || out[name] === '')) {
      out[name] = value
    }
  }
  // All three from one source: a shell that sets any of them keeps the whole set.
  if (GOOGLE_KEYS.every((name) => out[name] === undefined || out[name] === '')) {
    for (const name of GOOGLE_KEYS) {
      take(name, loaded.values.auth[name])
    }
  }
  take('CLOSELINE_DEV_PUBLIC_ORIGIN', loaded.values.hub.CLOSELINE_DEV_PUBLIC_ORIGIN)
  return out
}

/**
 * Adds each folder's values to its service's environment, after the existing allowlist. A value
 * never replaces one the script already set, and a generated key is refused; each refusal is said
 * once, naming the key and the folder.
 */
export function applyInfisical(
  stack: StackEnv,
  loaded: Loaded,
  say: (line: string) => void
): StackEnv {
  const next = { ...stack }
  for (const folder of FOLDERS) {
    if (folder === 'hub') {
      continue
    }
    const env = { ...stack[folder] }
    for (const [key, value] of Object.entries(loaded.values[folder])) {
      if (GENERATED.test(key) || (env[key] !== undefined && env[key] !== value)) {
        say(`Infisical /${folder}: ${key} is set by this script and is ignored`)
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
