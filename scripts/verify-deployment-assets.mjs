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
for (const scriptName of [
  'verify:production-config',
  'verify:production-config-test',
  'verify:storage-backup',
  'verify:service-probe',
  'verify:board-uploader',
  'verify:security',
  'probe:sim2real',
  'backup:sim2real',
]) {
  assert.equal(
    typeof packageManifest.scripts?.[scriptName],
    'string',
    `package.json must expose ${scriptName}`,
  );
}
assert.match(
  String(packageManifest.scripts?.verify || ''),
  /verify:security.*verify:production-config.*verify:storage-backup.*verify:service-probe.*verify:board-uploader/,
  'npm run verify must include security, production configuration, storage backup, service probe, and board uploader gates',
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
  const next = remainder.search(/^ {2}[A-Za-z][A-Za-z0-9_-]*:\n/m);
  const section = next < 0 ? remainder : remainder.slice(0, next);
  return new Set(
    [...section.matchAll(/^ {4}([A-Za-z][A-Za-z0-9_-]*):\s*$/gm)].map((match) => match[1]),
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
  assert.match(
    openapi,
    new RegExp(`^  ${route.replace(/[{}]/g, '\\$&')}$`, 'm'),
    `OpenAPI is missing ${route}`,
  );
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
  assert.doesNotMatch(
    service,
    /ConditionPathExists=/,
    `${relativePath}: conditions belong in [Unit]`,
  );
  assert.doesNotMatch(
    text,
    /RDK_SIM2REAL_(?:ROBOGO_)?TOKEN=\S+/,
    `${relativePath}: no token in unit`,
  );
}

assertUnit('services/sim2real-web/standalone-sim2real.service', {
  requiredUnit: [/ConditionPathExists=.*dist-server\/services\/sim2real-web\/server\.js/],
  requiredService: [
    /User=sim2real/,
    /Environment=RDK_SIM2REAL_SSO_REQUIRED=1/,
    /Environment=RDK_SIM2REAL_AUTH_MODE=trusted-proxy/,
    /ExecStartPre=\/bin\/sh -c 'test -n "\$\$\{RDK_SIM2REAL_TRUSTED_PROXY_SECRET\}"'/,
    /ExecStartPre=.*Buffer\.byteLength\(process\.env\.RDK_SIM2REAL_TRUSTED_PROXY_SECRET/,
    /ExecStartPre=.*env node --version/,
    /ExecStart=.*dist-server\/services\/sim2real-web\/server\.js/,
    /ReadWritePaths=\/var\/lib\/rdk-robot-learning-platform\/sim2real/,
    /ReadWritePaths=\/var\/log\/rdk-sim2real/,
    /ReadWritePaths=\/var\/lib\/sim2real\/dsh/,
    /Environment=EXPRESS_TRUST_PROXY=1/,
    /Environment=RDK_SIM2REAL_CSP_DISABLE=0/,
    /Environment=RDK_SIM2REAL_STORAGE_LEASE=1/,
    /ExecStartPre=\/usr\/bin\/test \$\{EXPRESS_TRUST_PROXY\} = 1/,
    /ExecStartPre=\/usr\/bin\/test \$\{RDK_SIM2REAL_RATE_LIMIT_PER_MINUTE\} = 1200/,
    /ExecStartPre=\/usr\/bin\/test \$\{RDK_SIM2REAL_DSH_HOME\} = \/var\/lib\/sim2real\/dsh/,
    /ExecStartPre=\/usr\/bin\/test \$\{PATH\} = \/usr\/local\/bin:\/usr\/bin:\/bin/,
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
assert.match(
  integratedUnit,
  /ExecStartPre=\/bin\/sh -c 'test -n "\$\$\{RDK_SIM2REAL_TRUSTED_PROXY_SECRET\}"'/,
);
assert.match(
  integratedUnit,
  /ExecStartPre=.*Buffer\.byteLength\(process\.env\.RDK_SIM2REAL_TRUSTED_PROXY_SECRET/,
);
assert.match(integratedUnit, /EnvironmentFile=\/etc\/sim2real-web-runner\.env/);
assert.doesNotMatch(integratedUnit, /EnvironmentFile=-\/etc\/sim2real-web-runner\.env/);
assert.match(integratedUnit, /ExecStartPre=\/usr\/bin\/test \$\{EXPRESS_TRUST_PROXY\} = 1/);
assert.match(
  integratedUnit,
  /ExecStartPre=\/usr\/bin\/test \$\{RDK_SIM2REAL_DSH_HOME\} = \/opt\/sim2real-web\/data\/dsh/,
);
assert.match(
  integratedUnit,
  /ConditionPathExists=.*dist-server\/services\/sim2real-web\/server\.js/,
);
assert.doesNotMatch(integratedUnit, /ReadOnlyPaths=\/opt\/rdstudio-web-opt/);
assert.match(
  integratedUnit,
  /ReadWritePaths=\/var\/log\/rdk-sim2real/,
  'studio-integrated-sim2real.service must allow the documented dedicated audit volume',
);
assert.match(
  integratedUnit,
  /Environment=RDK_SIM2REAL_DSH_HOME=\/opt\/sim2real-web\/data\/dsh/,
  'studio-integrated-sim2real.service must pin DSH persistence inside its writable data root',
);
assert.match(
  integratedUnit,
  /ReadWritePaths=\/opt\/sim2real-web\/data\/dsh/,
  'studio-integrated-sim2real.service must keep DSH persistence writable',
);

const copyScript = read('scripts/copy-server-assets.mjs');
assert.match(copyScript, /mock-local-worker\.mjs/, 'build:assets must ship the mock worker');
assert.match(
  copyScript,
  /local-training-worker\.mjs/,
  'build:assets must ship the local worker bridge',
);
assert.match(
  copyScript,
  /local-board-agent\.mjs/,
  'build:assets must ship the BoardAgent reference',
);
for (const file of [
  'verify-production-config.mjs',
  'verify-production-config.test.mjs',
  'probe-sim2real.mjs',
  'sim2real-storage-backup.mjs',
  'verify-storage-backup.mjs',
  'verify-service-probe.mjs',
]) {
  assert.match(
    copyScript,
    new RegExp(file.replace('.', '\\.'), 'g'),
    `build:assets must ship ${file}`,
  );
}
assert.match(copyScript, /sim2real\.production\.env\.example/);
assert.ok(existsSync(path.join(root, 'services/sim2real-web/public/microduck-unavailable.html')));
for (const relativePath of [
  'services/sim2real-web/public/originbot-sim/index.html',
  'services/sim2real-web/public/originbot-sim/sim.js',
]) {
  assert.ok(existsSync(path.join(root, relativePath)), `${relativePath} must ship in the release`);
}
const originbotHtml = read('services/sim2real-web/public/originbot-sim/index.html');
const originbotSim = read('services/sim2real-web/public/originbot-sim/sim.js');
const boardPolicyRuntime = read('services/sim2real-web/board-policy-runtime.py');
const boardTelemetryNode = read('services/sim2real-web/board-telemetry-node.py');
const boardAgent = read('services/sim2real-web/board-agent-x5.py');
const boardDrivePublisher = read('services/sim2real-web/board-drive-publisher.py');
const boardIpc = read('services/sim2real-web/board_ipc.py');
const boardTelemetryUploader = read('services/sim2real-web/board-telemetry-uploader.py');
const telemetryCore = read('services/sim2real-web/public/telemetry-core.js');
const stationApp = read('services/sim2real-web/public/app.js');
const mujocoApp = read('services/mujoco-web/app.py');
const mujocoStaticApp = read('services/mujoco-web/static/app.js');
const mujocoModels = read('services/mujoco-web/models.py');
const mujocoUnit = read('services/mujoco-web/mujoco-web.service');
assert.match(originbotHtml, /MuJoCo 3D/);
assert.match(originbotHtml, /<script\s+src="\.\/sim\.js\?v=9"/);
assert.match(originbotSim, /const API_ROOT = `\$\{mujocoBase\}\/api`/);
assert.match(originbotSim, /source: 'originbot-sim'/);
assert.match(originbotSim, /domain_randomization: domainRandomization/);
assert.match(originbotSim, /const FRAME_MS = 100/);
assert.match(mujocoApp, /CMD_VEL_STEP_SECONDS = 0\.05/);
assert.match(mujocoApp, /depth\.png/);
assert.match(mujocoApp, /scanMeta/);
assert.match(mujocoApp, /"count": len\(scan\)/);
assert.match(mujocoApp, /"appliedLinear": applied_linear/);
assert.match(mujocoApp, /"appliedAngular": applied_angular/);
assert.match(mujocoApp, /"source": "cmd_vel"/);
assert.match(mujocoApp, /_zero_cmd_vel/);
assert.match(mujocoApp, /_hide_sensor_debug_geometry/);
assert.match(mujocoApp, /@app\.delete\("\/api\/sessions\/{session_id}"\)/);
assert.match(mujocoApp, /Simulation session expired/);
assert.match(mujocoApp, /def _close_renderers/);
assert.match(mujocoApp, /_drop_session\(session_id\)/);
assert.match(mujocoApp, /response\.headers\["Cache-Control"\] = "no-store"/);
assert.match(mujocoApp, /mujoco-session-janitor/);
assert.match(mujocoApp, /SESSION_CLEANUP_INTERVAL_SECONDS/);
assert.match(mujocoApp, /_close_all_sessions/);
assert.match(mujocoApp, /"janitorIntervalSeconds": SESSION_CLEANUP_INTERVAL_SECONDS/);
assert.match(mujocoStaticApp, /keepalive: true/);
assert.match(originbotSim, /appliedAction:/);
assert.match(originbotSim, /policyAction:/);
assert.match(originbotSim, /actionOutput: 'physical-twist'/);
assert.match(originbotSim, /sessions\/\$\{sessionId\}\/step/);
assert.match(originbotSim, /method: 'DELETE'/);
assert.match(originbotSim, /pageUnloading/);
assert.match(boardPolicyRuntime, /def _sensor_sample_fresh\(sensor/);
assert.match(boardPolicyRuntime, /sampleMonotonicNs/);
assert.match(boardPolicyRuntime, /identity action projection requires exactly 2 outputs/);
assert.match(boardPolicyRuntime, /"cmd_vel":/);
assert.match(boardPolicyRuntime, /"actionOutput": ACTION_OUTPUT/);
assert.match(boardPolicyRuntime, /"actionScale":/);
assert.match(boardPolicyRuntime, /"controlHz": int\(DECISION_HZ\)/);
assert.match(telemetryCore, /normalizeTelemetryTwist/);
assert.match(telemetryCore, /actionOutput === 'physical-twist'/);
assert.match(telemetryCore, /TELEMETRY_CONTROL_HZ_LIMITS/);
assert.match(openapi, /cmd_vel:/);
assert.match(
  openapi,
  /actionOutput: \{ type: string, enum: \[physical-twist, normalized-twist\] \}/,
);
assert.match(openapi, /controlHz: \{ type: integer, minimum: 1, maximum: 50 \}/);
assert.match(boardTelemetryNode, /os\.environ\.get\("RDK_BOARD_TELEMETRY_HZ", "10"\)/);
assert.match(boardTelemetryNode, /SNAPSHOT_HZ = max\(1\.0, min\(50\.0, _snapshot_hz\)\)/);
assert.match(boardTelemetryNode, /sampleMonotonicNs/);
assert.match(boardIpc, /DEFAULT_RUNTIME_DIR = ["']\/var\/lib\/rdk-board-agent\/runtime["']/);
assert.match(boardIpc, /PRIVATE_DIR_MODE = 0o700/);
assert.match(boardIpc, /IPC_FILE_MODE = 0o600/);
assert.match(boardIpc, /O_NOFOLLOW/);
assert.match(boardIpc, /mkstemp\(prefix="\.ipc-", dir=parent\)/);
assert.match(boardIpc, /_fsync_parent\(parent\)/);
assert.match(boardDrivePublisher, /ipc_path\("RDK_BOARD_DRIVE_CMD_FILE", "drive-command\.yaml"\)/);
assert.match(boardDrivePublisher, /secure_read_text\(CMD_FILE\)/);
assert.match(boardDrivePublisher, /atomic_write_text\(READY_FILE/);
assert.match(boardDrivePublisher, /secure_append_text\(LOG_FILE/);
assert.match(boardTelemetryNode, /atomic_write_json\(SNAPSHOT_FILE, payload\)/);
assert.match(boardAgent, /ipc_path\(\s*"RDK_BOARD_DRIVE_CMD_FILE", "drive-command\.yaml"/);
assert.match(boardAgent, /secure_read_json\(TELEMETRY_SNAPSHOT_FILE\)/);
assert.match(boardAgent, /atomic_write_text\(\s*POLICY_CMD_FILE/);
assert.match(boardAgent, /source "\$1"/);
assert.doesNotMatch(boardAgent, /f"source \{TROS_SETUP\}/);
assert.match(boardPolicyRuntime, /ipc_path\("RDK_BOARD_POLICY_CMD", "policy-runtime-cmd\.json"\)/);
assert.match(boardPolicyRuntime, /secure_read_text\(CMD_FILE\)/);
assert.match(boardPolicyRuntime, /_atomic_write_json\(READY_FILE/);
assert.match(boardTelemetryUploader, /secure_open_read\(SPOOL\)/);
assert.match(boardTelemetryUploader, /atomic_write_text\(CHECKPOINT/);
assert.match(boardTelemetryUploader, /secure_read_text\(CHECKPOINT/);
assert.match(mujocoModels, /name="depth_camera"/);
assert.match(mujocoModels, /name="depth_camera"[^>]*xyaxes="0 -1 0 \.259 0 \.966"/);
assert.match(mujocoModels, /<velocity name="left_wheel"/);
assert.match(mujocoUnit, /Environment=XDG_CACHE_HOME=\/tmp\/mujoco-web-cache/);

const productionEnv = read('services/sim2real-web/sim2real.production.env.example');
const gpuDeploy = read('scripts/gpu-deploy.mjs');
assert.match(gpuDeploy, /never print the bearer/i);
assert.match(gpuDeploy, /function validHost\(/);
assert.match(gpuDeploy, /function validUser\(/);
assert.match(gpuDeploy, /function validPort\(/);
assert.match(gpuDeploy, /function validRemoteDir\(/);
assert.match(
  gpuDeploy,
  /invalid --host\/--user\/--port\/--dir/,
  'gpu deployment must reject unsafe SSH arguments before interpolation',
);
assert.doesNotMatch(
  gpuDeploy,
  /console\.log\(`[^`]*RDK_SIM2REAL_LOCAL_RUNNER_TOKEN=\$\{token\}/s,
  'gpu deployment must never print the generated bearer into terminal logs',
);
assert.doesNotMatch(gpuDeploy, /token\.slice\(/, 'gpu deployment must not reveal a token prefix');
const unsafeGpuArgs = spawnSync(
  process.execPath,
  [
    path.join(root, 'scripts/gpu-deploy.mjs'),
    '--host',
    'gpu.example',
    '--user',
    'robot',
    '--dir',
    '/tmp;id',
  ],
  { encoding: 'utf8' },
);
assert.equal(
  unsafeGpuArgs.status,
  2,
  'gpu deployment must reject shell metacharacters in remote paths',
);
const deployX5 = path.join(root, 'scripts/deploy-x5-board-agent.sh');
const shellSyntax = spawnSync('bash', ['-n', deployX5], { encoding: 'utf8' });
assert.equal(shellSyntax.status, 0, 'X5 deployment script must pass bash -n');
const unsafeX5 = spawnSync('bash', [deployX5], {
  encoding: 'utf8',
  env: { ...process.env, RDK_X5_SSH_TARGET: 'root@board;id' },
});
assert.equal(unsafeX5.status, 2, 'X5 deployment must reject shell metacharacters in SSH target');
const unsafeX5Dir = spawnSync('bash', [deployX5], {
  encoding: 'utf8',
  env: {
    ...process.env,
    RDK_X5_SSH_TARGET: 'root@board-host',
    RDK_X5_AGENT_DIR: '/srv/other-agent',
  },
});
assert.equal(unsafeX5Dir.status, 2, 'X5 deployment must keep the reviewed systemd path fixed');
const deployX5Source = read('scripts/deploy-x5-board-agent.sh');
const installX5 = path.join(root, 'scripts/install-x5-board-agent.sh');
assert.ok(existsSync(installX5), 'fresh-board onboarding must ship an explicit installer');
const installX5Syntax = spawnSync('bash', ['-n', installX5], { encoding: 'utf8' });
assert.equal(installX5Syntax.status, 0, 'X5 onboarding installer must pass bash -n');
const installX5Help = spawnSync('bash', [installX5, '--help'], { encoding: 'utf8' });
assert.equal(
  installX5Help.status,
  0,
  'X5 onboarding installer --help must be local and deterministic',
);
assert.match(installX5Help.stdout, /--force[\s\S]*--enable/);
const unsafeInstallX5 = spawnSync('bash', [installX5], {
  encoding: 'utf8',
  env: { ...process.env, RDK_X5_SSH_TARGET: 'root@board;id' },
});
assert.equal(
  unsafeInstallX5.status,
  2,
  'X5 onboarding installer must reject shell metacharacters before opening SSH',
);
const installX5Source = read('scripts/install-x5-board-agent.sh');
assert.match(installX5Source, /rdk-board-agent\.service/);
assert.match(installX5Source, /rdk-board-telemetry-uploader\.service/);
assert.match(installX5Source, /\/etc\/rdk-board-agent\/agent\.env/);
assert.match(installX5Source, /\/etc\/rdk-board-agent\/telemetry\.env/);
assert.match(installX5Source, /\/var\/lib\/rdk-board-agent\/telemetry/);
assert.match(installX5Source, /\/var\/lib\/rdk-board-agent\/roslogs/);
assert.match(installX5Source, /\/var\/lib\/rdk-board-agent\/runtime/);
assert.match(installX5Source, /chmod 0600/);
assert.match(installX5Source, /install -d -o root -g root -m 0700/);
assert.match(installX5Source, /preserving existing unit \(use --force after review\)/);
assert.match(installX5Source, /if \[ "\$force" -ne 1 \]/);
assert.match(installX5Source, /systemctl daemon-reload/);
assert.match(installX5Source, /if \[ "\$enable" -eq 1 \]/);
assert.match(installX5Source, /systemctl enable --now rdk-board-agent\.service/);
assert.doesNotMatch(
  installX5Source,
  /systemctl\s+(?:stop|restart)\b/,
  'fresh-board installer must never stop or restart a running unit',
);
assert.match(installX5Source, /refusing symlink environment file/);
assert.match(installX5Source, /refusing symlink systemd unit/);
assert.doesNotMatch(
  deployX5Source,
  /(?:bash|sh|source)\s+[^\n]*install-x5-board-agent\.sh/,
  'update-only X5 deployment must not implicitly install or initialize units',
);
assert.match(
  deployX5Source,
  /rdk-board-telemetry-uploader\.service/,
  'X5 deployment must restart the uploader when its code is replaced',
);
assert.match(
  deployX5Source,
  /if \[ "\$agent_was_active" -eq 1 \]; then[\s\S]*systemctl start rdk-board-agent\.service[\s\S]*systemctl is-active --quiet rdk-board-agent\.service/,
  'update-only X5 deployment must restore the agent active state instead of starting a stopped service',
);
assert.match(
  deployX5Source,
  /if \[ "\$uploader_was_active" -eq 1 \]; then[\s\S]*systemctl start rdk-board-telemetry-uploader\.service[\s\S]*systemctl is-active --quiet rdk-board-telemetry-uploader\.service/,
  'update-only X5 deployment must restore the uploader active state',
);
assert.match(
  deployX5Source,
  /\/root\/rdk-board-agent\/policies/,
  'X5 deployment must provision the board agent policy trust directory',
);
assert.match(
  deployX5Source,
  /\/var\/lib\/rdk-board-agent\/telemetry/,
  'X5 deployment must provision the telemetry spool/log directory used by the units',
);
assert.match(
  deployX5Source,
  /\/var\/lib\/rdk-board-agent\/roslogs/,
  'X5 deployment must provision the ROS log directory used by the sampler',
);
assert.match(
  deployX5Source,
  /\/var\/lib\/rdk-board-agent\/runtime/,
  'X5 deployment must provision the private IPC runtime directory',
);
assert.match(
  deployX5Source,
  /board_ipc\.py[\s\S]*board-drive-publisher\.py/,
  'X5 deployment must ship the shared IPC helper and drive publisher',
);
assert.match(
  deployX5Source,
  /files="board-agent-x5\.py board_ipc\.py board-drive-publisher\.py/,
  'X5 rollback must include every IPC process asset',
);
assert.match(
  deployX5Source,
  /systemctl stop rdk-board-agent\.service[\s\S]*mv -f "\$backup\/\$file"/,
  'X5 deployment rollback must stop the live agent before restoring files',
);
assert.match(
  deployX5Source,
  /systemctl cat rdk-board-agent\.service[\s\S]*install-x5-board-agent\.sh first/,
  'X5 update must refuse a board that has not gone through the reviewed unit installer',
);
assert.match(
  deployX5Source,
  /if \[ -f "\$backup\/\$file" \]; then[\s\S]*else[\s\S]*rm -f "\$root\/\$file"/,
  'X5 deployment rollback must remove files that did not exist before the update',
);
assert.match(
  read('services/sim2real-web/rdk-board-agent.service'),
  /ReadWritePaths=.*\/root\/rdk-board-agent\/policies/,
  'board agent systemd unit must keep its policy trust directory writable',
);
const boardAgentUnit = read('services/sim2real-web/rdk-board-agent.service');
assert.match(boardAgentUnit, /ReadWritePaths=.*\/var\/lib\/rdk-board-agent\/runtime/);
assert.match(boardAgentUnit, /PrivateTmp=true/);
assert.match(boardAgentUnit, /UMask=0077/);
assert.doesNotMatch(boardAgentUnit, /ReadWritePaths=.*(?:^|\s)\/tmp(?:\s|$)/);
const originbotAdapter = JSON.parse(read('adapters/rdk-originbot.json'));
assert.equal(originbotAdapter.runtime?.actionOutput, 'normalized-twist');
const originbotTrainer = read('engines/rdk-rl-env/train_originbot.py');
assert.match(originbotTrainer, /actionOutput.*normalized-twist/);
const starterRunner = read('engines/starter-ppo/runner.py');
assert.match(starterRunner, /actionOutput.*normalized-twist/);
assert.match(boardPolicyRuntime, /ACTION_OUTPUT =/);
assert.match(boardPolicyRuntime, /normalized-twist/);
assert.match(
  boardAgent,
  /def _loopback_bind_host\(/,
  'X5 board agent must classify bind hosts before allowing an empty token',
);
assert.match(
  boardAgent,
  /RDK_SIM2REAL_BOARD_AGENT_TOKEN is required when/,
  'X5 board agent must fail closed when a non-loopback bind has no token',
);
assert.match(boardAgent, /"actionOutput": snap\.get\("actionOutput"\)/);
assert.match(boardAgent, /"controlHz": snap\.get\("controlHz"\)/);
assert.match(stationApp, /动作单位：\$\{actionOutput\}/);
const activeProductionEnv = productionEnv
  .split(/\r?\n/)
  .filter((line) => !line.trim().startsWith('#'))
  .join('\n');
assert.doesNotMatch(activeProductionEnv, /RDK_SIM2REAL_DEPLOYMENT=local/);
assert.doesNotMatch(activeProductionEnv, /RDK_SIM2REAL_STORAGE_DIR=\.data/);
assert.match(productionEnv, /RDK_SIM2REAL_TRUSTED_PROXY_SECRET=/);
assert.match(productionEnv, /EXPRESS_TRUST_PROXY=1/);
assert.match(productionEnv, /RDK_SIM2REAL_ENABLE_HSTS=1/);
assert.match(productionEnv, /RDK_SIM2REAL_STORAGE_LEASE=1/);
assert.match(productionEnv, /RDK_SIM2REAL_STORAGE_LEASE_STALE_SECONDS=\d+/);
assert.match(productionEnv, /RDK_SIM2REAL_TELEMETRY_RETENTION_DAYS=\d+/);
assert.match(productionEnv, /RDK_SIM2REAL_ACTIVE_RUN_TTL_SECONDS=\d+/);
assert.match(productionEnv, /RDK_SIM2REAL_COMPUTE_HEALTH_TTL_SECONDS=\d+/);
assert.ok(existsSync(path.join(root, 'scripts/verify-production-config.mjs')));
assert.ok(existsSync(path.join(root, 'scripts/verify-production-config.test.mjs')));
assert.ok(existsSync(path.join(root, 'scripts/probe-sim2real.mjs')));
assert.ok(existsSync(path.join(root, 'scripts/sim2real-storage-backup.mjs')));
assert.ok(existsSync(path.join(root, 'scripts/verify-storage-backup.mjs')));
assert.ok(existsSync(path.join(root, 'scripts/verify-service-probe.mjs')));

const sim2realNginx = read('services/sim2real-web/install-nginx-route.py');
assert.match(sim2realNginx, /location = \/robotics-learning/);
assert.match(sim2realNginx, /proxy_pass http:\/\/127\.0\.0\.1:18102\//);
assert.match(sim2realNginx, /target_server_block/);
assert.match(sim2realNginx, /does not match the managed block/);
const microduckNginx = read('services/mujoco-web/install-microduck-nginx-route.py');
assert.match(microduckNginx, /location \/mujoco\/microduck\//);
assert.match(microduckNginx, /proxy_pass http:\/\/127\.0\.0\.1:18101\//);
assert.match(microduckNginx, /target_server_block/);
assert.match(
  read('services/mujoco-web/microduck-web.service'),
  /ExecStart=\/usr\/bin\/python3 -m http\.server 18101 --bind 127\.0\.0\.1/,
);
assert.match(
  read('services/mujoco-web/microduck-web.service'),
  /ConditionPathExists=\/usr\/bin\/python3/,
);
assert.match(
  read('services/mujoco-web/microduck-web.service'),
  /ConditionPathExists=.*microduck-web\/current\/index\.html/,
);
assert.match(
  read('services/mujoco-web/mujoco-web.service'),
  /ConditionPathExists=.*mujoco-web\/current\/app\.py/,
);
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
  'services/sim2real-web/board_ipc.py',
  'services/sim2real-web/board-agent-x5.py',
  'services/sim2real-web/board-drive-publisher.py',
  'services/sim2real-web/board-telemetry-node.py',
  'services/sim2real-web/board-policy-runtime.py',
  'services/sim2real-web/board-telemetry-uploader.py',
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
    'services/sim2real-web/studio-integrated-sim2real.service',
    'services/sim2real-web/sim2real-mock-worker.service',
    'services/sim2real-web/sim2real-local-worker.service',
    'services/sim2real-web/rdk-board-agent.service',
    'services/sim2real-web/rdk-board-telemetry-uploader.service',
    'services/mujoco-web/microduck-web.service',
    'services/mujoco-web/mujoco-web.service',
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

console.log(
  '[deployment-assets] PASS — service units, release guards, and static fallback are wired',
);
