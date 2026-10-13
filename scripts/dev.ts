// Runs the Closeline stack on this machine: `bun run dev`. See docs/local-development.md.
//
// Brings up the dev compose stack, waits for it, gives every database login role a fresh
// password, applies the migrations with tula-closeline-db's own script, then starts core, auth and
// the portal from their sibling clones. Secrets live in this process and the children's
// environments only: they are never written to a file and never printed.
import { dirname, join, resolve } from 'node:path'
import {
  type Args,
  assertLoopbackDatabaseUrl,
  buildStackEnv,
  busyPorts,
  captureCommand,
  checkSiblings,
  composeArgs,
  dockerEndpointProblem,
  downArgs,
  generateSecrets,
  LOGIN_ROLES_SQL,
  migrateCommand,
  origins,
  type Ports,
  parseArgs,
  probeInternalWiring,
  resolvePorts,
  rotationSql,
  runCommand,
  type Secrets,
  STOP_SIGNALS,
  secretValues,
  serviceDefinitions,
  siblingDir,
  spawnManaged,
  supervise,
  TIMEOUTS,
  unrotatedLoginRoles,
  waitForReady,
} from './dev-lib.ts'

const hub = resolve(import.meta.dir, '..')
const composeFile = join(hub, 'compose.dev.yaml')

const USAGE = `usage: bun run dev [--down [--volumes]]

  (no flags)         start the stack and the three services; Ctrl-C stops the services
  --down             stop and remove the dev compose containers
  --down --volumes   also delete the dev stack's volumes (database and storage data)

Environment: CLOSELINE_SIBLINGS_DIR (where the tula-closeline-* clones are, default: next to
this repo), CLOSELINE_DEV_{POSTGRES,QUEUE,STORAGE,AUTH,CORE,PORTAL}_PORT.
`

/** Writes a line of this script's own output. */
function say(line: string): void {
  process.stdout.write(`[dev]      ${line}\n`)
}

/** Writes an error line of this script's own output. */
function fail(line: string): void {
  process.stderr.write(`[dev]      error: ${line}\n`)
}

function siblingsRoot(): string {
  return process.env.CLOSELINE_SIBLINGS_DIR
    ? resolve(process.env.CLOSELINE_SIBLINGS_DIR)
    : dirname(hub)
}

/** Runs one step to completion; on a non-zero exit or a timeout prints why and returns false. */
async function step(
  name: string,
  cmd: string[],
  options: Parameters<typeof runCommand>[2],
  failure: string
): Promise<boolean> {
  const { code, timedOut } = await runCommand(name, cmd, options)
  if (code === 0) {
    return true
  }
  fail(timedOut ? `${failure} (timed out after ${options.timeoutMs / 1000} s)` : failure)
  return false
}

/** Builds the stack environment, or prints why it cannot and returns undefined. */
function stackEnv(ports: Ports, secrets: Secrets, root: string) {
  try {
    return buildStackEnv({ parent: process.env, ports, secrets, dbDir: siblingDir(root, 'db') })
  } catch (error) {
    fail(error instanceof Error ? error.message : 'could not build the environment')
    return undefined
  }
}

/** `--down`: stops the dev stack; with `--volumes` also deletes its data. */
async function down(args: Extract<Args, { kind: 'down' }>, ports: Ports): Promise<number> {
  const stack = stackEnv(ports, generateSecrets(), siblingsRoot())
  if (!stack) {
    return 1
  }
  const ok = await step(
    'compose',
    downArgs(composeFile, args.volumes),
    { cwd: hub, env: stack.compose, secrets: [], timeoutMs: TIMEOUTS.composeDown },
    'docker compose down failed'
  )
  return ok ? 0 : 1
}

