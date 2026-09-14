#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  parseDotenv,
  parseSystemdEnvironment,
  parseSystemdEnvironmentFiles,
  parseSystemdWritablePaths,
  mergeSystemdConfiguration,
  validateProductionConfig,
} from './verify-production-config.mjs';

const parsed = parseDotenv('A=1\nQUOTED="hello world"\nexport EMPTY=\n');
assert.deepEqual(parsed.errors, []);
assert.equal(parsed.values.A, '1');
assert.equal(parsed.values.QUOTED, 'hello world');
assert.equal(parsed.values.EMPTY, '');
assert.equal(parseDotenv('A=1\nA=2').errors.length, 1);
assert.equal(parseDotenv('broken line').errors.length, 1);

const unit = parseSystemdEnvironment(
  '[Service]\nEnvironment=RDK_SIM2REAL_DEPLOYMENT=web-cloud\nEnvironment="EXPRESS_TRUST_PROXY=1"\n',
);
assert.deepEqual(unit.errors, []);
assert.equal(unit.values.RDK_SIM2REAL_DEPLOYMENT, 'web-cloud');
assert.equal(unit.values.EXPRESS_TRUST_PROXY, '1');
const writable = parseSystemdWritablePaths(
  '[Service]\nReadWritePaths=/var/lib/rdk/sim2real /var/log/rdk-sim2real\nReadWritePaths=-/var/lib/sim2real/dsh\n',
);
assert.deepEqual(writable.errors, []);
assert.deepEqual(writable.paths, [
  '/var/lib/rdk/sim2real',
  '/var/log/rdk-sim2real',
  '/var/lib/sim2real/dsh',
]);
const environmentFiles = parseSystemdEnvironmentFiles(
  '[Service]\nEnvironmentFile=/etc/sim2real.env\nEnvironmentFile=-/etc/optional.env\n',
);
assert.deepEqual(environmentFiles.errors, []);
assert.deepEqual(environmentFiles.files, [
  { path: '/etc/sim2real.env', optional: false },
  { path: '/etc/optional.env', optional: true },
]);
assert.deepEqual(
  mergeSystemdConfiguration(
    { RDK_SIM2REAL_CSP_DISABLE: '1', EXPRESS_TRUST_PROXY: '0' },
    { RDK_SIM2REAL_CSP_DISABLE: '0', EXPRESS_TRUST_PROXY: '1' },
  ),
  { RDK_SIM2REAL_CSP_DISABLE: '1', EXPRESS_TRUST_PROXY: '0' },
);

const validValues = {
  NODE_ENV: 'production',
  RDK_SIM2REAL_DEPLOYMENT: 'web-cloud',
  RDK_SIM2REAL_SSO_REQUIRED: '1',
  RDK_SIM2REAL_AUTH_MODE: 'trusted-proxy',
  RDK_SIM2REAL_TRUSTED_PROXY_SECRET: '01234567890123456789012345678901',
  RDK_SIM2REAL_TELEMETRY_ATTESTATION_SECRET: 'telemetry-attestation-secret-012345678901234',
  RDK_SIM2REAL_ALLOWED_ORIGINS: 'https://rdkstudio.example',
  RDK_SIM2REAL_BIND_HOST: '127.0.0.1',
  RDK_SIM2REAL_STORAGE_DIR: '/var/lib/rdk/sim2real',
  RDK_SIM2REAL_PUBLIC_BASE_PATH: '/sim2real',
  EXPRESS_TRUST_PROXY: '1',
  RDK_SIM2REAL_RATE_LIMIT_PER_MINUTE: '1200',
  RDK_SIM2REAL_LOG_LEVEL: 'info',
  RDK_SIM2REAL_CSP_DISABLE: '0',
  RDK_SIM2REAL_ENABLE_HSTS: '1',
  RDK_SIM2REAL_STORAGE_LEASE: '1',
  RDK_SIM2REAL_STORAGE_READ_ONLY: '0',
  RDK_SIM2REAL_MAX_ACTIVE_RUNS: '4',
  RDK_SIM2REAL_ACTIVE_RUN_TTL_SECONDS: '86400',
  RDK_SIM2REAL_COMPUTE_HEALTH_TTL_SECONDS: '600',
  RDK_SIM2REAL_STORAGE_LEASE_STALE_SECONDS: '300',
  RDK_SIM2REAL_TELEMETRY_RETENTION_DAYS: '30',
  RDK_SIM2REAL_AUDIT_FILE: '/var/log/rdk-sim2real/audit.ndjson',
  RDK_SIM2REAL_AUDIT_MAX_BYTES: '67108864',
};
const valid = await validateProductionConfig({
  mode: 'runtime',
  fileMode: 0o600,
  values: validValues,
});
assert.equal(valid.ok, true);

