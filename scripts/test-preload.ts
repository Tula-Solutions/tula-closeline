// Runs before every test file (`[test] preload` in bunfig.toml). The dev stack keeps its start lock
// at `<TMPDIR>/closeline-dev-stack.lock`, and `scripts/dev.ts --down` stops whoever holds it. Giving
// the whole test run a fresh TMPDIR means no test, and no child a test starts, can read, write or
// signal through the lock of a real stack running at the same time.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(realpathSync(tmpdir()), 'closeline-test-'))
process.env.TMPDIR = dir
process.env.CLOSELINE_TEST_TMPDIR = dir
process.on('exit', () => rmSync(dir, { recursive: true, force: true }))
