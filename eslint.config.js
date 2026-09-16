// ESLint flat config.
//
// Scope: the TypeScript sources that ship in the server/shared/services
// bundles plus the dependency-free Node scripts and the hand-written browser
// helpers. Legacy single-file assets and vendored upstream bundles are
// ignored (see below) because the repo does not own their formatting.
//
// Severity policy: `error` is reserved for rules that catch real bugs.
// Rules that already have hits across tracked files that this change is not
// allowed to modify are `warn`: they stay visible without blocking the build.
// Prettier owns formatting, so eslint-config-prettier is applied last.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';
import globals from 'globals';

const TS_FILES = ['server/**/*.ts', 'shared/**/*.ts', 'services/**/*.ts'];
const NODE_JS_FILES = ['scripts/**/*.mjs', 'services/**/*.mjs', '*.mjs'];
const BROWSER_JS_FILES = [
  'services/sim2real-web/public/*.js',
  'services/mujoco-web/microduck-community-overlay.js',
];

// Dev-only scaffolding (unit tests and verify scripts) that is not shipped;
// dead imports there are reported but do not gate the build.
const DEV_TEST_TS_FILES = ['**/*.test.ts'];
const DEV_SCRIPT_JS_FILES = ['**/*.test.mjs', '**/*.spec.mjs', 'scripts/**/*.mjs'];

// Files that deliberately match C0/C1 control characters in order to strip
// them out of untrusted process/agent output before it is logged, echoed or
// persisted. `no-control-regex` exists to catch *accidental* control characters
// in a pattern, so it is turned off only for these reviewed sanitizers — every
// other file still gets the rule.
const CONTROL_CHAR_SANITIZER_FILES = [
  'server/routes/sim2real-agent-routes.ts',
  'server/routes/sim2real-audit-routes.ts',
  'server/routes/sim2real-routes.ts',
  'server/routes/sim2real-telemetry-routes.ts',
  'server/sim2real/observability.ts',
  'server/sim2real/rate-limit.ts',
  'server/sim2real/robogo-runner.ts',
  'server/sim2real/audit-log.ts',
  'server/sim2real/sim2real-store.ts',
  'server/sim2real/standalone-adapters.ts',
  'server/sim2real/board-station-proxy.ts',
  'server/sim2real/studio-cookie-auth.ts',
  'server/sim2real/studio-login-relay.ts',
  'server/sim2real/telemetry-attestation.ts',
  'server/sim2real/trusted-proxy-auth.ts',
  'services/sim2real-web/local-training-worker.mjs',
  'services/sim2real-web/mock-local-worker.mjs',
  'services/sim2real-web/server.ts',
  'scripts/verify-production-config.mjs',
  'shared/sim2real.ts',
  'shared/task-evaluation.ts',
];

// Rules that catch genuine mistakes; each is verified to have zero violations
// before being kept at `error`.
const correctnessRules = {
  'no-dupe-keys': 'error',
  'no-dupe-else-if': 'error',
  'no-duplicate-case': 'error',
  'no-unreachable': 'error',
  'no-constant-condition': ['error', { checkLoops: false }],
  'no-constant-binary-expression': 'error',
  eqeqeq: ['error', 'smart'],
  'no-self-assign': 'error',
  'no-self-compare': 'error',
  'no-unsafe-negation': 'error',
  'no-unsafe-optional-chaining': 'error',
  'no-async-promise-executor': 'error',
  'no-fallthrough': 'error',
  'no-compare-neg-zero': 'error',
  'no-cond-assign': ['error', 'except-parens'],
  'no-debugger': 'error',
  'no-sparse-arrays': 'error',
  'use-isnan': 'error',
  'valid-typeof': 'error',
  // Added to `@eslint/js` recommended in v10. Every hit is either a dead
  // initialiser (`let x = null` followed by an assignment in both the try and
  // catch arms) or a reassignment whose value is never read again, so a hit is
  // always a real defect rather than a style opinion. Held at `error` because
  // the pre-existing violations this rule surfaced when the bump landed were
  // resolved rather than silenced - see the note in warningRules.
  'no-useless-assignment': 'error',
};

// Style/noise rules that already fire widely; reported but never blocking.
const warningRules = {
  'no-empty': 'warn',
  'no-prototype-builtins': 'warn',
  'no-useless-escape': 'warn',
  'no-regex-spaces': 'warn',
  'prefer-const': 'warn',
  'no-console': 'off',
  // The repo deliberately matches control characters while sanitizing
  // untrusted terminal/worker output, so this stays advisory.
  'no-control-regex': 'warn',
};

const unusedVarsOptions = {
  args: 'after-used',
  argsIgnorePattern: '^_',
  varsIgnorePattern: '^_',
  caughtErrors: 'none',
  ignoreRestSiblings: true,
};

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'dist-server/**',
      'coverage/**',
      '.data/**',
      'docs/**',
      // Hand-written legacy monoliths; ESLint and Prettier are not applied.
      'services/sim2real-web/public/app.js',
      'services/sim2real-web/public/styles.css',
      'services/sim2real-web/public/index.html',
      // Vendored upstream build output.
      'services/mujoco-web/static/**',
    ],
  },
  {
    files: TS_FILES,
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: globals.node,
    },
    rules: {
      ...correctnessRules,
      ...warningRules,
      // `no-undef` is intentionally off for TypeScript: the compiler resolves
      // identifiers and the rule produces false positives on type-only names.
      'no-undef': 'off',
      '@typescript-eslint/no-unused-vars': ['error', unusedVarsOptions],
      // Widely violated, so reported as warnings rather than gating the build.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-require-imports': 'warn',
      '@typescript-eslint/no-namespace': 'warn',
      '@typescript-eslint/no-empty-object-type': 'warn',
      '@typescript-eslint/ban-ts-comment': 'warn',
      '@typescript-eslint/no-wrapper-object-types': 'warn',
      '@typescript-eslint/no-unsafe-function-type': 'warn',
    },
  },
  {
    files: NODE_JS_FILES,
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: globals.node,
    },
    rules: {
      ...correctnessRules,
      ...warningRules,
      'no-unused-vars': ['error', unusedVarsOptions],
    },
  },
  {
    files: BROWSER_JS_FILES,
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        // app.js defines `setView` as a classic-script global that
        // onboarding.js calls, and telemetry-core.js probes the CommonJS
        // `module` binding inside its UMD wrapper. agent-chat.js reuses
        // app.js's canonical `request`/`ApiError` contract the same way.
        setView: 'readonly',
        module: 'readonly',
        request: 'readonly',
        ApiError: 'readonly',
      },
    },
    rules: {
      ...correctnessRules,
      ...warningRules,
      'no-unused-vars': ['error', unusedVarsOptions],
    },
  },
  {
    files: DEV_TEST_TS_FILES,
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      '@typescript-eslint/no-unused-vars': 'warn',
      // Test scaffolding builds partial mocks and fixture payloads whose exact
      // shape is irrelevant to the assertion; typing them adds noise without
      // catching anything the test itself would not already fail on.
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    files: DEV_SCRIPT_JS_FILES,
    rules: {
      'no-unused-vars': 'warn',
    },
  },
  {
    files: CONTROL_CHAR_SANITIZER_FILES,
    rules: {
      'no-control-regex': 'off',
    },
  },
  eslintConfigPrettier,
);