const validWithSystemdPaths = await validateProductionConfig({
  mode: 'runtime',
  fileMode: 0o600,
  unitFile: '/etc/standalone-sim2real.service',
  unitWritablePaths: ['/var/lib/rdk/sim2real', '/var/log/rdk-sim2real', '/var/lib/sim2real/dsh'],
  values: {
    ...validValues,
    RDK_SIM2REAL_DSH_RUNTIME: '1',
    RDK_SIM2REAL_DSH_HOME: '/var/lib/sim2real/dsh',
  },
});
assert.equal(validWithSystemdPaths.ok, true);

const pathDrift = await validateProductionConfig({
  mode: 'runtime',
  fileMode: 0o600,
  unitFile: '/etc/standalone-sim2real.service',
  unitWritablePaths: ['/var/lib/rdk/sim2real', '/var/log/rdk-sim2real'],
  values: {
    ...validValues,
    RDK_SIM2REAL_AUDIT_FILE: '/srv/audit.ndjson',
    RDK_SIM2REAL_DSH_RUNTIME: '1',
    RDK_SIM2REAL_DSH_HOME: '/srv/dsh',
  },
});
assert.equal(pathDrift.ok, false);
assert.equal(
  pathDrift.checks.find((item) => item.id === 'audit-file-unit-writable')?.status,
  'fail',
);
assert.equal(pathDrift.checks.find((item) => item.id === 'dsh-home-unit-writable')?.status, 'fail');

const missingInternalBearer = await validateProductionConfig({
  mode: 'runtime',
  fileMode: 0o600,
  values: {
    ...validValues,
    RDK_SIM2REAL_BOARD_AGENT_URL: 'https://board-agent.example.internal',
  },
});
assert.equal(missingInternalBearer.ok, false);
assert.equal(
  missingInternalBearer.checks.find((item) => item.id === 'rdk_sim2real_board_agent_token')?.status,
  'fail',
);

const configuredInternalBearer = await validateProductionConfig({
  mode: 'runtime',
  fileMode: 0o600,
  values: {
    ...validValues,
    RDK_SIM2REAL_BOARD_AGENT_URL: 'https://board-agent.example.internal',
    RDK_SIM2REAL_BOARD_AGENT_TOKEN: 'board-agent-production-random-secret-0123456789',
  },
});
assert.equal(configuredInternalBearer.ok, true);

const aliasValid = await validateProductionConfig({
  mode: 'runtime',
  fileMode: 0o600,
  values: {
    NODE_ENV: 'production',
    RDK_SIM2REAL_DEPLOYMENT: 'web-cloud',
    RDK_SIM2REAL_SSO_REQUIRED: '1',
    RDK_SIM2REAL_AUTH_MODE: 'trusted-proxy',
    RDK_SIM2REAL_TRUSTED_PROXY_SECRET: '01234567890123456789012345678901',
    RDK_SIM2REAL_TELEMETRY_ATTESTATION_SECRET: 'replace-with-at-least-32-random-bytes',
    RDK_SIM2REAL_TELEMETRY_TOKEN_SECRET: 'legacy-telemetry-production-secret-0123456789',
    RDK_SIM2REAL_ALLOWED_ORIGINS: 'https://rdkstudio.example',
    RDK_SIM2REAL_BIND_HOST: '127.0.0.1',
    RDK_SIM2REAL_STORAGE_DIR: '/var/lib/rdk/sim2real',
    RDK_SIM2REAL_PUBLIC_BASE_PATH: '/sim2real',
    EXPRESS_TRUST_PROXY: '1',
    RDK_SIM2REAL_RATE_LIMIT_PER_MINUTE: '1200',
    RDK_SIM2REAL_LOG_LEVEL: 'info',
    RDK_SIM2REAL_CSP_DISABLE: '0',
    RDK_SIM2REAL_ENABLE_HSTS: '1',
    RDK_SIM2REAL_STORAGE_LEASE: '1',
    RDK_SIM2REAL_STORAGE_READ_ONLY: '0',
    RDK_SIM2REAL_MAX_ACTIVE_RUNS: '4',
    RDK_SIM2REAL_ACTIVE_RUN_TTL_SECONDS: '86400',
    RDK_SIM2REAL_COMPUTE_HEALTH_TTL_SECONDS: '600',
    RDK_SIM2REAL_STORAGE_LEASE_STALE_SECONDS: '300',
    RDK_SIM2REAL_TELEMETRY_RETENTION_DAYS: '30',
  },
});
assert.equal(aliasValid.ok, true);

