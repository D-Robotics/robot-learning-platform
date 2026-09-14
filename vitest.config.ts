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
      // Vitest 4's V8 remapper counts function boundaries more precisely than
      // the previous Vitest 3 release. The current baseline is lines 73.40%,
      // statements 69.94%, functions 75.56%, and branches 63.83%; keep a
      // small buffer below each measured value so ordinary refactors do not
      // fail on noise while genuinely untested paths remain visible. These
      // thresholds only run when coverage is enabled (`npm run test:coverage`),
      // not for `npm test`.
      thresholds: {
        lines: 71,
        statements: 68,
        functions: 74,
        branches: 61,
      },
    },
  },
});
