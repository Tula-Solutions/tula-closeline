// Runs the Closeline stack on this machine: `bun run dev`. See docs/local-development.md.
// This file only parses the arguments and wires the real effects into the flow in dev-flow.ts.
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { type FlowContext, type FlowDeps, runDown, runUp } from './dev-flow.ts'
import {
  acquireStartLock,
  buildStackEnv,
  busyPorts,
  captureCommand,
  checkSiblings,
  freshSalt,
  generateSecrets,
  type Ports,
  parseArgs,
  probeInternalWiring,
  resolvePorts,
  resolvePublicOrigin,
  runCommand,
  STOP_SIGNALS,
  spawnManaged,
  stopLockHolder,
  supervise,
  waitForReady,
} from './dev-lib.ts'

const hub = resolve(import.meta.dir, '..')

const USAGE = `usage: bun run dev [--down [--volumes]]

  (no flags)         start the stack and the four services; Ctrl-C stops the services
  --down             stop the running stack (the bun run dev process and its services), then the compose containers
  --down --volumes   also delete the dev stack's volumes (database and storage data)

Environment: CLOSELINE_SIBLINGS_DIR (where the tula-closeline-* clones are, default: next to
this repo), CLOSELINE_DEV_{POSTGRES,QUEUE,STORAGE,MAIL,AUTH,CORE,PLAYBOOK,VOICE,PORTAL,FAKE_GOOGLE}_PORT.

Sign in with Google: with no GOOGLE_* variable set, a fake provider (loopback only) is started and
used. Set all of GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI to use real Google.
`

function say(line: string): void {
  process.stdout.write(`[dev]      ${line}\n`)
}

function fail(line: string): void {
  process.stderr.write(`[dev]      error: ${line}\n`)
}

/** The real effects of the flow, with fresh secrets. Exported so a test can check the wiring. */
export function createDeps(): FlowDeps {
  return {
    run: runCommand,
    capture: captureCommand,
    spawn: spawnManaged,
    supervise,
    busy: busyPorts,
    lock: acquireStartLock,
    stopHolder: () => stopLockHolder(),
    siblingProblems: (root) => checkSiblings(root),
    buildEnv: (options) =>
      buildStackEnv({
        ...options,
        queueConfig: readFileSync(join(hub, 'scripts/dev/elasticmq.conf'), 'utf8'),
      }),
    secrets: generateSecrets(),
    salt: freshSalt,
    subscribe: (onSignal) => {
      for (const signal of STOP_SIGNALS) {
        process.on(signal, onSignal)
      }
      return () => {
        for (const signal of STOP_SIGNALS) {
          process.off(signal, onSignal)
        }
      }
    },
    probe: probeInternalWiring,
    waitReady: (url, isAlive) => waitForReady(url, { timeoutMs: 90_000, isAlive }),
    say,
    fail,
  }
}

/** Where the flow runs: the hub, the clones, the ports, and the environment it was started with. */
export function createContext(env: Record<string, string | undefined>, ports: Ports): FlowContext {
  return {
    hub,
    composeFile: join(hub, 'compose.dev.yaml'),
    root: env.CLOSELINE_SIBLINGS_DIR ? resolve(env.CLOSELINE_SIBLINGS_DIR) : dirname(hub),
    ports,
    parentEnv: env,
    execPath: process.execPath,
  }
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2))
  if (args.kind === 'help') {
    process.stdout.write(USAGE)
    process.exit(0)
  }
  if (args.kind === 'error') {
    process.stderr.write(`[dev]      error: ${args.message}\n${USAGE}`)
    process.exit(2)
  }
  let ports: Ports
  try {
    ports = resolvePorts(process.env)
    resolvePublicOrigin(process.env)
  } catch (error) {
    fail(error instanceof Error ? error.message : 'bad ports')
    process.exit(2)
  }
  const context = createContext(process.env, ports)
  const deps = createDeps()
  process.exit(
    args.kind === 'down' ? await runDown(context, deps, args.volumes) : await runUp(context, deps)
  )
}