const placeholder = await validateProductionConfig({
  mode: 'runtime',
  fileMode: 0o600,
  values: {
    NODE_ENV: 'production',
    RDK_SIM2REAL_DEPLOYMENT: 'web-cloud',
    RDK_SIM2REAL_SSO_REQUIRED: '1',
    RDK_SIM2REAL_AUTH_MODE: 'trusted-proxy',
    RDK_SIM2REAL_TRUSTED_PROXY_SECRET: '01234567890123456789012345678901',
    RDK_SIM2REAL_TELEMETRY_ATTESTATION_SECRET: 'replace-with-at-least-32-random-bytes',
    RDK_SIM2REAL_ALLOWED_ORIGINS: 'https://rdkstudio.example',
    RDK_SIM2REAL_BIND_HOST: '127.0.0.1',
    RDK_SIM2REAL_STORAGE_DIR: '/var/lib/rdk/sim2real',
    RDK_SIM2REAL_PUBLIC_BASE_PATH: '/sim2real',
    EXPRESS_TRUST_PROXY: '1',
    RDK_SIM2REAL_RATE_LIMIT_PER_MINUTE: '1200',
    RDK_SIM2REAL_LOG_LEVEL: 'info',
    RDK_SIM2REAL_CSP_DISABLE: '0',
    RDK_SIM2REAL_ENABLE_HSTS: '1',
    RDK_SIM2REAL_STORAGE_LEASE: '1',
    RDK_SIM2REAL_STORAGE_READ_ONLY: '0',
    RDK_SIM2REAL_MAX_ACTIVE_RUNS: '4',
    RDK_SIM2REAL_ACTIVE_RUN_TTL_SECONDS: '86400',
    RDK_SIM2REAL_COMPUTE_HEALTH_TTL_SECONDS: '600',
    RDK_SIM2REAL_STORAGE_LEASE_STALE_SECONDS: '300',
    RDK_SIM2REAL_TELEMETRY_RETENTION_DAYS: '30',
  },
});
assert.equal(placeholder.ok, false);
assert.equal(
  placeholder.checks.find((item) => item.id === 'telemetry-attestation-secret')?.status,
  'fail',
);

const invalid = await validateProductionConfig({
  mode: 'runtime',
  fileMode: 0o644,
  values: {
    NODE_ENV: 'development',
    RDK_SIM2REAL_DEPLOYMENT: 'local',
    RDK_SIM2REAL_AUTH_MODE: 'trusted-proxy',
    RDK_SIM2REAL_TRUSTED_PROXY_SECRET: 'short',
    RDK_SIM2REAL_STORAGE_DIR: '.data',
    EXPRESS_TRUST_PROXY: '0',
    RDK_SIM2REAL_RATE_LIMIT_PER_MINUTE: '0',
    RDK_SIM2REAL_LOG_LEVEL: 'verbose',
    RDK_SIM2REAL_CSP_DISABLE: '1',
    RDK_SIM2REAL_STORAGE_LEASE: '0',
    RDK_SIM2REAL_STORAGE_READ_ONLY: '0',
    RDK_SIM2REAL_AUDIT_FILE: '.data/audit.ndjson',
    RDK_SIM2REAL_AUDIT_MAX_BYTES: '12',
  },
});
assert.equal(invalid.ok, false);
assert.ok(invalid.summary.failures >= 5);

console.log('[production-config] PASS — dotenv/systemd parsing and runtime safety gates verified');
