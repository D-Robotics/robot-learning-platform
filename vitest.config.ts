import { coverageConfigDefaults, defineConfig } from 'vitest/config';

// The repository keeps dependency-free assertion scripts as `.spec.mjs` so
// they can run with plain Node. Vitest owns the TypeScript unit tests; the
// public `verify` script runs both sets.
export default defineConfig({
  test: {
    include: ['server/**/*.test.ts', 'shared/**/*.test.ts', 'services/**/*.test.ts'],
    exclude: ['node_modules/**'],
    // A number of ledger and health suites intentionally exercise process-wide
    // environment switches. Running files in parallel lets one suite restore
    // another suite's temporary storage path; serial files keep those tests
    // deterministic while individual tests remain concurrent where safe.
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      // Coverage is reported over the TypeScript sources the vitest suites
      // exercise. Build output, the legacy browser monolith and the Node
      // verify scripts are out of scope; including them would drown the
      // signal (services/sim2real-web/public/app.js alone is 5k+ lines that
      // no unit test loads).
      include: ['server/**/*.ts', 'shared/**/*.ts', 'services/**/*.ts'],
      exclude: [...coverageConfigDefaults.exclude, '**/*.test.ts', '**/*.spec.ts'],
      // Vitest 5's V8 remapper counts function boundaries more precisely than
      // the Vitest 4 configuration this file was calibrated under. Re-measured
      // under the current toolchain: lines 76.55%, statements 72.89%, functions
      // 78.19%, branches 66.47%. Keep a small buffer below each measured value
      // so ordinary refactors do not fail on noise while genuinely untested
      // paths remain visible. These thresholds only run when coverage is enabled
      // (`npm run test:coverage`), not for `npm test`.
      thresholds: {
        lines: 71,
        statements: 68,
        functions: 74,
        branches: 61,
      },
    },
  },
});
