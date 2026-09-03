import { defineConfig } from 'vitest/config';

// The repository keeps dependency-free assertion scripts as `.spec.mjs` so
// they can run with plain Node. Vitest owns the TypeScript unit tests; the
// public `verify` script runs both sets.
export default defineConfig({
  test: {
    include: ['server/**/*.test.ts', 'shared/**/*.test.ts'],
    exclude: ['node_modules/**'],
  },
});
