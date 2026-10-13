// Runs the Closeline stack on this machine: `bun run dev`. See docs/local-development.md.
//
// Brings up the dev compose stack, waits for it, gives every database role a fresh password,
// applies the migrations with tula-closeline-db's own script, then starts core, auth and the
// portal from their sibling clones. Secrets live in this process and the children's environments
// only: they are never written to a file and never printed.
import { dirname, join, resolve } from 'node:path'
import {
  type Args,
  buildStackEnv,
  busyPorts,
  COMPOSE_PROJECT,
  checkSiblings,
  generateSecrets,
  LinePrefixer,
  origins,
  type Ports,
  parseArgs,
  probeInternalWiring,
  resolvePorts,
  rotationSql,
  type Secrets,
  secretValues,
  serviceDefinitions,
  siblingDir,
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

/** Runs a command to completion, streaming its output with a prefix. Returns its exit code. */
async function run(
  name: string,
  cmd: string[],
  options: { cwd: string; env: Record<string, string>; stdin?: string; secrets: readonly string[] }
): Promise<number> {
  const proc = Bun.spawn({
    cmd,
    cwd: options.cwd,
    env: options.env,
    stdin: options.stdin === undefined ? 'ignore' : new TextEncoder().encode(options.stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  await Promise.all([
    pump(proc.stdout, new LinePrefixer(name, (l) => process.stdout.write(l), options.secrets)),
    pump(proc.stderr, new LinePrefixer(name, (l) => process.stderr.write(l), options.secrets)),
  ])
  return proc.exited
}

/** Reads a stream to its end through a line prefixer. */
async function pump(stream: ReadableStream<Uint8Array>, prefixer: LinePrefixer): Promise<void> {
  const decoder = new TextDecoder()
  for await (const chunk of stream) {
    prefixer.push(decoder.decode(chunk, { stream: true }))
  }
  prefixer.push(decoder.decode())
  prefixer.flush()
}

/** The output of a command that is expected to be short, or undefined if it failed. */
async function capture(cmd: string[], env: Record<string, string>): Promise<string | undefined> {
  const proc = Bun.spawn({ cmd, cwd: hub, env, stdout: 'pipe', stderr: 'ignore' })
  const text = await new Response(proc.stdout).text()
  return (await proc.exited) === 0 ? text : undefined
}

function compose(...args: string[]): string[] {
  return ['docker', 'compose', '-p', COMPOSE_PROJECT, '-f', composeFile, ...args]
}

/** `--down`: stops the dev stack; with `--volumes` also deletes its data. */
async function down(args: Extract<Args, { kind: 'down' }>, ports: Ports): Promise<number> {
  const stack = buildStackEnv({
    parent: process.env,
    ports,
    secrets: generateSecrets(),
    dbDir: siblingDir(siblingsRoot(), 'db'),
  })
  const extra = args.volumes ? ['--volumes'] : []
  return run('compose', compose('down', '--remove-orphans', ...extra), {
    cwd: hub,
    env: stack.compose,
    secrets: [],
  })
}

function siblingsRoot(): string {
  return process.env.CLOSELINE_SIBLINGS_DIR
    ? resolve(process.env.CLOSELINE_SIBLINGS_DIR)
    : dirname(hub)
}

/** A started service: its process and a promise of its exit code. */
type Running = {
  name: string
  proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>
  exited: Promise<number>
  alive: () => boolean
}

/** Stops every child: SIGTERM, then SIGKILL after `graceMs`. */
async function stopAll(children: Running[], graceMs = 15_000): Promise<void> {
  for (const child of children) {
    if (child.alive()) {
      child.proc.kill('SIGTERM')
    }
  }
  const timer = setTimeout(() => {
    for (const child of children) {
      if (child.alive()) {
        child.proc.kill('SIGKILL')
      }
    }
  }, graceMs)
  await Promise.all(children.map((child) => child.exited))
  clearTimeout(timer)
}

async function up(ports: Ports): Promise<number> {
  const root = siblingsRoot()
  const problems = checkSiblings(root)

  const probeEnv = buildStackEnv({
    parent: process.env,
    ports,
    secrets: generateSecrets(),
    dbDir: siblingDir(root, 'db'),
  })
  if ((await capture(['docker', 'compose', 'version'], probeEnv.compose)) === undefined) {
    problems.push('docker compose is not available: install Docker Desktop or the compose plugin')
  }

  const already = await capture(compose('ps', '--status', 'running', '-q'), probeEnv.compose)
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
  problems.push(...(await busyPorts(wanted)))
  if (problems.length > 0) {
    for (const problem of problems) {
      process.stderr.write(`[dev]      error: ${problem}\n`)
    }
    return 1
  }

  const secrets: Secrets = generateSecrets()
  const redactions = secretValues(secrets)
  const stack = buildStackEnv({
    parent: process.env,
    ports,
    secrets,
    dbDir: siblingDir(root, 'db'),
  })

  say('starting the compose stack (Postgres 18, queue and object storage stand-ins)')
  const composeUp = await run('compose', compose('up', '-d', '--wait', '--wait-timeout', '180'), {
    cwd: hub,
    env: stack.compose,
    secrets: redactions,
  })
  if (composeUp !== 0) {
    process.stderr.write('[dev]      error: docker compose up failed\n')
    return 1
  }

  say('replacing every database role password with a new random one')
  const rotated = await run(
    'compose',
    compose(
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
    ),
    { cwd: hub, env: stack.compose, stdin: rotationSql(secrets), secrets: redactions }
  )
  if (rotated !== 0) {
    process.stderr.write('[dev]      error: could not set the role passwords\n')
    return 1
  }

  say("applying migrations with tula-closeline-db's db:migrate")
  const migrated = await run('migrate', [process.execPath, '--no-env-file', 'run', 'db:migrate'], {
    cwd: siblingDir(root, 'db'),
    env: stack.migrate,
    secrets: redactions,
  })
  if (migrated !== 0) {
    process.stderr.write('[dev]      error: db:migrate failed\n')
    return 1
  }

  const children: Running[] = []
  let shuttingDown = false
  let exitCode = 0
  let wake: () => void = () => {}
  const woken = new Promise<void>((resolveWoken) => {
    wake = resolveWoken
  })

  const begin = (signal: string) => {
    if (!shuttingDown) {
      shuttingDown = true
      say(`${signal}: stopping services (compose keeps running; \`bun run dev --down\` stops it)`)
      wake()
    }
  }
  process.on('SIGINT', () => begin('SIGINT'))
  process.on('SIGTERM', () => begin('SIGTERM'))

  for (const definition of serviceDefinitions(process.execPath, ports)) {
    const stdoutPrefixer = new LinePrefixer(
      definition.name,
      (l) => process.stdout.write(l),
      redactions
    )
    const stderrPrefixer = new LinePrefixer(
      definition.name,
      (l) => process.stderr.write(l),
      redactions
    )
    const proc = Bun.spawn({
      cmd: definition.cmd,
      cwd: siblingDir(root, definition.sibling),
      env: stack[definition.env],
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    let alive = true
    const exited = (async () => {
      await Promise.all([pump(proc.stdout, stdoutPrefixer), pump(proc.stderr, stderrPrefixer)])
      const code = await proc.exited
      alive = false
      if (!shuttingDown) {
        process.stderr.write(`[dev]      error: ${definition.name} exited with code ${code}\n`)
        exitCode = 1
        shuttingDown = true
        wake()
      }
      return code
    })()
    children.push({ name: definition.name, proc, exited, alive: () => alive })

    const failure = await waitForReady(definition.readyUrl, {
      timeoutMs: 90_000,
      isAlive: () => alive && !shuttingDown,
    })
    if (failure !== undefined) {
      if (!shuttingDown) {
        process.stderr.write(`[dev]      error: ${definition.name} ${failure}\n`)
        exitCode = 1
        shuttingDown = true
      }
      break
    }
    say(`${definition.name} is ready`)
  }

  if (!shuttingDown) {
    const where = origins(ports)
    const wiring = await probeInternalWiring({
      coreOrigin: where.core,
      token: secrets.internalToken,
    })
    if (wiring.ok) {
      say("wiring: core accepts auth's internal secret and refuses a wrong one")
    } else {
      process.stderr.write(`[dev]      error: wiring: ${wiring.reason}\n`)
      exitCode = 1
      shuttingDown = true
    }
  }

  if (!shuttingDown) {
    const where = origins(ports)
    say(`auth    ${where.auth}`)
    say(`core    ${where.core}`)
    say(`portal  ${where.portal}`)
    say(
      `Postgres 127.0.0.1:${ports.postgres}, queue :${ports.queue}, object storage :${ports.storage}`
    )
    say('running; Ctrl-C stops the services')
    await woken
  }

  await stopAll(children)
  return exitCode
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
    process.stderr.write(
      `[dev]      error: ${error instanceof Error ? error.message : 'bad ports'}\n`
    )
    process.exit(2)
  }
  const code = args.kind === 'down' ? await down(args, ports) : await up(ports)
  process.exit(code)
}
