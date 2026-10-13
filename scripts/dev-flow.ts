// The ordered steps of `bun run dev` and `bun run dev --down`, with every effect injected so the
// order and the guards can be tested without Docker. scripts/dev.ts only wires the real functions.
import {
  assertLoopbackDatabaseUrl,
  type buildStackEnv,
  type busyPorts,
  type captureCommand,
  composeArgs,
  dockerEndpointProblem,
  downArgs,
  LOGIN_ROLES_SQL,
  type ManagedChild,
  migrateCommand,
  origins,
  type Ports,
  rotationSql,
  type runCommand,
  type Secrets,
  type SpawnOptions,
  type StackEnv,
  type SuperviseOptions,
  secretValues,
  serviceDefinitions,
  siblingDir,
  TIMEOUTS,
  unrotatedLoginRoles,
  type WiringResult,
} from './dev-lib.ts'

/** Where and with what the flow runs. */
export type FlowContext = {
  hub: string
  composeFile: string
  /** The folder that holds the tula-closeline-* clones. */
  root: string
  ports: Ports
  parentEnv: Record<string, string | undefined>
  /** The path of the running Bun, used to start the services. */
  execPath: string
}

/** Every effect the flow has; the real ones are wired in scripts/dev.ts. */
export type FlowDeps = {
  run: (
    name: string,
    cmd: string[],
    options: SpawnOptions & { timeoutMs: number; signal?: AbortSignal }
  ) => ReturnType<typeof runCommand>
  capture: (
    cmd: string[],
    options: {
      cwd: string
      env: Record<string, string>
      timeoutMs: number
      stdin?: string
      signal?: AbortSignal
    }
  ) => ReturnType<typeof captureCommand>
  spawn: (name: string, cmd: string[], options: SpawnOptions) => ManagedChild
  supervise: (options: SuperviseOptions) => Promise<number>
  busy: (wanted: { name: string; port: number }[]) => ReturnType<typeof busyPorts>
  siblingProblems: (root: string) => string[]
  buildEnv: typeof buildStackEnv
  secrets: Secrets
  salt: () => Buffer
  subscribe: SuperviseOptions['subscribe']
  probe: (options: { coreOrigin: string; token: string }) => Promise<WiringResult>
  waitReady: SuperviseOptions['waitReady']
  say: (line: string) => void
  fail: (line: string) => void
}

/** The exit code after a signal stopped the start-up. */
const INTERRUPTED = 130

/**
 * Builds the environment and applies the two guards, before any Docker or database command:
 * the database address must be loopback, and the Docker endpoint in effect (the variable or the
 * current context) must be a unix socket. Prints why and returns undefined if either fails.
 */
async function prepare(ctx: FlowContext, deps: FlowDeps, signal: AbortSignal) {
  let stack: StackEnv
  try {
    stack = deps.buildEnv({
      parent: ctx.parentEnv,
      ports: ctx.ports,
      secrets: deps.secrets,
      dbDir: siblingDir(ctx.root, 'db'),
    })
    for (const env of [stack.migrate, stack.auth, stack.core]) {
      assertLoopbackDatabaseUrl(env.DATABASE_URL ?? '')
    }
  } catch (error) {
    deps.fail(error instanceof Error ? error.message : 'could not build the environment')
    return undefined
  }
  const quick = { cwd: ctx.hub, env: stack.compose, timeoutMs: TIMEOUTS.dockerQuick, signal }
  const endpoint = await dockerEndpointProblem(ctx.parentEnv, async () =>
    (
      await deps.capture(
        ['docker', 'context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'],
        quick
      )
    )?.trim()
  )
  if (endpoint !== undefined) {
    deps.fail(endpoint)
    return undefined
  }
  return { stack, quick }
}

/** Handles stop signals for the whole run: aborts the active subprocess until the services run. */
function interrupts(deps: FlowDeps) {
  const controller = new AbortController()
  let forward: ((signal: string) => void) | undefined
  const off = deps.subscribe((signal) => {
    if (forward) {
      forward(signal)
    } else if (!controller.signal.aborted) {
      deps.say(`${signal}: stopping the step in progress`)
      controller.abort()
    }
  })
  return {
    signal: controller.signal,
    handOver: (handler: (signal: string) => void) => {
      forward = handler
      return () => {
        forward = undefined
      }
    },
    off,
  }
}

/** `--down`: stops the dev stack; with `volumes` also deletes its data. */
export async function runDown(ctx: FlowContext, deps: FlowDeps, volumes: boolean): Promise<number> {
  const interrupt = interrupts(deps)
  try {
    const ready = await prepare(ctx, deps, interrupt.signal)
    if (!ready || interrupt.signal.aborted) {
      return interrupt.signal.aborted ? INTERRUPTED : 1
    }
    const { code, timedOut } = await deps.run('compose', downArgs(ctx.composeFile, volumes), {
      cwd: ctx.hub,
      env: ready.stack.compose,
      secrets: [],
      timeoutMs: TIMEOUTS.composeDown,
      signal: interrupt.signal,
    })
    if (code !== 0) {
      deps.fail(timedOut ? 'docker compose down timed out' : 'docker compose down failed')
    }
    return code === 0 ? 0 : interrupt.signal.aborted ? INTERRUPTED : 1
  } finally {
    interrupt.off()
  }
}

