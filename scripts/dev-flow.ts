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
  ensureRolesSql,
  type HolderOutcome,
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
    options: SpawnOptions & { timeoutMs: number }
  ) => ReturnType<typeof runCommand>
  capture: (
    cmd: string[],
    options: {
      cwd: string
      env: Record<string, string>
      timeoutMs: number
      stdin?: string
      signal?: AbortSignal
      force?: AbortSignal
    }
  ) => ReturnType<typeof captureCommand>
  spawn: (name: string, cmd: string[], options: SpawnOptions) => ManagedChild
  supervise: (options: SuperviseOptions) => Promise<number>
  busy: (wanted: { name: string; port: number }[]) => ReturnType<typeof busyPorts>
  /**
   * Takes the machine-wide start-up lock. The compose project and every port are shared, and a
   * start replaces the database role passwords, so a second start would break the first.
   */
  lock: () => { held: false; release: () => void } | { held: true; pid?: number; path: string }
  /** Stops the `bun run dev` that holds the start lock (for `--down`). */
  stopHolder: () => Promise<HolderOutcome>
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
export const INTERRUPTED = 130

/**
 * Builds the environment and applies the two guards, before any Docker or database command:
 * the database address must be loopback, and the Docker endpoint in effect (the variable or the
 * current context) must be a unix socket. Prints why and returns undefined if either fails.
 */
async function prepare(
  ctx: FlowContext,
  deps: FlowDeps,
  abort: Abort,
  parent: Record<string, string | undefined> = ctx.parentEnv
) {
  let stack: StackEnv
  try {
    stack = deps.buildEnv({
      parent,
      ports: ctx.ports,
      secrets: deps.secrets,
      dbDir: siblingDir(ctx.root, 'db'),
    })
    for (const env of [stack.migrate, stack.auth, stack.core, stack.playbook, stack.voice]) {
      assertLoopbackDatabaseUrl(env.DATABASE_URL ?? '')
    }
  } catch (error) {
    deps.fail(error instanceof Error ? error.message : 'could not build the environment')
    return undefined
  }
  const quick = { cwd: ctx.hub, env: stack.compose, timeoutMs: TIMEOUTS.dockerQuick, ...abort }
  const endpoint = await dockerEndpointProblem(ctx.parentEnv, async () =>
    (
      await deps.capture(
        ['docker', 'context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'],
        quick
      )
    )?.trim()
  )
  if (endpoint !== undefined) {
    // A signal that cut the check short is not a problem with Docker: say nothing.
    if (!abort.signal.aborted) {
      deps.fail(endpoint)
    }
    return undefined
  }
  return { stack, quick }
}

/** The two abort signals every subprocess step gets: stop it (SIGTERM), then kill it (SIGKILL). */
type Abort = { signal: AbortSignal; force: AbortSignal }

/**
 * Handles stop signals for the whole run. The first aborts the active subprocess, a second kills
 * one that ignored it. Once the services run, signals go to the supervisor, and stay with it
 * through shutdown: nothing after the hand-over prints a start-up message.
 */
function interrupts(deps: FlowDeps) {
  const stop = new AbortController()
  const kill = new AbortController()
  let forward: ((signal: string) => void) | undefined
  const off = deps.subscribe((signal) => {
    if (forward) {
      forward(signal)
    } else if (!stop.signal.aborted) {
      deps.say(`${signal}: stopping the step in progress`)
      stop.abort()
    } else if (!kill.signal.aborted) {
      deps.say(`${signal} again: killing the step in progress`)
      kill.abort()
    }
  })
  return {
    abort: { signal: stop.signal, force: kill.signal } satisfies Abort,
    handOver: (handler: (signal: string) => void) => {
      forward = handler
      return () => {}
    },
    off,
  }
}

/** `--down`: stops the dev stack; with `volumes` also deletes its data. */
export async function runDown(ctx: FlowContext, deps: FlowDeps, volumes: boolean): Promise<number> {
  const interrupt = interrupts(deps)
  let taken: ReturnType<FlowDeps['lock']> | undefined
  try {
    const holder = await deps.stopHolder()
    if (holder.kind === 'failed') {
      deps.fail(holder.reason)
      return 1
    }
    if (holder.kind === 'stopped' || holder.kind === 'killed') {
      deps.say(
        holder.kind === 'stopped'
          ? `stopped the running stack (pid ${holder.pid})`
          : `the running stack (pid ${holder.pid}) ignored SIGTERM and was killed`
      )
    }
    // Hold the start lock so a start cannot race `compose down`.
    taken = deps.lock()
    if (taken.held) {
      deps.fail(
        `a start is in progress (lock ${taken.path}${taken.pid === undefined ? '' : `, pid ${taken.pid}`}); try --down again once it is up`
      )
      return 1
    }
    // `--down` needs only the compose environment, so a bad Google setting must not stop it.
    const withoutGoogle = Object.fromEntries(
      Object.entries(ctx.parentEnv).filter(([name]) => !name.startsWith('GOOGLE_'))
    )
    const ready = await prepare(ctx, deps, interrupt.abort, withoutGoogle)
    if (!ready || interrupt.abort.signal.aborted) {
      return interrupt.abort.signal.aborted ? INTERRUPTED : 1
    }
    const { code, timedOut } = await deps.run('compose', downArgs(ctx.composeFile, volumes), {
      cwd: ctx.hub,
      env: ready.stack.compose,
      secrets: [],
      timeoutMs: TIMEOUTS.composeDown,
      ...interrupt.abort,
    })
    if (interrupt.abort.signal.aborted) {
      return INTERRUPTED
    }
    if (code !== 0) {
      deps.fail(timedOut ? 'docker compose down timed out' : 'docker compose down failed')
    }
    return code === 0 ? 0 : 1
  } finally {
    if (taken && !taken.held) {
      taken.release()
    }
    interrupt.off()
  }
}

