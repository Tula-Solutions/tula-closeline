import './test-guard.ts'
import { describe, expect, test } from 'bun:test'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const hub = join(import.meta.dir, '..')
const SPAWN_TIMEOUT_MS = 20_000

function run(command: string[], options: { stdin?: string; env?: Record<string, string> } = {}) {
  const proc = Bun.spawnSync(command, {
    stdin: options.stdin === undefined ? undefined : Buffer.from(options.stdin),
    env: { ...(process.env as Record<string, string>), ...options.env },
    timeout: SPAWN_TIMEOUT_MS,
  })
  if (proc.exitedDueToTimeout) {
    throw new Error(`timed out: ${command.join(' ')}`)
  }
  return { code: proc.exitCode, stderr: proc.stderr.toString(), stdout: proc.stdout.toString() }
}

/** A throwaway repo directory with the shared setup synced into it. */
function syncedRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'closeline-sync-'))
  const result = run(['bash', join(hub, 'scripts/sync-shared.sh'), dir])
  expect(result.code).toBe(0)
  return dir
}

function protect(root: string, path: string) {
  return run(['bash', join(hub, 'shared/.claude/hooks/protect-files.sh')], {
    stdin: JSON.stringify({ tool_input: { file_path: path } }),
    env: { CLAUDE_PROJECT_DIR: root },
  }).code
}

describe('protect-files.sh', () => {
  const repo = syncedRepo()

  test.each(['dist/index.js', 'bun.lock', '.env', 'src/.env.local', 'src/routes.gen.ts'])(
    'blocks %s',
    (path) => {
      expect(protect(repo, path)).toBe(2)
    }
  )

  test.each(['src/app.ts', '.env.example', 'AGENTS.md', 'a/../src/app.ts'])('allows %s', (path) => {
    expect(protect(repo, path)).toBe(0)
  })

  test('blocks a file synced from the hub, by relative or dotted path', () => {
    expect(protect(repo, '.claude/COMMON.md')).toBe(2)
    expect(protect(repo, join(repo, 'src/../biome.json'))).toBe(2)
  })

  test('allows the same file in the hub, where there is no lock', () => {
    const bare = mkdtempSync(join(tmpdir(), 'closeline-hub-'))
    expect(protect(bare, 'shared/.claude/COMMON.md')).toBe(0)
  })
})

describe('sync-shared.sh and shared-check.sh', () => {
  test('a freshly synced repo is in sync and passes its own check', () => {
    const repo = syncedRepo()
    expect(run(['bash', join(hub, 'scripts/sync-shared.sh'), '--check', repo]).code).toBe(0)
    expect(run(['bash', join(repo, '.claude/hooks/shared-check.sh')]).code).toBe(0)
    expect(readFileSync(join(repo, 'GLOSSARY.md'), 'utf8')).toContain('**Organization**')
  })

  test('editing a synced file fails both checks and names the file', () => {
    const repo = syncedRepo()
    writeFileSync(join(repo, '.claude/COMMON.md'), 'edited in a service repo\n')

    const fromHub = run(['bash', join(hub, 'scripts/sync-shared.sh'), '--check', repo])
    expect(fromHub.code).toBe(1)
    expect(fromHub.stderr).toContain('.claude/COMMON.md')
    expect(run(['bash', join(repo, '.claude/hooks/shared-check.sh')]).code).toBe(1)
  })

  test('a repo with no lock fails its check', () => {
    const repo = mkdtempSync(join(tmpdir(), 'closeline-nolock-'))
    mkdirSync(join(repo, '.claude/hooks'), { recursive: true })
    cpSync(
      join(hub, 'shared/.claude/hooks/shared-check.sh'),
      join(repo, '.claude/hooks/shared-check.sh')
    )
    expect(run(['bash', join(repo, '.claude/hooks/shared-check.sh')]).code).toBe(1)
  })
})

describe('commit-msg', () => {
  function commitMsg(subject: string) {
    const file = join(mkdtempSync(join(tmpdir(), 'closeline-msg-')), 'MSG')
    writeFileSync(file, `${subject}\n`)
    return run(['sh', join(hub, 'shared/.husky/commit-msg'), file]).code
  }

  test.each(['feat(voice): stream partial transcripts', 'fix: retry once', 'Merge branch x'])(
    'accepts %s',
    (subject) => {
      expect(commitMsg(subject)).toBe(0)
    }
  )

  test.each(['Add things', 'feature: new', 'feat(Voice): caps scope'])('rejects %s', (subject) => {
    expect(commitMsg(subject)).toBe(1)
  })
})

