#!/usr/bin/env node

/** First-run setup for a fresh checkout. It never overwrites operator config. */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const args = new Set(process.argv.slice(2));
const nvmrc = fs.readFileSync(path.join(root, '.nvmrc'), 'utf8').trim();
const envPath = path.join(root, '.env');

function run(command, commandArgs, options = {}) {
  return spawnSync(command, commandArgs, {
    cwd: root,
    encoding: 'utf8',
    stdio: 'inherit',
    ...options,
  });
}

function supportedNode(version) {
  const [major, minor, patch] = version.split('.').map(Number);
  return (
    Number.isInteger(major) &&
    Number.isInteger(minor) &&
    Number.isInteger(patch) &&
    ((major === 22 && (minor > 22 || (minor === 22 && patch >= 2))) ||
      (major === 24 && (minor > 15 || (minor === 15 && patch >= 0))) ||
      major >= 26)
  );
}

function pythonProbe(python) {
  const result = spawnSync(python, ['-c', 'import numpy, torch, onnx; print("ok")'], {
    encoding: 'utf8',
  });
  return result.status === 0;
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

section('RDK 平台首次启动');
console.log(`当前 Node: ${process.version} · 推荐 .nvmrc: ${nvmrc}`);
if (!supportedNode(process.versions.node)) {
  console.error('当前 Node 不在支持范围，先切换运行时再继续：');
  console.error(`  nvm install ${nvmrc} && nvm use ${nvmrc}`);
  console.error(
    '没有 nvm 时：brew install nvm，然后按 nvm 官方提示加载 shell；Linux 也建议使用 nvm。',
  );
  console.error('切换后重新执行：npm run setup');
  process.exitCode = 2;
  process.exit();
}

if (!fs.existsSync(envPath)) {
  fs.copyFileSync(path.join(root, '.env.example'), envPath);
  console.log('已创建 .env（来自 .env.example，后续不会覆盖）。');
} else {
  console.log('.env 已存在，保留现有配置。');
}

const nodeModules = fs.existsSync(path.join(root, 'node_modules'));
if (!nodeModules) {
  console.log('npm 依赖尚未安装。运行 `npm ci`，或执行 `npm run setup -- --install` 自动安装。');
  if (args.has('--install')) {
    const result = run('npm', ['ci']);
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
} else console.log('npm 依赖已就绪。');

const python = process.env.RDK_STARTER_ENGINE_PYTHON || 'python3';
const pythonReady =
  spawnSync(python, ['--version'], { encoding: 'utf8' }).status === 0 && pythonProbe(python);
if (pythonReady) {
  console.log(`Python CPU 训练栈已就绪（${python}）。`);
} else {
  console.log('Python 训练依赖未齐；Mock 演示不受影响。需要真实 CPU PPO 时：');
  console.log(
    '  python3 -m venv .venv && .venv/bin/python -m pip install -r engines/starter-ppo/requirements.txt',
  );
  console.log('  export RDK_STARTER_ENGINE_PYTHON="$PWD/.venv/bin/python"');
  if (args.has('--install-python')) {
    const result = run('python3', ['-m', 'venv', '.venv']);
    if (result.status === 0)
      run('.venv/bin/python', [
        '-m',
        'pip',
        'install',
        '-r',
        'engines/starter-ppo/requirements.txt',
      ]);
  }
}

section('可以开始');
console.log('  npm start                         # 浏览器 Mock 闭环（无需真机/CUDA）');
console.log('  npm run demo:starter               # CPU 真 PPO（需 Python 依赖）');
console.log('  npm run doctor                     # 环境体检与修复提示');
console.log('  npm run demo:preflight             # 真机接入前只读预检');
console.log('真机、CUDA、Linux systemd、PostgreSQL/对象存储的接入步骤见 docs/first-run.md。');
