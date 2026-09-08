#!/usr/bin/env node

/**
 * `npm run doctor` — one-shot environment health check.
 *
 * Probes everything `demo:starter` / `verify` depend on and prints an
 * actionable table. Pure diagnostics: no files are written, no services
 * started, no state changed. Exit code 0 when every REQUIRED check passes
 * (or is legitimately absent, e.g. CI without a Python stack); exit 1 when
 * something that must work does not.
 */

import { spawnSync } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const REQUIRED = 'required';
const OPTIONAL = 'optional';

const checks = [];

function record(name, level, status, detail, hint) {
  checks.push({ name, level, status, detail, hint });
}

function probe(command, args) {
  return spawnSync(command, args, { encoding: 'utf8', timeout: 20_000 });
}

function probePython(python) {
  return {
    numpy: probe(python, ['-c', 'import numpy; print(numpy.__version__)']),
    torch: probe(python, ['-c', 'import torch; print(torch.__version__)']),
    onnx: probe(python, ['-c', 'import onnx; print(onnx.__version__)']),
    cuda: probe(python, [
      '-c',
      'import torch; print(torch.cuda.is_available() and torch.cuda.get_device_name(0) or "no")',
    ]),
  };
}

// --- Node runtime -----------------------------------------------------------
const nodeMajor = Number(process.versions.node.split('.')[0]);
record(
  'Node.js',
  REQUIRED,
  nodeMajor >= 20 ? 'ok' : 'fail',
  process.version + (nodeMajor >= 20 ? '' : ' (需要 20 或 22)'),
  '安装 Node 20/22：brew install node@22 或使用 nvm',
);

// --- npm dependencies -------------------------------------------------------
const nodeModulesOk = await access(path.resolve('node_modules'), constants.F_OK)
  .then(() => true)
  .catch(() => false);
record(
  'npm 依赖',
  REQUIRED,
  nodeModulesOk ? 'ok' : 'fail',
  nodeModulesOk ? 'node_modules 已安装' : '未安装（npm run verify / test 无法运行）',
  'npm ci',
);

// --- Python training stack --------------------------------------------------
const pythonCandidates = [
  ...[process.env.RDK_STARTER_ENGINE_PYTHON].filter(Boolean),
  'python3',
  '/usr/bin/python3',
  '/opt/homebrew/bin/python3.12',
  '/opt/homebrew/bin/python3.11',
];
let pythonFound = null;
let pythonProbes = null;
for (const candidate of pythonCandidates) {
  if (!candidate) continue;
  const version = probe(candidate, ['--version']);
  if (version.status === 0) {
    pythonFound = candidate;
    pythonProbes = probePython(candidate);
    break;
  }
}
if (pythonFound) {
  const stackOk = pythonProbes.numpy.status === 0 && pythonProbes.torch.status === 0;
  const onnxOk = pythonProbes.onnx.status === 0;
  const cudaName =
    pythonProbes.cuda.status === 0 && pythonProbes.cuda.stdout.trim() !== 'no'
      ? pythonProbes.cuda.stdout.trim()
      : null;
  record(
    'Python 训练栈',
    REQUIRED,
    stackOk ? 'ok' : 'warn',
    pythonFound +
      ' (' +
      (probe(pythonFound, ['--version']).stdout || '').trim() +
      ') · numpy ' +
      (pythonProbes.numpy.status === 0 ? pythonProbes.numpy.stdout.trim() : '缺失') +
      ' · torch ' +
      (pythonProbes.torch.status === 0 ? pythonProbes.torch.stdout.trim() : '缺失'),
    stackOk
      ? null
      : 'python3 -m pip install --user numpy torch（starter-ppo 真实训练需要）',
  );
  record(
    'ONNX 导出',
    REQUIRED,
    onnxOk ? 'ok' : 'warn',
    onnxOk ? 'onnx ' + pythonProbes.onnx.stdout.trim() : 'onnx wheel 缺失，引擎将跳过导出',
    onnxOk ? null : 'python3 -m pip install --user onnx',
  );
  record(
    'CUDA GPU',
    OPTIONAL,
    cudaName ? 'ok' : 'skip',
    cudaName || '未检测到 CUDA（starter-ppo 将在 CPU 上训练，功能完整但较慢）',
    cudaName ? null : '如需加速可设置 RDK_STARTER_ENGINE_DEVICE=cuda 并安装 CUDA 版 torch',
  );
} else {
  record(
    'Python 训练栈',
    REQUIRED,
    'warn',
    '未找到 python3（demo:starter 真实训练路径不可用，仅 demo:sim2real 协议演示可跑）',
    'brew install python@3.12 && python3 -m pip install --user numpy torch onnx',
  );
}