/** `bun run dev`: the whole start-up in order, then the supervised services. */
export async function runUp(ctx: FlowContext, deps: FlowDeps): Promise<number> {
  const lock = deps.lock()
  if (lock.held) {
    deps.fail(
      lock.pid === undefined
        ? `could not take the lock ${lock.path}: another start may be in progress; try again, ` +
            'or delete the file if nothing is running'
        : `a dev stack is already running (bun run dev, pid ${lock.pid}): reuse it, or stop it first. ` +
            `Starting a second one would replace the database passwords the first uses. Lock: ${lock.path}`
    )
    return 1
  }
  try {
    return await runUpLocked(ctx, deps)
  } finally {
    lock.release()
  }
}

/** The start-up proper, run while this process holds the lock. */
async function runUpLocked(ctx: FlowContext, deps: FlowDeps): Promise<number> {
  const interrupt = interrupts(deps)
  const { abort } = interrupt
  const stopped = () => abort.signal.aborted
  const failed = () => (stopped() ? INTERRUPTED : 1)
  try {
    const ready = await prepare(ctx, deps, abort)
    if (!ready || stopped()) {
      return failed()
    }
    const { stack, quick } = ready
    // The developer's own Google client secret, when there is one, is scrubbed like the generated ones.
    const googleSecret = stack.fakeGoogle ? undefined : stack.auth.GOOGLE_CLIENT_SECRET
    const redactions = [...secretValues(deps.secrets), ...(googleSecret ? [googleSecret] : [])]

    const problems = deps.siblingProblems(ctx.root)
    const hasCompose = (await deps.capture(['docker', 'compose', 'version'], quick)) !== undefined
    if (stopped()) {
      return failed()
    }
    if (!hasCompose) {
      problems.push('docker compose is not available: install Docker Desktop or the compose plugin')
    }
    if (problems.length > 0) {
      for (const problem of problems) {
        deps.fail(problem)
      }
      return failed()
    }

    const { ports } = ctx
    // A compose container that is already running holds its own port; one that is not running
    // (a stack from an older version of this file, or one that was stopped) will need its port.
    const stackParts = [
      { service: 'postgres', name: 'Postgres', port: ports.postgres },
      { service: 'queue', name: 'queue stand-in', port: ports.queue },
      { service: 'storage', name: 'object storage stand-in', port: ports.storage },
      { service: 'mail', name: 'mailbox', port: ports.mail },
    ]
    const notRunning: { name: string; port: number }[] = []
    for (const part of stackParts) {
      const running = await deps.capture(
        composeArgs(ctx.composeFile, 'ps', '-q', part.service),
        quick
      )
      if ((running ?? '').trim() === '') {
        notRunning.push({ name: part.name, port: part.port })
      }
    }
    const wanted = [
      { name: 'auth', port: ports.auth },
      { name: 'core', port: ports.core },
      { name: 'playbook', port: ports.playbook },
      { name: 'voice', port: ports.voice },
      { name: 'outbound', port: ports.outbound },
      { name: 'portal', port: ports.portal },
      ...(stack.fakeGoogle ? [{ name: 'fake Google', port: ports.fakeGoogle }] : []),
      ...notRunning,
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
        ...abort,
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

    deps.say('starting the compose stack (Postgres 18, queue, object storage and mailbox)')
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

    const mailbox = `${origins(ctx.ports).mail}/livez`
    const mailFailure = await deps.waitReady(mailbox, () => !stopped())
    if (stopped()) {
      return failed()
    }
    if (mailFailure !== undefined) {
      deps.fail(`mailbox ${mailFailure}`)
      return 1
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

    deps.say('creating any database role that the volume was made without')
    if (
      !(await step(
        'compose',
        psql,
        {
          cwd: ctx.hub,
          env: stack.compose,
          stdin: ensureRolesSql(),
          timeoutMs: TIMEOUTS.psql,
        },
        'could not create the NOLOGIN database roles'
      ))
    ) {
      return failed()
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
      services: serviceDefinitions(ctx.execPath, ports, stack.fakeGoogle !== undefined).map(
        (definition) => ({
          name: definition.name,
          readyUrl: definition.readyUrl,
          spawn: () =>
            deps.spawn(definition.name, definition.cmd, {
              cwd: definition.sibling ? siblingDir(ctx.root, definition.sibling) : ctx.hub,
              env: stack[definition.env] ?? {},
              secrets: redactions,
            }),
        })
      ),
      probe: () => deps.probe({ coreOrigin: where.core, token: deps.secrets.internalToken }),
      waitReady: deps.waitReady,
      subscribe: (onSignal) => interrupt.handOver(onSignal),
      log: deps.say,
      error: deps.fail,
      banner: () => {
        deps.say(`auth    ${where.auth}`)
        deps.say(`core    ${where.core}`)
        deps.say(`playbook ${where.playbook}  (API and workers in one process)`)
        deps.say(
          `voice   ${where.voice}  (Lines; numbers come from an in-memory stand-in, never Twilio)`
        )
        deps.say(`outbound ${where.outbound}  (health routes only so far)`)
        deps.say(`portal  ${where.portal}`)
        deps.say(
          stack.fakeGoogle
            ? `fake Google ${where.fakeGoogle}  (Sign in with Google as any email; loopback only, so only from this machine)`
            : 'Sign in with Google: real Google, with the GOOGLE_* settings of this shell'
        )
        deps.say(
          `mailbox ${where.mail}  (Mailpit: read the sign-up codes and Invitation emails here)`
        )
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
