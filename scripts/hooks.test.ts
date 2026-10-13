import { describe, expect, test } from 'bun:test'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
