#!/usr/bin/env node

/**
 * `node scripts/gpu-deploy.mjs` — one-shot deploy of the local training worker
 * + starter-ppo engine to a remote GPU machine.
 *
 * What it does (all over SSH, nothing runs on this Mac):
 *   1. verify SSH reachability (fail fast with an actionable message);
 *   2. rsync the minimal runtime set (worker, engine, manifests, package.json);
 *   3. install the Python stack (numpy/torch/onnx) into a venv if missing;
 *   4. probe CUDA and print the honest device report the engine will produce;
 *   5. write ~/rdk-sim2real/worker.env with a random runner token;
 *   6. (optional) install a systemd user service and start it;
 *   7. print the exact .env lines to paste into the web server config.
 *
 * Usage:
 *   node scripts/gpu-deploy.mjs --host 120.48.90.140 --port 2222 --user ssh-authkey-9b0c0fac2c7f5660f5ca09ed
 *   # extra flags: --dir ~/rdk-sim2real --service (install+start systemd unit)
 *
 * The script never writes into the repo and never prints the generated token
 * into stdout logs (it prints the env file path and a masked preview).
 */

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const flags = {
    host: process.env.RDK_GPU_HOST || '',
    port: process.env.RDK_GPU_PORT || '22',
    user: process.env.RDK_GPU_USER || '',
    dir: process.env.RDK_GPU_DIR || '~/rdk-sim2real',
    service: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--host') (flags.host = next), i++;
    else if (arg === '--port') (flags.port = next), i++;
    else if (arg === '--user') (flags.user = next), i++;
    else if (arg === '--dir') (flags.dir = next), i++;
    else if (arg === '--service') flags.service = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(
        'usage: node scripts/gpu-deploy.mjs --host <ip> [--port 22] [--user <ssh-user>] [--dir ~/rdk-sim2real] [--service]',
      );
      process.exit(0);
    } else {
      console.error(`unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  if (!flags.host || !flags.user) {
    console.error(
      'missing --host/--user (or RDK_GPU_HOST / RDK_GPU_USER env). ' +
        'example: node scripts/gpu-deploy.mjs --host 120.48.90.140 --port 2222 --user ssh-authkey-9b0c0fac2c7f5660f5ca09ed',
    );
    process.exit(2);
  }
  return flags;
}

const flags = parseArgs(process.argv.slice(2));
const sshTarget = `${flags.user}@${flags.host}`;
const sshBase = ['ssh', '-o', 'PreferredAuthentications=publickey', '-o', 'PasswordAuthentication=no', '-o', 'ConnectTimeout=10', '-o', 'BatchMode=yes', '-p', flags.port];

function ssh(command, { allowFail = false, timeout = 120_000 } = {}) {
  const run = spawnSync(sshBase[0], [...sshBase.slice(1), sshTarget, command], {
    encoding: 'utf8',
    timeout,
  });
  if (run.status !== 0 && !allowFail) {
    if (run.status === 255) {
      console.error(
        `\nSSH 连不上 ${sshTarget}:${flags.port}（publickey 被拒绝或机器不可达）。\n` +
          '  排查步骤：\n' +
          '  1. 机器是否已创建完成（云控制台看状态）；\n' +
          '  2. 本机公钥是否已加入服务器 authorized_keys：\n' +
          `     cat ~/.ssh/id_ed25519.pub → 上传到服务器 ~/.ssh/authorized_keys\n` +
          '  3. 手工验证: ' + sshBase.join(' ') + ' ' + sshTarget + ' echo ok',
      );
    }
    console.error(run.stderr || run.stdout || `ssh exited ${run.status}`);
    process.exit(1);
  }
  return run;
}

function step(name) {
  console.log(`\n[gpu-deploy] ${name}`);
}

// --- 1. reachability --------------------------------------------------------
step(`探测 SSH ${sshTarget}:${flags.port}`);
const echo = ssh('echo ok');
if (echo.stdout.trim() !== 'ok') {
  console.error('unexpected ssh output');
  process.exit(1);
}
console.log(`  ✓ 可达 (${echo.stdout.trim()})`);

// The worker rejects ~ paths (RDK_SIM2REAL_TRAIN_EXECUTABLE must be
// absolute), so resolve the deploy dir against the remote $HOME up front.
if (flags.dir.startsWith('~/') || flags.dir === '~') {
  const remoteHome = ssh('printf %s "$HOME"', { allowFail: true }).stdout.trim();
  if (remoteHome && remoteHome.startsWith('/')) {
    flags.dir = flags.dir === '~' ? remoteHome : remoteHome + flags.dir.slice(1);
    console.log(`  ✓ 部署目录解析为 ${flags.dir}`);
  }
}

// --- 2. sync runtime files --------------------------------------------------
step(`同步运行时文件到 ${flags.dir}`);
const files = [
  'services/sim2real-web/local-training-worker.mjs',
  'engines/starter-ppo/runner.py',
  'examples/starter-ppo-manifest.json',
  'examples/local-engine-reference.mjs',
  'package.json',
];
ssh(`mkdir -p ${flags.dir}/services/sim2real-web ${flags.dir}/engines/starter-ppo ${flags.dir}/examples`);
const sshShell = `ssh -p ${flags.port} -o BatchMode=yes -o ConnectTimeout=10`;
// --relative keeps each file's repository-relative subpath on the target,
// so runner.py lands at <dir>/engines/starter-ppo/runner.py (not flattened).
let synced =
  spawnSync(
    'rsync',
    [
      '-az',
      '--checksum',
      '--relative',
      '-e',
      sshShell,
      ...files.map((f) => path.join(repoRoot, f)),
      `${sshTarget}:${flags.dir}/`,
    ],
    { encoding: 'utf8', timeout: 180_000 },
  ).status === 0;
if (!synced) {
  // rsync may be unavailable on either side; scp each file to its subpath.
  for (const file of files) {
    ssh(`mkdir -p ${flags.dir}/$(dirname ${file})`);
    const scp = spawnSync(
      'scp',
      ['-P', flags.port, '-o', 'BatchMode=yes', path.join(repoRoot, file), `${sshTarget}:${flags.dir}/${file}`],
      { encoding: 'utf8', timeout: 120_000 },
    );
    if (scp.status !== 0) {
      console.error(scp.stderr || `scp failed for ${file}`);
      process.exit(1);
    }
  }
  synced = true;
}
console.log('  ✓ 已同步 worker + 引擎 + manifest');

// --- 3. python stack --------------------------------------------------------
step('安装/检查 Python 训练栈（venv + numpy/onnx + CUDA torch）');
const pySetup = ssh(
  `cd ${flags.dir} && ` +
  'if [ ! -x .venv/bin/python ]; then python3 -m venv .venv 2>/dev/null || python3 -m pip install --user virtualenv && python3 -m virtualenv .venv; fi && ' +
  '.venv/bin/python -m pip install -q --upgrade pip && ' +
  '.venv/bin/pip install -q numpy onnx && ' +
  // The PyPI "torch" wheel is CPU-only; a machine with an NVIDIA driver
  // needs the CUDA build or torch.cuda.is_available() stays false.
  '(if command -v nvidia-smi >/dev/null 2>&1; then ' +
  '.venv/bin/pip install -q torch --index-url https://download.pytorch.org/whl/cu128; ' +
  'else .venv/bin/pip install -q torch; fi) 2>&1 | tail -1 || true; ' +
  '.venv/bin/python -c "import numpy, torch; print(\\"stack-ok\\")"',
  { allowFail: true, timeout: 900_000 },
);
const stackOk = pySetup.stdout.includes('stack-ok');
if (!stackOk) {
  console.log('  ! Python 栈安装未完成（可稍后在服务器上手动运行: ~/rdk-sim2real/.venv/bin/pip install numpy onnx torch --index-url https://download.pytorch.org/whl/cu128）');
} else {
  console.log('  ✓ numpy + torch 就绪');
}

// --- 4. CUDA probe ----------------------------------------------------------
step('探测 CUDA GPU');
const cudaProbe = ssh(
  `cd ${flags.dir} && .venv/bin/python -c "import torch; print(torch.cuda.is_available() and torch.cuda.get_device_name(0) or \\"no-cuda\\")" 2>/dev/null || echo no-torch`,
  { allowFail: true },
);
const cudaName = cudaProbe.stdout.trim().split('\n').pop();
const hasCuda = cudaName !== 'no-cuda' && cudaName !== 'no-torch';
console.log(hasCuda ? `  ✓ ${cudaName} — 引擎将在 GPU 上训练（result.cuda=true）` : '  ✗ 未检测到 CUDA — 引擎会退回 CPU 并如实上报 cuda=false');

// --- 5. worker env ----------------------------------------------------------
step('生成 worker 环境文件（含随机 runner token）');
const token = randomBytes(24).toString('hex');
const workerEnv = [
  `RDK_SIM2REAL_LOCAL_WORKER_HOST=0.0.0.0`,
  `RDK_SIM2REAL_LOCAL_WORKER_PORT=19091`,
  `RDK_SIM2REAL_LOCAL_WORKER_DATA_DIR=${flags.dir}/worker-data`,
  `RDK_SIM2REAL_TRAIN_EXECUTABLE=${flags.dir}/.venv/bin/python`,
  `RDK_SIM2REAL_TRAIN_ARGS_JSON='["${flags.dir}/engines/starter-ppo/runner.py"]'`,
  `RDK_SIM2REAL_MAX_CONCURRENT_JOBS=1`,
  `RDK_SIM2REAL_LOCAL_RUNNER_TOKEN=${token}`,
  `RDK_STARTER_ENGINE_DEVICE=auto`,
]
  .filter(Boolean)
  .join('\n');
const heredoc = `cat > ${flags.dir}/worker.env <<'EOF'\n${workerEnv}\nEOF\nchmod 600 ${flags.dir}/worker.env`;
ssh(heredoc);
console.log(`  ✓ ${flags.dir}/worker.env（token=${token.slice(0, 6)}…已隐藏）`);

// --- 6. systemd (optional) --------------------------------------------------
if (flags.service) {
  step('安装并启动 systemd 服务 rdk-sim2real-worker');
  const unit = [
    '[Unit]',
    'Description=RDK Sim2Real GPU training worker',
    'After=network-online.target',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${flags.dir}`,
    `EnvironmentFile=${flags.dir}/worker.env`,
    `ExecStart=/usr/bin/env node ${flags.dir}/services/sim2real-web/local-training-worker.mjs`,
    'Restart=on-failure',
    'RestartSec=3',
    '[Install]',
    'WantedBy=default.target',
  ].join('\n');
  ssh(`mkdir -p ~/.config/systemd/user && cat > ~/.config/systemd/user/rdk-sim2real-worker.service <<'EOF'\n${unit}\nEOF\nsystemctl --user daemon-reload && systemctl --user enable --now rdk-sim2real-worker && systemctl --user is-active rdk-sim2real-worker`);
  console.log('  ✓ 服务已启动: systemctl --user status rdk-sim2real-worker');
} else {
  console.log('\n[gpu-deploy] 未指定 --service；手动启动方式：');
  console.log(`  ssh -p ${flags.port} ${sshTarget}`);
  console.log(`  cd ${flags.dir} && set -a && . ./worker.env && set +a && node services/sim2real-web/local-training-worker.mjs`);
}

// --- final wiring instructions ---------------------------------------------
console.log('\n[gpu-deploy] 部署完成。把下面两行加进本机 web 服务器的 .env 并重启：');
console.log(`  RDK_SIM2REAL_LOCAL_RUNNER_URL=http://${flags.host}:19091/train`);
console.log(`  RDK_SIM2REAL_LOCAL_RUNNER_TOKEN=${token}`);
console.log('\n注意: worker 监听 0.0.0.0:19091，token 是唯一防线；生产建议加防火墙/白名单或 SSH 隧道：');
console.log(`  ssh -p ${flags.port} -N -L 19091:127.0.0.1:19091 ${sshTarget}  # 然后用 http://127.0.0.1:19091/train`);
