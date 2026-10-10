#!/usr/bin/env node
// 部署组包补齐：Mac 上的 `npm ci --omit=dev` 只会安装 darwin 变体的平台专属
// 可选依赖（native addon），Linux 生产运行时 require 直接失败。真实事故：
// 2026-10-10 生产 DSH 聊天全挂——@deepseek-ai/node-addon-system-linux-x64
// 缺失（同批还有 ripgrep / sharp 的 linux 变体）。
//
// 本脚本从组包树根出发，沿 dependencies + optionalDependencies 边遍历已安装
// 的包；对缺失且 lockfile 标注 linux/x64 的可选依赖，用 npm pack 下载
// （sha512 对齐 lockfile）后解压进 node_modules。在 mac 组包机或 linux
// 服务器上执行均可。
//
// 用法：node scripts/reify-deployment-optional-deps.mjs --target <staging-dir> [--dry-run]

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const targetIndex = args.indexOf('--target');
if (targetIndex < 0 || !args[targetIndex + 1]) {
  console.error(
    '用法：node scripts/reify-deployment-optional-deps.mjs --target <staging-dir> [--dry-run]',
  );
  process.exit(2);
}
const target = resolve(args[targetIndex + 1]);
const modulesDir = join(target, 'node_modules');
const lockfile = JSON.parse(readFileSync(join(target, 'package-lock.json'), 'utf8'));
const lockEntry = (name) => lockfile.packages[`node_modules/${name}`];

const pkgDir = (name) => join(modulesDir, ...name.split('/'));
const installedVersion = (name) => {
  const file = join(pkgDir(name), 'package.json');
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8')).version;
};

const wanted = new Set();
const walked = new Set();
const stack = [];
const rootEntry = lockfile.packages[''] || {};
for (const name of Object.keys({ ...rootEntry.dependencies, ...rootEntry.optionalDependencies })) {
  if (installedVersion(name)) stack.push(name);
}
while (stack.length > 0) {
  const name = stack.pop();
  if (walked.has(name)) continue;
  walked.add(name);
  const entry = lockEntry(name);
  if (!entry) continue;
  const onDisk = installedVersion(name);
  if (!onDisk) {
    if (!(entry.os || []).includes('linux') || (entry.cpu && !entry.cpu.includes('x64'))) continue;
    wanted.add(name);
  }
  const manifest = onDisk
    ? JSON.parse(readFileSync(join(pkgDir(name), 'package.json'), 'utf8'))
    : entry;
  for (const child of Object.keys({
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
  })) {
    if (!lockEntry(child)) continue;
    if (installedVersion(child) || !wanted.has(child)) stack.push(child);
  }
}

// 手工解压不经过 npm reify：被补装包自身若声明普通依赖，必须确认已在树上。
for (const name of wanted) {
  for (const dep of Object.keys(lockEntry(name).dependencies || {})) {
    if (!installedVersion(dep)) {
      console.error(
        `FATAL: ${name} 的普通依赖 ${dep} 不在组包树中，手工补装会破坏布局；请先排查组包结果。`,
      );
      process.exit(1);
    }
  }
}

if (wanted.size === 0) {
  console.log('linux/x64 可选依赖无缺失。');
  process.exit(0);
}

const names = [...wanted].sort();
for (const name of names) {
  console.log(`缺失：${name}@${lockEntry(name).version}`);
}
if (dryRun) process.exit(0);

const work = mkdtempSync(join(tmpdir(), 'reify-addons.'));
try {
  for (const name of names) {
    const entry = lockEntry(name);
    execFileSync(
      'npm',
      ['pack', `${name}@${entry.version}`, '--pack-destination', work, '--loglevel=error'],
      { stdio: ['ignore', 'ignore', 'inherit'] },
    );
    const tgz = join(work, `${name.replace('@', '').replace('/', '-')}-${entry.version}.tgz`);
    const integrity = `sha512-${createHash('sha512').update(readFileSync(tgz)).digest('base64')}`;
    if (integrity !== entry.integrity) {
      throw new Error(`integrity mismatch for ${name}: ${integrity}`);
    }
    const extractDir = join(work, 'extract');
    rmSync(extractDir, { recursive: true, force: true });
    mkdirSync(extractDir, { recursive: true });
    execFileSync('tar', ['-xzf', tgz, '-C', extractDir]);
    cpSync(join(extractDir, 'package'), pkgDir(name), { recursive: true });
    console.log(`已补齐：${name}@${entry.version}（sha512 校验通过）`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