async function up(ports: Ports): Promise<number> {
  const root = siblingsRoot()
  const problems = checkSiblings(root)

  const secrets: Secrets = generateSecrets()
  const redactions = secretValues(secrets)
  const stack = stackEnv(ports, secrets, root)
  if (!stack) {
    return 1
  }
  assertLoopbackDatabaseUrl(stack.migrate.DATABASE_URL ?? '')
  const quick = { cwd: hub, env: stack.compose, timeoutMs: TIMEOUTS.dockerQuick }

  if ((await captureCommand(['docker', 'compose', 'version'], quick)) === undefined) {
    problems.push('docker compose is not available: install Docker Desktop or the compose plugin')
  } else {
    const endpoint = await dockerEndpointProblem(process.env, async () =>
      (
        await captureCommand(
          ['docker', 'context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'],
          quick
        )
      )?.trim()
    )
    if (endpoint !== undefined) {
      problems.push(endpoint)
    }
  }
  if (problems.length > 0) {
    for (const problem of problems) {
      fail(problem)
    }
    return 1
  }

  const already = await captureCommand(composeArgs(composeFile, 'ps', '-q'), quick)
  const stackRunning = (already ?? '').trim() !== ''
  const wanted = [
    { name: 'auth', port: ports.auth },
    { name: 'core', port: ports.core },
    { name: 'portal', port: ports.portal },
    ...(stackRunning
      ? []
      : [
          { name: 'Postgres', port: ports.postgres },
          { name: 'queue stand-in', port: ports.queue },
          { name: 'object storage stand-in', port: ports.storage },
        ]),
  ]
  const busy = await busyPorts(wanted)
  if (busy.length > 0) {
    for (const problem of busy) {
      fail(`${problem} (a service left running by a killed run? stop that process)`)
    }
    return 1
  }

  say('starting the compose stack (Postgres 18, queue and object storage stand-ins)')
  if (
    !(await step(
      'compose',
      composeArgs(composeFile, 'up', '-d', '--wait', '--wait-timeout', '180'),
      { cwd: hub, env: stack.compose, secrets: redactions, timeoutMs: TIMEOUTS.composeUp },
      'docker compose up failed'
    ))
  ) {
    return 1
  }

  const psql = composeArgs(
    composeFile,
    'exec',
    '-T',
    'postgres',
    'psql',
    '-U',
    'postgres',
    '-d',
    'closeline',
    '-v',
    'ON_ERROR_STOP=1',
    '-q'
  )
  const logins = await captureCommand([...psql, '-At'], {
    ...quick,
    timeoutMs: TIMEOUTS.psql,
    stdin: `${LOGIN_ROLES_SQL};\n`,
  })
  if (logins === undefined) {
    fail('could not list the database login roles')
    return 1
  }
  const unknown = unrotatedLoginRoles(logins)
  if (unknown.length > 0) {
    fail(
      `the database has login role(s) this script does not give a new password: ${unknown.join(', ')}. ` +
        'Add them to ROLES in scripts/dev-lib.ts. Continuing would leave a known password valid.'
    )
    return 1
  }

  say('replacing every database login role password with a new random one')
  if (
    !(await step(
      'compose',
      psql,
      {
        cwd: hub,
        env: stack.compose,
        stdin: rotationSql(secrets),
        secrets: redactions,
        timeoutMs: TIMEOUTS.psql,
      },
      'could not set the role passwords'
    ))
  ) {
    return 1
  }

  say("applying migrations with tula-closeline-db's migrate script")
  if (
    !(await step(
      'migrate',
      migrateCommand(process.execPath),
      {
        cwd: siblingDir(root, 'db'),
        env: stack.migrate,
        secrets: redactions,
        timeoutMs: TIMEOUTS.migrate,
      },
      'db migrate failed'
    ))
  ) {
    return 1
  }

  const where = origins(ports)
  return supervise({
    services: serviceDefinitions(process.execPath, ports).map((definition) => ({
      name: definition.name,
      readyUrl: definition.readyUrl,
      spawn: () =>
        spawnManaged(definition.name, definition.cmd, {
          cwd: siblingDir(root, definition.sibling),
          env: stack[definition.env],
          secrets: redactions,
        }),
    })),
    probe: () => probeInternalWiring({ coreOrigin: where.core, token: secrets.internalToken }),
    waitReady: (url, isAlive) => waitForReady(url, { timeoutMs: 90_000, isAlive }),
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
    log: say,
    error: fail,
    banner: () => {
      say(`auth    ${where.auth}`)
      say(`core    ${where.core}`)
      say(`portal  ${where.portal}`)
      say(
        `Postgres 127.0.0.1:${ports.postgres}, queue :${ports.queue}, object storage :${ports.storage}`
      )
      say('running; Ctrl-C stops the services')
    },
  })
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
  const code = args.kind === 'down' ? await down(args, ports) : await up(ports)
  process.exit(code)
}
