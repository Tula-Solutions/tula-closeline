// Runs the Closeline stack on this machine: `bun run dev`. See docs/local-development.md.
// This file only parses the arguments and wires the real effects into the flow in dev-flow.ts.
import { dirname, join, resolve } from 'node:path'
import { runDown, runUp } from './dev-flow.ts'
import {
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
  runCommand,
  STOP_SIGNALS,
  spawnManaged,
  supervise,
  waitForReady,
} from './dev-lib.ts'

const hub = resolve(import.meta.dir, '..')

const USAGE = `usage: bun run dev [--down [--volumes]]

  (no flags)         start the stack and the three services; Ctrl-C stops the services
  --down             stop and remove the dev compose containers
  --down --volumes   also delete the dev stack's volumes (database and storage data)

Environment: CLOSELINE_SIBLINGS_DIR (where the tula-closeline-* clones are, default: next to
this repo), CLOSELINE_DEV_{POSTGRES,QUEUE,STORAGE,AUTH,CORE,PORTAL}_PORT.
`

function say(line: string): void {
  process.stdout.write(`[dev]      ${line}\n`)
}

function fail(line: string): void {
  process.stderr.write(`[dev]      error: ${line}\n`)
}

/** The real effects of the flow. */
const deps = {
  run: runCommand,
  capture: captureCommand,
  spawn: spawnManaged,
  supervise,
  busy: busyPorts,
  siblingProblems: (root: string) => checkSiblings(root),
  buildEnv: buildStackEnv,
  secrets: generateSecrets(),
  salt: freshSalt,
  subscribe: (onSignal: (signal: string) => void) => {
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
  waitReady: (url: string, isAlive: () => boolean) =>
    waitForReady(url, { timeoutMs: 90_000, isAlive }),
  say,
  fail,
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
  } catch (error) {
    fail(error instanceof Error ? error.message : 'bad ports')
    process.exit(2)
  }
  const context = {
    hub,
    composeFile: join(hub, 'compose.dev.yaml'),
    root: process.env.CLOSELINE_SIBLINGS_DIR
      ? resolve(process.env.CLOSELINE_SIBLINGS_DIR)
      : dirname(hub),
    ports,
    parentEnv: process.env,
    execPath: process.execPath,
  }
  process.exit(
    args.kind === 'down' ? await runDown(context, deps, args.volumes) : await runUp(context, deps)
  )
}