/** `bun run dev`: the whole start-up in order, then the supervised services. */
export async function runUp(ctx: FlowContext, deps: FlowDeps): Promise<number> {
  const interrupt = interrupts(deps)
  const { signal } = interrupt
  const stopped = () => signal.aborted
  const failed = () => (stopped() ? INTERRUPTED : 1)
  try {
    const ready = await prepare(ctx, deps, signal)
    if (!ready || stopped()) {
      return failed()
    }
    const { stack, quick } = ready
    const redactions = secretValues(deps.secrets)

    const problems = deps.siblingProblems(ctx.root)
    if ((await deps.capture(['docker', 'compose', 'version'], quick)) === undefined) {
      problems.push('docker compose is not available: install Docker Desktop or the compose plugin')
    }
    if (problems.length > 0 || stopped()) {
      for (const problem of problems) {
        deps.fail(problem)
      }
      return failed()
    }

    const already = await deps.capture(composeArgs(ctx.composeFile, 'ps', '-q'), quick)
    const { ports } = ctx
    const wanted = [
      { name: 'auth', port: ports.auth },
      { name: 'core', port: ports.core },
      { name: 'portal', port: ports.portal },
      ...((already ?? '').trim() !== ''
        ? []
        : [
            { name: 'Postgres', port: ports.postgres },
            { name: 'queue stand-in', port: ports.queue },
            { name: 'object storage stand-in', port: ports.storage },
          ]),
    ]
    const busy = await deps.busy(wanted)
    if (busy.length > 0 || stopped()) {
      for (const problem of busy) {
        deps.fail(`${problem} (a service left running by a killed run? stop that process)`)
      }
      return failed()
    }

    /** One subprocess step; false means stop (and print why). */
    const step = async (
      name: string,
      cmd: string[],
      options: { cwd: string; env: Record<string, string>; timeoutMs: number; stdin?: string },
      failure: string
    ): Promise<boolean> => {
      const { code, timedOut } = await deps.run(name, cmd, {
        ...options,
        secrets: redactions,
        signal,
      })
      if (stopped()) {
        return false
      }
      if (code !== 0) {
        deps.fail(timedOut ? `${failure} (timed out after ${options.timeoutMs / 1000} s)` : failure)
        return false
      }
      return true
    }

    deps.say('starting the compose stack (Postgres 18, queue and object storage stand-ins)')
    if (
      !(await step(
        'compose',
        composeArgs(ctx.composeFile, 'up', '-d', '--wait', '--wait-timeout', '180'),
        { cwd: ctx.hub, env: stack.compose, timeoutMs: TIMEOUTS.composeUp },
        'docker compose up failed'
      ))
    ) {
      return failed()
    }

    const psql = composeArgs(
      ctx.composeFile,
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
    const logins = await deps.capture([...psql, '-At'], {
      ...quick,
      timeoutMs: TIMEOUTS.psql,
      stdin: `${LOGIN_ROLES_SQL};\n`,
    })
    if (stopped()) {
      return failed()
    }
    if (logins === undefined) {
      deps.fail('could not list the database login roles')
      return 1
    }
    const unknown = unrotatedLoginRoles(logins)
    if (unknown.length > 0) {
      deps.fail(
        `the database has login role(s) this script does not give a new password: ${unknown.join(', ')}. ` +
          'Add them to ROLES in scripts/dev-lib.ts. Continuing would leave a known password valid.'
      )
      return 1
    }

    deps.say('replacing every database login role password with a new random one')
    if (
      !(await step(
        'compose',
        psql,
        {
          cwd: ctx.hub,
          env: stack.compose,
          stdin: rotationSql(deps.secrets, deps.salt),
          timeoutMs: TIMEOUTS.psql,
        },
        'could not set the role passwords'
      ))
    ) {
      return failed()
    }

    deps.say("applying migrations with tula-closeline-db's migrate script")
    if (
      !(await step(
        'migrate',
        migrateCommand(ctx.execPath),
        { cwd: siblingDir(ctx.root, 'db'), env: stack.migrate, timeoutMs: TIMEOUTS.migrate },
        'db migrate failed'
      ))
    ) {
      return failed()
    }

    const where = origins(ports)
    return await deps.supervise({
      services: serviceDefinitions(ctx.execPath, ports).map((definition) => ({
        name: definition.name,
        readyUrl: definition.readyUrl,
        spawn: () =>
          deps.spawn(definition.name, definition.cmd, {
            cwd: siblingDir(ctx.root, definition.sibling),
            env: stack[definition.env],
            secrets: redactions,
          }),
      })),
      probe: () => deps.probe({ coreOrigin: where.core, token: deps.secrets.internalToken }),
      waitReady: deps.waitReady,
      subscribe: (onSignal) => interrupt.handOver(onSignal),
      log: deps.say,
      error: deps.fail,
      banner: () => {
        deps.say(`auth    ${where.auth}`)
        deps.say(`core    ${where.core}`)
        deps.say(`portal  ${where.portal}`)
        deps.say(
          `Postgres 127.0.0.1:${ports.postgres}, queue :${ports.queue}, object storage :${ports.storage}`
        )
        deps.say('running; Ctrl-C stops the services')
      },
    })
  } finally {
    interrupt.off()
  }
}
