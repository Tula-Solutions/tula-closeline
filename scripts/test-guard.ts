// Imported (for its effect) by every test file. The tests may run the real `--down` flow, which stops
// whoever holds the machine-wide dev lock, so a run without the TMPDIR preload (bunfig.toml is read
// only from the hub root) must not run a single test.
import { tmpdir } from 'node:os'

if (!process.env.CLOSELINE_TEST_TMPDIR || tmpdir() !== process.env.CLOSELINE_TEST_TMPDIR) {
  throw new Error(
    'run the scripts tests from the hub root (bun test scripts): the TMPDIR preload is missing'
  )
}
