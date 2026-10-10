#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(new URL('./deploy-sim2real-production.sh', import.meta.url));
const source = fs.readFileSync(scriptPath, 'utf8');
const syntax = spawnSync('bash', ['-n', scriptPath], { encoding: 'utf8' });
assert.equal(syntax.status, 0, syntax.stderr);
const remoteBlocks = [...source.matchAll(/<<'REMOTE'\n([\s\S]*?)\nREMOTE/g)].map(
  (match) => match[1],
);
assert.equal(remoteBlocks.length, 5, 'release preparation, entry checks, rollback, switch, probes');
assert.doesNotMatch(
  source,
  /^npm ci\b/m,
  'production node_modules must not be installed on the build host',
);
assert.match(source, /tar czf "\$TARBALL" --exclude='node_modules'/);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sim2real-release-contract-'));

function bash(body, args = [], env = {}) {
  return spawnSync('bash', ['-s', '--', ...args], {
    input: `set -euo pipefail\n${body}\n`,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function functionSource(name) {
  const match = source.match(new RegExp(`(?:^|\\n)\\s*${name}\\(\\) \\{[\\s\\S]*?\\n\\s*\\}\\n`));
  assert.ok(match, `deploy script must define ${name}`);
  return match[0];
}

function write(relative, text = 'fixture') {
  const file = path.join(scratch, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

try {
  // An installed optional CPU worker joins the same release transaction;
  // an absent unit keeps the established two-service deployment unchanged.
  const selectUnits = functionSource('select_deploy_units');
  const selectBody = `HOST=fixture; WEB_UNIT=sim2real-web.service; WORKER_UNIT=sim2real-mock-worker.service; CPU_WORKER_UNIT=sim2real-cpu-worker.service
ssh() { printf '%s' "$MOCK_LOAD_STATE"; }
${selectUnits}
select_deploy_units`;
  assert.equal(
    bash(selectBody, [], { MOCK_LOAD_STATE: 'not-found' }).stdout.trim(),
    'sim2real-web.service sim2real-mock-worker.service',
  );
  assert.equal(
    bash(selectBody, [], { MOCK_LOAD_STATE: 'loaded' }).stdout.trim(),
    'sim2real-web.service sim2real-mock-worker.service sim2real-cpu-worker.service',
  );
  assert.notEqual(bash(selectBody, [], { MOCK_LOAD_STATE: 'error' }).status, 0);
  assert.notEqual(
    bash(selectBody.replace('printf \'%s\' "$MOCK_LOAD_STATE"', 'return 255')).status,
    0,
  );

  const activationBody = `HOST=fixture; CPU_WORKER_UNIT=sim2real-cpu-worker.service
ssh() { printf '%s' "$MOCK_ACTIVE_STATE"; }
${functionSource('read_cpu_activation_state')}
read_cpu_activation_state`;
  assert.equal(bash(activationBody, [], { MOCK_ACTIVE_STATE: 'active' }).stdout.trim(), '1');
  for (const state of ['inactive', 'failed'])
    assert.equal(bash(activationBody, [], { MOCK_ACTIVE_STATE: state }).stdout.trim(), '0');
  for (const state of ['activating', 'deactivating', 'reloading', 'unknown'])
    assert.notEqual(bash(activationBody, [], { MOCK_ACTIVE_STATE: state }).status, 0);

  // A clean source overlay must ship new common helpers and retain configs,
  // while never replacing Linux dependency files with a developer's Mac venv.
  const engineRoot = path.join(scratch, 'engines');
  const validFiles = [
    'imitation_input.py',
    'act/train_act.py',
    'act/requirements.txt',
    'task-specs/task.json',
  ];
  for (const file of validFiles) write(`engines/${file}`, `new:${file}`);
  for (const file of [
    '.venv/bin/python',
    'act/venv/bin/python',
    'act/site-packages/module.py',
    'act/__pycache__/train_act.pyc',
    'act/checkpoints/model.pt',
    'act/evidence/policy.ts',
    'act/artifacts/model.onnx',
    'act/policy.onnx',
    'act/training-summary.json',
    'act/telemetry.jsonl',
    'act/outputs/data.npz',
    'act/logs/train.log',
    'act/.env',
    'act/model.safetensors',
  ])
    write(`engines/${file}`, 'must-not-ship');
  const engineArchive = path.join(scratch, 'engine-source.tar.gz');
  const packed = bash(`${functionSource('pack_engine_sources')}\npack_engine_sources "$1" "$2"`, [
    engineRoot,
    engineArchive,
  ]);
  assert.equal(packed.status, 0, packed.stderr);
  const archiveList = spawnSync('tar', ['tzf', engineArchive], { encoding: 'utf8' });
  assert.equal(archiveList.status, 0, archiveList.stderr);
  for (const file of validFiles)
    assert.ok(archiveList.stdout.includes(`./${file}`), `${file} must ship`);
  assert.doesNotMatch(
    archiveList.stdout,
    /\.venv|\/venv|site-packages|__pycache__|checkpoints|evidence|artifacts|policy\.onnx|training-summary|telemetry\.jsonl|outputs|train\.log|\.env|safetensors/,
  );

  const base = path.join(scratch, 'server');
  const previous = path.join(base, 'releases', 'previous');
  write('server/releases/previous/dist-server/engines/.venv/bin/python', 'linux-python');
  write('server/releases/previous/dist-server/engines/act/train_act.py', 'old-source');
  write('server/releases/previous/node_modules/rollback/sentinel', 'old-dependencies');
  fs.symlinkSync('releases/previous', path.join(base, 'current'));
  const packageRoot = path.join(scratch, 'package', 'next');
  write('package/next/dist-server/services/sim2real-web/server.js', 'void 0;');
  write('package/next/package.json', '{"name":"release-fixture","private":true}');
  const fixtureLock = '{"name":"release-fixture","lockfileVersion":3,"packages":{}}';
  write('package/next/package-lock.json', fixtureLock);
  // A legacy Mac dependency tree must never survive Linux release preparation.
  write('package/next/node_modules/mac-only-native/sentinel', 'must-not-survive');
  const npmCli = write(
    'fixture-npm-cli.cjs',
    `const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
assert.deepEqual(args.slice(0, -1), ['ci', '--omit=dev', '--include=optional', '--no-audit', '--no-fund', '--prefix']);
const root = args.at(-1);
assert.equal(process.env.PATH.split(path.delimiter)[0], path.dirname(process.execPath));
assert.equal(fs.existsSync(path.join(root, 'node_modules')), false);
if (process.env.INSTALL_MODE === 'install-failure') {
  console.error('registry credential must not reach deploy stdout');
  process.exit(42);
}
const moduleRoot = path.join(root, 'node_modules/@deepseek-ai/node-addon-system');
fs.mkdirSync(moduleRoot, { recursive: true });
fs.writeFileSync(path.join(moduleRoot, 'package.json'), JSON.stringify({
  name: '@deepseek-ai/node-addon-system', type: 'module', exports: { './flock': './flock.js' }
}));
fs.writeFileSync(path.join(moduleRoot, 'flock.js'), \`import fs from 'node:fs';
import { createRequire } from 'node:module';
export async function tryLockExclusive(fd) {
  fs.fstatSync(fd);
  fs.writeFileSync(process.env.NATIVE_TRACE, 'lock-called');
  if (process.env.INSTALL_MODE === 'missing-native') {
    createRequire(import.meta.url)('@deepseek-ai/node-addon-system-' + process.platform + '-' + process.arch + '/package.json');
  }
  if (process.env.INSTALL_MODE === 'native-failure') throw new Error('native lock failure');
}
\`);
`,
  );
  const nativeTrace = path.join(scratch, 'native-trace');
  const probeTmp = path.join(scratch, 'probe-tmp');
  fs.mkdirSync(probeTmp);
  fs.copyFileSync(engineArchive, path.join(packageRoot, 'engine-source.tar.gz'));
  const remoteArchive = path.join('/tmp', `sim2real-contract-${process.pid}-${Date.now()}.tar.gz`);
  const releaseTar = spawnSync(
    'tar',
    ['czf', remoteArchive, '-C', path.dirname(packageRoot), 'next'],
    { encoding: 'utf8' },
  );
  assert.equal(releaseTar.status, 0, releaseTar.stderr);
  try {
    const preparationArgs = [base, 'next', path.basename(remoteArchive), process.execPath, npmCli];
    const preparationEnv = { NATIVE_TRACE: nativeTrace, TMPDIR: probeTmp };
    // npm failure must stop before switching current, without printing a
    // registry credential. Merely importing flock must not pass a missing
    // platform binding: the probe must call its lazy native operation.
    for (const mode of ['install-failure', 'missing-native', 'native-failure']) {
      fs.rmSync(nativeTrace, { force: true });
      const failed = bash(remoteBlocks[0], preparationArgs, {
        ...preparationEnv,
        INSTALL_MODE: mode,
      });
      assert.notEqual(failed.status, 0, `${mode} must fail before activating the release`);
      assert.doesNotMatch(failed.stdout + failed.stderr, /registry credential/);
      assert.equal(fs.readlinkSync(path.join(base, 'current')), 'releases/previous');
      assert.equal(
        fs.statSync(path.join(base, 'releases/next/.release-install.log')).mode & 0o777,
        0o600,
        'failed install logs must be private',
      );
      assert.deepEqual(fs.readdirSync(probeTmp), [], 'probe files must be removed after failure');
      if (mode !== 'install-failure')
        assert.equal(fs.readFileSync(nativeTrace, 'utf8'), 'lock-called');
    }
    // Execute only the extracted filesystem-preparation heredoc locally. It
    // makes no SSH, HTTP, training, or systemd request.
    const prepared = bash(`umask 022\n${remoteBlocks[0]}`, preparationArgs, {
      ...preparationEnv,
      INSTALL_MODE: 'success',
    });
    assert.equal(prepared.status, 0, prepared.stderr);
    const installedModule = path.join(
      base,
      'releases/next/node_modules/@deepseek-ai/node-addon-system',
    );
    assert.equal(
      fs.statSync(installedModule).mode & 0o777,
      0o755,
      'service users must be able to traverse dependencies',
    );
    assert.equal(
      fs.statSync(path.join(installedModule, 'flock.js')).mode & 0o777,
      0o644,
      'service users must be able to read dependencies',
    );
    assert.equal(fs.readFileSync(nativeTrace, 'utf8'), 'lock-called');
    assert.deepEqual(fs.readdirSync(probeTmp), []);
    assert.equal(fs.existsSync(path.join(base, 'releases/next/.release-install.log')), false);
    assert.equal(
      fs.existsSync(path.join(base, 'releases/next/node_modules/mac-only-native')),
      false,
    );
    assert.equal(
      fs.readFileSync(path.join(base, 'releases/next/package-lock.json'), 'utf8'),
      fixtureLock,
    );
    assert.equal(
      fs.readFileSync(
        path.join(base, 'releases/next/dist-server/engines/act/train_act.py'),
        'utf8',
      ),
      'new:act/train_act.py',
    );
    assert.equal(
      fs.readFileSync(
        path.join(base, 'releases/next/dist-server/engines/imitation_input.py'),
        'utf8',
      ),
      'new:imitation_input.py',
    );
    assert.equal(
      fs.readFileSync(
        path.join(base, 'releases/next/dist-server/engines/.venv/bin/python'),
        'utf8',
      ),
      'linux-python',
    );
    assert.equal(
      fs.readFileSync(path.join(previous, 'dist-server/engines/act/train_act.py'), 'utf8'),
      'old-source',
    );
    assert.equal(
      fs.readFileSync(path.join(previous, 'node_modules/rollback/sentinel'), 'utf8'),
      'old-dependencies',
    );
    assert.equal(fs.readlinkSync(path.join(base, 'current')), 'releases/previous');
    assert.equal(fs.existsSync(path.join(base, 'releases/next/engine-source.tar.gz')), false);
  } finally {
    fs.rmSync(remoteArchive, { force: true });
  }

  // Reusing the active release name must fail before removing its rollback
  // contents, even if an operator reruns deployment at the same commit.
  const currentGuard = bash(remoteBlocks[0], [base, 'previous', 'absent.tar.gz', process.execPath]);
  assert.notEqual(currentGuard.status, 0);
  assert.match(currentGuard.stderr, /already current/);
  assert.equal(
    fs.readFileSync(path.join(previous, 'dist-server/engines/act/train_act.py'), 'utf8'),
    'old-source',
  );

  const twoUnits = 'sim2real-web.service sim2real-mock-worker.service';
  const threeUnits = `${twoUnits} sim2real-cpu-worker.service`;
  const remoteBash = functionSource('remote_bash');
  const unitFixture = `systemctl() {
  case "$2" in
    sim2real-web.service) printf 'ExecStart=/fixture/node %s/current/dist-server/services/sim2real-web/server.js\\n' "$BASE" ;;
    sim2real-mock-worker.service) printf 'ExecStart=/fixture/node %s/current/mock-local-worker.mjs\\n' "$BASE" ;;
    sim2real-cpu-worker.service) printf 'ExecStart=/fixture/node %s/current/local-training-worker.mjs\\n' "$BASE" ;;
    *) return 1 ;;
  esac
}`;
  write('server/releases/next/mock-local-worker.mjs', 'void 0;');
  assert.equal(
    bash(`${unitFixture}\n${remoteBlocks[1]}`, [base, 'next', ...twoUnits.split(' ')]).status,
    0,
  );
  const missingCpuEntry = bash(`${unitFixture}\n${remoteBlocks[1]}`, [
    base,
    'next',
    ...threeUnits.split(' '),
  ]);
  assert.notEqual(missingCpuEntry.status, 0);
  assert.match(missingCpuEntry.stderr, /sim2real-cpu-worker\.service/);
  const remoteEntrySection = source.slice(
    source.indexOf('echo "== [5/7]'),
    source.indexOf('echo "入口文件预检通过。"'),
  );
  const sshReparsedEntry = bash(
    `${unitFixture}
export -f systemctl
ssh() { shift 3; bash -c "$*"; }
${remoteBash}
HOST=fixture; BASE="$1"; RELEASE=next; read -r -a DEPLOY_UNITS <<< "$2"
${remoteEntrySection}`,
    [base, threeUnits],
  );
  assert.notEqual(
    sshReparsedEntry.status,
    0,
    'standard SSH joins and reparses arguments; missing CPU entry must still be rejected',
  );
  write('server/releases/next/local-training-worker.mjs', 'void 0;');
  assert.equal(
    bash(`${unitFixture}\n${remoteBlocks[1]}`, [base, 'next', ...threeUnits.split(' ')]).status,
    0,
  );
  assert.equal(
    [...source.matchAll(/"\$\{DEPLOY_UNITS\[@\]\}" <<'REMOTE'/g)].length,
    4,
    'the detected unit array must reach entry checks, switch, rollback and probes',
  );
  for (const units of [twoUnits, threeUnits]) {
    const restartTrace = path.join(scratch, 'restart-trace');
    fs.writeFileSync(restartTrace, '');
    const recovery = bash(
      `ln() { :; }
sleep() { :; }
systemctl() { if [ "$1" = restart ]; then printf '%s\\n' "$2" >> "$TRACE_FILE"; fi; }
${remoteBlocks[2]}`,
      [base, 'previous', '1', ...units.split(' ')],
      { TRACE_FILE: restartTrace },
    );
    assert.equal(recovery.status, 0, recovery.stderr);
    assert.deepEqual(fs.readFileSync(restartTrace, 'utf8').trim().split('\n'), units.split(' '));
  }
  const initialInstallTrace = path.join(scratch, 'initial-install-rollback-trace');
  const initialInstallRollback = bash(
    `ln() { :; }
sleep() { :; }
CPU_WAS_ACTIVE=0
systemctl() {
  case "$1" in
    restart|stop) printf '%s %s\\n' "$1" "$2" >> "$TRACE_FILE" ;;
    show) printf 'inactive\\n' ;;
  esac
}
${remoteBlocks[2]}`,
    [base, 'previous', '0', ...threeUnits.split(' ')],
    { TRACE_FILE: initialInstallTrace },
  );
  assert.equal(initialInstallRollback.status, 0, initialInstallRollback.stderr);
  assert.deepEqual(fs.readFileSync(initialInstallTrace, 'utf8').trim().split('\n'), [
    'restart sim2real-web.service',
    'restart sim2real-mock-worker.service',
    'stop sim2real-cpu-worker.service',
  ]);

  // Match OpenSSH's argv concatenation and the remote shell's second parse.
  // Unit arguments and a runtime path containing shell syntax stay literal.
  const injectionMarker = path.join(scratch, 'argument-injection-must-not-run');
  const runtimeArgument = `/fixture/node with space $(touch '${injectionMarker}')`;
  const npmArgument = `/fixture/npm cli $(touch '${injectionMarker}').js`;
  const reparsedArguments = bash(
    `ssh() { shift 3; bash -c "$*"; }
${remoteBash}
HOST=fixture
remote_bash "$@" <<'ARGUMENTS'
printf '<%s>\\n' "$@"
ARGUMENTS`,
    [runtimeArgument, npmArgument, ...threeUnits.split(' ')],
  );
  assert.equal(reparsedArguments.status, 0, reparsedArguments.stderr);
  assert.deepEqual(
    reparsedArguments.stdout.trim().split('\n'),
    [runtimeArgument, npmArgument, ...threeUnits.split(' ')].map((argument) => `<${argument}>`),
  );
  assert.equal(fs.existsSync(injectionMarker), false, 'SSH arguments must not execute shell code');

  // curl is replaced by a fixture binary. All probe tests are offline and
  // return status codes/health JSON; no endpoint or training request is touched.
  const bin = path.join(scratch, 'bin');
  const curl = write(
    'bin/curl',
    `#!/usr/bin/env bash
set -eu
endpoint=''
code_only=0
for argument in "$@"; do case "$argument" in http://*) endpoint=$argument ;; /dev/null) code_only=1 ;; esac; done
printf '%s\\n' "$endpoint" >> "$TRACE_FILE"
case "$endpoint" in
  *:18102/readyz) printf '%s' "\${READY_CODE:-200}" ;;
  *:18102/metrics) printf '%s' "\${METRICS_CODE:-200}" ;;
  *:19090/healthz) printf '%s' "\${WORKER_HEALTH_CODE:-200}" ;;
  *:19090/train) printf '%s' "\${WORKER_CODE:-400}" ;;
  *:19091/healthz)
    if [ "$code_only" = 1 ]; then printf '%s' "\${CPU_HEALTH_CODE:-200}";
    elif [ -n "\${CPU_HEALTH_BODY:-}" ]; then printf '%s' "$CPU_HEALTH_BODY";
    else printf '%s' '{"ok":true,"configured":true,"mode":"external-engine","engines":["offline-bc"]}'; fi ;;
  *:19091/train) printf '%s' "\${CPU_CODE:-401}" ;;
  *) printf '200' ;;
esac
`,
  );
  fs.chmodSync(curl, 0o755);
  const trace = path.join(scratch, 'probe-trace');
  const probeEnv = { PATH: `${bin}:${process.env.PATH}`, TRACE_FILE: trace };
  const probeArgs = [process.execPath, ...twoUnits.split(' ')];
  for (const code of ['400', '422']) {
    fs.writeFileSync(trace, '');
    const probes = bash(remoteBlocks[4], probeArgs, { ...probeEnv, WORKER_CODE: code });
    assert.equal(probes.status, 0, probes.stderr);
    const calls = fs.readFileSync(trace, 'utf8');
    for (const endpoint of ['/healthz', '/readyz', '/metrics', '/train'])
      assert.ok(calls.includes(endpoint));
    assert.ok(!calls.includes(':19091/'), 'an absent CPU unit must never be probed');
  }
  for (const code of ['000', '200', '404', '500']) {
    const probes = bash(remoteBlocks[4], probeArgs, { ...probeEnv, WORKER_CODE: code });
    assert.notEqual(probes.status, 0, `worker HTTP ${code} must fail release acceptance`);
  }
  for (const env of [
    { READY_CODE: '503' },
    { METRICS_CODE: '403' },
    { WORKER_HEALTH_CODE: '500' },
  ]) {
    assert.notEqual(bash(remoteBlocks[4], probeArgs, { ...probeEnv, ...env }).status, 0);
  }
  const cpuArgs = [process.execPath, ...threeUnits.split(' ')];
  const readyCpu = JSON.stringify({
    ok: true,
    configured: true,
    mode: 'external-engine',
    engines: ['offline-bc'],
  });
  for (const code of ['400', '401', '422']) {
    fs.writeFileSync(trace, '');
    const probes = bash(remoteBlocks[4], cpuArgs, {
      ...probeEnv,
      CPU_CODE: code,
      CPU_HEALTH_BODY: readyCpu,
    });
    assert.equal(probes.status, 0, probes.stderr);
    assert.ok(fs.readFileSync(trace, 'utf8').includes(':19091/train'));
  }
  for (const code of ['000', '200', '403', '404', '500']) {
    assert.notEqual(
      bash(remoteBlocks[4], cpuArgs, { ...probeEnv, CPU_CODE: code, CPU_HEALTH_BODY: readyCpu })
        .status,
      0,
      `CPU worker HTTP ${code} must fail release acceptance`,
    );
  }
  for (const env of [
    { CPU_HEALTH_CODE: '503' },
    { CPU_HEALTH_BODY: '{"ok":true,"configured":true,"mode":"mock","engines":["smoke"]}' },
    {
      CPU_HEALTH_BODY:
        '{"ok":false,"configured":true,"mode":"external-engine","engines":["offline-bc"]}',
    },
    {
      CPU_HEALTH_BODY:
        '{"ok":true,"configured":false,"mode":"external-engine","engines":["offline-bc"]}',
    },
    { CPU_HEALTH_BODY: '{"ok":true,"configured":true,"mode":"external-engine","engines":[]}' },
    { CPU_HEALTH_BODY: 'invalid-json' },
  ]) {
    assert.notEqual(bash(remoteBlocks[4], cpuArgs, { ...probeEnv, ...env }).status, 0);
  }
  assert.match(remoteBlocks[4], /-d '\{\}'/, 'probe submits only a malformed empty request');

  // Test the top-level failure branches with a shell-function SSH stub. A
  // restart/link failure must run rollback despite set -e.
  const switchSection = source.slice(
    source.indexOf('echo "== [6/7]'),
    source.indexOf('echo "== [7/7]'),
  );
  const healthSection = source.slice(
    source.indexOf('echo "== [7/7]'),
    source.indexOf('rm -f "$TARBALL"\necho "✅'),
  );
  for (const section of [switchSection, healthSection]) {
    const recoveryTrace = path.join(scratch, 'rollback-trace');
    fs.writeFileSync(recoveryTrace, '');
    const failed = bash(
      `${remoteBash}
HOST=fixture; BASE=/fixture; RELEASE=next; WEB_UNIT=web; WORKER_UNIT=worker; DEPLOY_UNITS=(web worker); NODE_BIN="${process.execPath}"
ssh() { cat >/dev/null; return 1; }
rollback_path="$1"
rollback() { printf 'rolled-back\\n' >> "$rollback_path"; }
${section}`,
      [recoveryTrace],
    );
    assert.notEqual(failed.status, 0);
    assert.equal(fs.readFileSync(recoveryTrace, 'utf8'), 'rolled-back\n');
  }

  const lock = path.join(scratch, 'lock');
  const releaseLock = functionSource('release_lock');
  const ownLock = bash(
    `${releaseLock}\nLOCK_DIR="$1"; mkdir "$LOCK_DIR"; printf '%s\\n' "$$" > "$LOCK_DIR/pid"; release_lock; test ! -e "$LOCK_DIR"`,
    [lock],
  );
  assert.equal(ownLock.status, 0, ownLock.stderr);
  const otherLock = bash(
    `${releaseLock}\nLOCK_DIR="$1"; mkdir "$LOCK_DIR"; printf '999999\\n' > "$LOCK_DIR/pid"; release_lock; test -f "$LOCK_DIR/pid"`,
    [lock],
  );
  assert.equal(otherLock.status, 0, otherLock.stderr);
  assert.match(source, /trap release_lock EXIT/);

  const nodeSetting = source.match(/^NODE_BIN=.*$/m)?.[0];
  assert.ok(nodeSetting);
  assert.equal(
    bash(`${nodeSetting}\nprintf '%s' "$NODE_BIN"`, [], { DEPLOY_NODE_BIN: '/fixture/node24' })
      .stdout,
    '/fixture/node24',
  );
  const npmSetting = source.match(/^NPM_CLI=.*$/m)?.[0];
  assert.ok(npmSetting);
  assert.equal(
    bash(`${npmSetting}\nprintf '%s' "$NPM_CLI"`, [], { DEPLOY_NPM_CLI: '/fixture/npm-cli.js' })
      .stdout,
    '/fixture/npm-cli.js',
  );
  console.log(
    '[deploy-sim2real-production] PASS — Linux npm and native lazy-load gates; source overlay preserves venv; failed switch/probes roll back; locks release',
  );
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
