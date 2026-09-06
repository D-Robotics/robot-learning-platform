#!/usr/bin/env node

/**
 * Deterministic checks for the files that turn a build into a service.
 * This runs on macOS too; an optional systemd-analyze pass can be enabled in
 * Linux CI with VERIFY_SYSTEMD=1.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(relativePath) {
  return readFileSync(path.join(root, relativePath), 'utf8');
}

const packageManifest = JSON.parse(read('package.json'));
assert.equal(
  typeof packageManifest.scripts?.['smoke:sim2real-local'],
  'string',
  'package.json must expose the local Sim2Real smoke command',
);
assert.match(
  String(packageManifest.scripts?.verify || ''),
  /smoke:sim2real-local/,
  'npm run verify must include the local Sim2Real smoke command',
);

const openapi = read('docs/api/openapi.yaml');
assert.match(openapi, /^openapi:\s*3\.1\.0/m, 'OpenAPI contract must declare 3.1.0');
const components = openapi.match(/^components:\n([\s\S]*)$/m)?.[1] || '';
function componentNames(kind) {
  const marker = `  ${kind}:\n`;
  const start = components.indexOf(marker);
  if (start < 0) return new Set();
  const bodyStart = start + marker.length;
  const remainder = components.slice(bodyStart);
  const next = remainder.search(/^  [A-Za-z][A-Za-z0-9_-]*:\n/m);
  const section = next < 0 ? remainder : remainder.slice(0, next);
  return new Set(
    [...section.matchAll(/^    ([A-Za-z][A-Za-z0-9_-]*):\s*$/gm)].map((match) => match[1]),
  );
}
const declaredSchemas = componentNames('schemas');
for (const reference of openapi.matchAll(/#\/components\/schemas\/([A-Za-z][A-Za-z0-9_-]*)/g)) {
  assert.ok(
    declaredSchemas.has(reference[1]),
    `OpenAPI schema reference is not declared: ${reference[1]}`,
  );
}
const declaredParameters = componentNames('parameters');
for (const reference of openapi.matchAll(/#\/components\/parameters\/([A-Za-z][A-Za-z0-9_-]*)/g)) {
  assert.ok(
    declaredParameters.has(reference[1]),
    `OpenAPI parameter reference is not declared: ${reference[1]}`,
  );
}
const declaredResponses = componentNames('responses');
for (const reference of openapi.matchAll(/#\/components\/responses\/([A-Za-z][A-Za-z0-9_-]*)/g)) {
  assert.ok(
    declaredResponses.has(reference[1]),
    `OpenAPI response reference is not declared: ${reference[1]}`,
  );
}
for (const route of [
  '/api/v1/duck/overview:',
  '/api/v1/duck/models:',
  '/api/v1/duck/runs:',
  '/api/v1/duck/runs/{runId}/telemetry:',
  '/api/v1/duck/deployments:',
  '/api/devices/{deviceId}/board/detect:',
]) {
  assert.match(openapi, new RegExp(`^  ${route.replace(/[{}]/g, '\\$&')}$`, 'm'), `OpenAPI is missing ${route}`);
}

function section(text, name) {
  const match = text.match(new RegExp(`(?:^|\\n)\\[${name}\\]\\n([\\s\\S]*?)(?=\\n\\[|$)`));
  return match?.[1] ?? '';
}

function assertUnit(relativePath, { requiredUnit, requiredService }) {
  const text = read(relativePath);
  const unit = section(text, 'Unit');
  const service = section(text, 'Service');
  assert.ok(unit, `${relativePath} must contain [Unit]`);
  assert.ok(service, `${relativePath} must contain [Service]`);
  for (const value of requiredUnit) assert.match(unit, value, `${relativePath} [Unit]`);
  for (const value of requiredService) assert.match(service, value, `${relativePath} [Service]`);
  assert.doesNotMatch(service, /ConditionPathExists=/, `${relativePath}: conditions belong in [Unit]`);
  assert.doesNotMatch(text, /RDK_SIM2REAL_(?:ROBOGO_)?TOKEN=\S+/, `${relativePath}: no token in unit`);
}

assertUnit('services/sim2real-web/standalone-sim2real.service', {
  requiredUnit: [
    /ConditionPathExists=.*dist-server\/services\/sim2real-web\/server\.js/,
  ],
  requiredService: [
    /User=sim2real/,
    /Environment=RDK_SIM2REAL_SSO_REQUIRED=1/,
    /Environment=RDK_SIM2REAL_AUTH_MODE=trusted-proxy/,
    /ExecStartPre=\/bin\/sh -c 'test -n "\$\$\{RDK_SIM2REAL_TRUSTED_PROXY_SECRET\}"'/,
    /ExecStartPre=.*Buffer\.byteLength\(process\.env\.RDK_SIM2REAL_TRUSTED_PROXY_SECRET/,
    /ExecStartPre=.*env node --version/,
    /ExecStart=.*dist-server\/services\/sim2real-web\/server\.js/,
    /ReadWritePaths=\/var\/lib\/rdk-robot-learning-platform\/sim2real/,
  ],
});

assertUnit('services/sim2real-web/sim2real-mock-worker.service', {
  requiredUnit: [
    /ConditionPathExists=.*dist-server\/services\/sim2real-web\/mock-local-worker\.mjs/,
  ],
  requiredService: [
    /User=sim2real/,
    /ExecStartPre=.*env node --version/,
    /ExecStart=.*dist-server\/services\/sim2real-web\/mock-local-worker\.mjs/,
    /ReadWritePaths=\/var\/lib\/rdk-robot-learning-platform\/mock-worker/,
  ],
});

assertUnit('services/sim2real-web/sim2real-local-worker.service', {
  requiredUnit: [
    /ConditionPathExists=.*dist-server\/services\/sim2real-web\/local-training-worker\.mjs/,
  ],
  requiredService: [
    /User=sim2real/,
    /Environment=RDK_SIM2REAL_LOCAL_WORKER_HOST=127\.0\.0\.1/,
    /ExecStartPre=.*RDK_SIM2REAL_LOCAL_WORKER_DATA_DIR/,
    /ExecStart=.*dist-server\/services\/sim2real-web\/local-training-worker\.mjs/,
    /ReadWritePaths=\/var\/lib\/rdk-robot-learning-platform\/local-worker/,
    /UMask=0077/,
    /Environment=RDK_SIM2REAL_MAX_CONCURRENT_JOBS=1/,
  ],
});

const integratedUnit = read('services/sim2real-web/studio-integrated-sim2real.service');
assert.match(integratedUnit, /ConditionPathExists=\/etc\/rdkstudio-sim2real-adapter\.ready/);
assert.match(integratedUnit, /ExecStartPre=.*RDK_SIM2REAL_ADAPTER_READY=1/);
assert.match(integratedUnit, /Environment=RDK_SIM2REAL_AUTH_MODE=trusted-proxy/);
assert.match(integratedUnit, /ExecStartPre=\/bin\/sh -c 'test -n "\$\$\{RDK_SIM2REAL_TRUSTED_PROXY_SECRET\}"'/);
assert.match(integratedUnit, /ExecStartPre=.*Buffer\.byteLength\(process\.env\.RDK_SIM2REAL_TRUSTED_PROXY_SECRET/);
assert.match(integratedUnit, /ConditionPathExists=.*dist-server\/services\/sim2real-web\/server\.js/);
assert.doesNotMatch(integratedUnit, /ReadOnlyPaths=\/opt\/rdstudio-web-opt/);

const copyScript = read('scripts/copy-server-assets.mjs');
assert.match(copyScript, /mock-local-worker\.mjs/, 'build:assets must ship the mock worker');
assert.match(copyScript, /local-training-worker\.mjs/, 'build:assets must ship the local worker bridge');
assert.match(copyScript, /local-board-agent\.mjs/, 'build:assets must ship the BoardAgent reference');
assert.ok(existsSync(path.join(root, 'services/sim2real-web/public/microduck-unavailable.html')));

const productionEnv = read('services/sim2real-web/sim2real.production.env.example');
const activeProductionEnv = productionEnv
  .split(/\r?\n/)
  .filter((line) => !line.trim().startsWith('#'))
  .join('\n');
assert.doesNotMatch(activeProductionEnv, /RDK_SIM2REAL_DEPLOYMENT=local/);
assert.doesNotMatch(activeProductionEnv, /RDK_SIM2REAL_STORAGE_DIR=\.data/);
assert.match(productionEnv, /RDK_SIM2REAL_TRUSTED_PROXY_SECRET=/);

const sim2realNginx = read('services/sim2real-web/install-nginx-route.py');
assert.match(sim2realNginx, /location = \/sim2real/);
assert.match(sim2realNginx, /proxy_pass http:\/\/127\.0\.0\.1:18102\//);
assert.match(sim2realNginx, /target_server_block/);
assert.match(sim2realNginx, /does not match the managed block/);
const microduckNginx = read('services/mujoco-web/install-microduck-nginx-route.py');
assert.match(microduckNginx, /location \/mujoco\/microduck\//);
assert.match(microduckNginx, /proxy_pass http:\/\/127\.0\.0\.1:18101\//);
assert.match(microduckNginx, /target_server_block/);
assert.match(read('services/mujoco-web/microduck-web.service'), /ExecStart=\/usr\/bin\/python3 -m http\.server 18101 --bind 127\.0\.0\.1/);
assert.match(read('services/mujoco-web/microduck-web.service'), /ConditionPathExists=\/usr\/bin\/python3/);
assert.match(read('services/mujoco-web/microduck-web.service'), /ConditionPathExists=.*microduck-web\/current\/index\.html/);
assert.match(read('services/mujoco-web/mujoco-web.service'), /ConditionPathExists=.*mujoco-web\/current\/app\.py/);
assert.match(read('services/mujoco-web/mujoco-web.service'), /127\.0\.0\.1 --port 18100/);
const mujocoNginx = read('services/mujoco-web/install-nginx-route.py');
assert.match(mujocoNginx, /location \/mujoco\//);
assert.match(mujocoNginx, /proxy_pass http:\/\/127\.0\.0\.1:18100\//);

// Compile Python sources without creating __pycache__ files. This catches a
// broken provisioning script before an operator copies it to a production
// host, while keeping the verifier deterministic on read-only checkouts.
const pythonFiles = [
  'services/mujoco-web/app.py',
  'services/mujoco-web/models.py',
  'services/mujoco-web/install-microduck-overlay.py',
  'services/mujoco-web/install-microduck-nginx-route.py',
  'services/mujoco-web/install-nginx-route.py',
  'services/sim2real-web/install-nginx-route.py',
];
const pythonProbe = spawnSync(
  'python3',
  [
    '-c',
    "import pathlib,sys; [compile(pathlib.Path(p).read_text(encoding='utf-8'), p, 'exec') for p in sys.argv[1:]]",
    ...pythonFiles.map((file) => path.join(root, file)),
  ],
  { encoding: 'utf8' },
);
if (pythonProbe.status !== 0) {
  process.stderr.write(pythonProbe.stderr || pythonProbe.stdout || 'python syntax check failed\n');
  process.exit(pythonProbe.status || 1);
}

if (process.env.VERIFY_SYSTEMD === '1') {
  const probe = spawnSync('systemd-analyze', ['--version'], { encoding: 'utf8' });
  if (probe.status !== 0) throw new Error('VERIFY_SYSTEMD=1 requires systemd-analyze');
  for (const relativePath of [
    'services/sim2real-web/standalone-sim2real.service',
    'services/sim2real-web/sim2real-mock-worker.service',
    'services/sim2real-web/sim2real-local-worker.service',
  ]) {
    const result = spawnSync('systemd-analyze', ['verify', path.join(root, relativePath)], {
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      process.stderr.write(result.stderr || result.stdout || `${relativePath} failed\n`);
      process.exit(result.status || 1);
    }
  }
}

console.log('[deployment-assets] PASS — service units, release guards, and static fallback are wired');
