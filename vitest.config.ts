import { coverageConfigDefaults, defineConfig } from 'vitest/config';

// The repository keeps dependency-free assertion scripts as `.spec.mjs` so
// they can run with plain Node. Vitest owns the TypeScript unit tests; the
// public `verify` script runs both sets.
export default defineConfig({
  test: {
    include: ['server/**/*.test.ts', 'shared/**/*.test.ts', 'services/**/*.test.ts'],
    exclude: ['node_modules/**'],
    coverage: {
      provider: 'v8',
      // Coverage is reported over the TypeScript sources the vitest suites
      // exercise. Build output, the legacy browser monolith and the Node
      // verify scripts are out of scope; including them would drown the
      // signal (services/sim2real-web/public/app.js alone is 5k+ lines that
      // no unit test loads).
      include: ['server/**/*.ts', 'shared/**/*.ts', 'services/**/*.ts'],
      exclude: [...coverageConfigDefaults.exclude, '**/*.test.ts', '**/*.spec.ts'],
      // Thresholds sit ~3 points below the measured baseline (lines 69.17%,
      // statements 69.17%, functions 82.82%, branches 64.56%) so in-flight
      // refactors do not fail the gate on noise. They only run when coverage
      // is enabled (`npm run test:coverage`), not for `npm test`.
      thresholds: {
        lines: 66,
        statements: 66,
        functions: 79,
        branches: 61,
      },
    },
  },
});