describe('pre-commit', () => {
  const hook = join(hub, 'shared/.husky/pre-commit')
  const git = (repo: string, ...args: string[]) => run(['git', '-C', repo, ...args])

  /** A throwaway git repo with a `check` script, a no-op typecheck and the hub's Biome config. */
  function repoWith(check: string) {
    const repo = mkdtempSync(join(tmpdir(), 'closeline-precommit-'))
    const scripts = { typecheck: 'true', check }
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts }))
    cpSync(join(hub, 'biome.json'), join(repo, 'biome.json'))
    // `bunx biome` must find the hub's pinned Biome, as a real repo does through its own install.
    const biomePackage = Bun.resolveSync('@biomejs/biome/package.json', hub)
    symlinkSync(join(dirname(biomePackage), '..', '..'), join(repo, 'node_modules'))
    git(repo, 'init', '-q')
    return repo
  }

  function stage(repo: string, files: Record<string, string>) {
    for (const [name, body] of Object.entries(files)) {
      mkdirSync(dirname(join(repo, name)), { recursive: true })
      writeFileSync(join(repo, name), body)
      git(repo, 'add', '--', name)
    }
  }

  const runHook = (repo: string, env: Record<string, string> = {}) =>
    Bun.spawnSync(['sh', '-e', hook], {
      cwd: repo,
      env: { ...(process.env as Record<string, string>), ...env },
      timeout: 60_000,
    })

  const BAD = 'const unused = 1\n'
  const GOOD = 'export const ok = 1\n'

  test('a staged lint error blocks the commit', () => {
    const repo = repoWith('biome check src')
    stage(repo, { 'src/a.ts': BAD })
    expect(runHook(repo).exitCode).not.toBe(0)
  })

  test('clean staged files pass', () => {
    const repo = repoWith('biome check src')
    stage(repo, { 'src/a.ts': GOOD })
    expect(runHook(repo).exitCode).toBe(0)
  })

  test('a lint error outside the check paths is ignored', () => {
    const repo = repoWith('biome check src')
    stage(repo, { 'src/a.ts': GOOD, 'dist/x.ts': BAD })
    expect(runHook(repo).exitCode).toBe(0)
  })

  test("infra's real check script runs under the pinned Biome", () => {
    const repo = repoWith('biome check --no-errors-on-unmatched .')
    stage(repo, { 'src/a.ts': GOOD })
    const result = runHook(repo)
    expect(result.stderr.toString()).not.toContain('cannot be used multiple times')
    expect(result.exitCode).toBe(0)
  })

  test.each(['src/b c.ts', 'src/é.ts'])('a lint error in %s blocks the commit', (name) => {
    const repo = repoWith('biome check src')
    stage(repo, { [name]: BAD })
    expect(runHook(repo).exitCode).not.toBe(0)
  })

  const tracked = [
    'src/a.ts',
    'scripts/s.ts',
    'bench/b.ts',
    'test/t.ts',
    'drizzle.config.ts',
    'vite.config.ts',
    'other/o.ts',
  ]
  const src = ['src/a.ts', 'scripts/s.ts']
  // The real `check` scripts of the sibling repos, then a script with a flag: [script, flags
  // passed to Biome, staged files it lints].
  const parsed: [string, string[], string[]][] = [
    ['biome check src scripts', [], src],
    ['biome check src scripts drizzle.config.ts', [], [...src, 'drizzle.config.ts']],
    ['biome check src scripts bench', [], [...src, 'bench/b.ts']],
    ['biome check src bench scripts', [], [...src, 'bench/b.ts']],
    ['biome check src scripts test vite.config.ts', [], [...src, 'test/t.ts', 'vite.config.ts']],
    // The hook passes --write and --no-errors-on-unmatched itself, so it must not repeat them.
    ['biome check --no-errors-on-unmatched .', [], tracked],
    ['biome check --write src', [], ['src/a.ts']],
    ['biome check --max-diagnostics=50 src', ['--max-diagnostics=50'], ['src/a.ts']],
  ]

  test.each(parsed)('parses %s', (script, flags, linted) => {
    const repo = repoWith(script)
    const bin = mkdtempSync(join(tmpdir(), 'closeline-bunx-'))
    const log = join(bin, 'args')
    writeFileSync(join(bin, 'bunx'), `#!/bin/sh\nfor a in "$@"; do echo "$a" >> "${log}"; done\n`, {
      mode: 0o755,
    })
    stage(repo, Object.fromEntries(tracked.map((name) => [name, GOOD])))

    const result = runHook(repo, { PATH: `${bin}:${process.env.PATH}` })

    expect(result.exitCode).toBe(0)
    const args = readFileSync(log, 'utf8')
      .split('\n')
      .filter((arg) => arg && arg !== '--')
    expect(args.slice(0, 4)).toEqual(['biome', 'check', '--write', '--no-errors-on-unmatched'])
    const given = args.filter((arg) => arg.startsWith('-'))
    expect(new Set(given).size).toBe(given.length)
    expect(args.slice(4).filter((arg) => arg.startsWith('-'))).toEqual(flags)
    expect(
      args
        .slice(4)
        .filter((arg) => !arg.startsWith('-'))
        .sort()
    ).toEqual([...linted].sort())
  })

  test.each(['biome check --max-diagnostics=50 --max-diagnostics=60 src', 'biome check -- src'])(
    'fails loudly on the check script %s',
    (script) => {
      const repo = repoWith(script)
      stage(repo, { 'src/a.ts': GOOD })

      const result = runHook(repo)

      expect(result.exitCode).not.toBe(0)
      expect(result.stderr.toString()).toContain('check script')
    }
  )

  test.each(['bunx biome check src', 'biome check src && echo x', 'biome check src | cat', 'tsc'])(
    'fails loudly on the check script %s',
    (script) => {
      const repo = repoWith(script)
      stage(repo, { 'src/a.ts': GOOD })

      const result = runHook(repo)

      expect(result.exitCode).not.toBe(0)
      expect(result.stderr.toString()).toContain('check script')
    }
  )
})