// --- Port availability ------------------------------------------------------
const portProbes = [
  ['Web 控制台 18102', 18102],
  ['本地 worker 55774', 55774],
];
for (const [label, port] of portProbes) {
  const busy = probe('nc', ['-z', '127.0.0.1', String(port)]).status === 0;
  record(
    label,
    OPTIONAL,
    busy ? 'warn' : 'ok',
    busy ? '端口已被占用（若已有服务在跑属正常；新起 demo 会换随机端口）' : '空闲',
    busy ? '若要固定端口先停掉占用进程：lsof -ti:' + port : null,
  );
}

// --- Ledger state -----------------------------------------------------------
const ledgerPath = process.env.RDK_SIM2REAL_LEDGER_PATH;
record(
  '运行台账',
  OPTIONAL,
  'ok',
  ledgerPath ? '自定义位置 ' + ledgerPath : '默认位置 data/sim2real-ledger.json（demo 使用临时台账）',
  null,
);

// --- Git tree cleanliness (informational) -----------------------------------
const gitStatus = probe('git', ['status', '--porcelain']);
if (gitStatus.status === 0) {
  const dirty = gitStatus.stdout.trim().split('\n').filter(Boolean).length;
  record(
    'Git 工作区',
    OPTIONAL,
    dirty === 0 ? 'ok' : 'warn',
    dirty === 0 ? '干净' : `有 ${dirty} 个未提交变更（不影响运行）`,
    null,
  );
}

// --- Report -----------------------------------------------------------------
const statusIcon = { ok: '✓', warn: '!', fail: '✗', skip: '-' };
const statusColor = { ok: '\x1b[32m', warn: '\x1b[33m', fail: '\x1b[31m', skip: '\x1b[90m' };
const reset = '\x1b[0m';
const plain = process.env.NO_COLOR === '1';

console.log('\nRDK Sim2Real 平台环境体检 (doctor)');
console.log('平台: ' + os.type() + ' ' + os.release() + ' · ' + os.cpus()[0].model.trim() + '\n');
for (const check of checks) {
  const icon = statusIcon[check.status];
  const color = plain ? '' : statusColor[check.status] || '';
  const level = check.level === REQUIRED ? '' : ' (可选)';
  console.log(
    `  ${color}${icon}${reset} ${check.name}${level} — ${check.detail}`,
  );
  if (check.hint && check.status !== 'ok') console.log(`      ↳ ${check.hint}`);
}
const failed = checks.filter((c) => c.status === 'fail').length;
const warned = checks.filter((c) => c.status === 'warn').length;
console.log(
  `\n结论: ${failed === 0 ? '可以运行' : '存在阻塞项'} · ${failed} 个失败 / ${warned} 个提醒\n`,
);
if (failed > 0) {
  console.log('按上面每条的 ↳ 提示处理后重新运行 npm run doctor。');
  process.exit(1);
}
if (warned > 0) {
  console.log('提醒项不阻塞，但建议处理以获得完整体验（真实训练 / GPU 加速）。');
}
console.log('下一步: npm run demo:starter（真实 PPO 训练闭环）或 npm run demo:sim2real（协议演示）。\n');
