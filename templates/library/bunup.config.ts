import { defineConfig } from 'bunup'

export default defineConfig({
  // One entry per subpath in package.json `exports`.
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: { inferTypes: true },
  // Dependencies stay imports; nothing is bundled into dist/.
  packages: 'external',
})
