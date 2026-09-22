#!/usr/bin/env node
/**
 * Entry-contract checker: keeps AGENTS.md honest by machine.
 *
 * AGENTS.md is the 90-second navigation contract for every developer and
 * coding agent entering this repo. Navigation that lies is worse than no
 * navigation, so this guard verifies, mechanically:
 *
 *   1. every relative markdown link in AGENTS.md resolves to a real file;
 *   2. every `npm run <script>` command inside AGENTS.md fenced code blocks
 *      exists in package.json scripts;
 *   3. every `node <path>` invocation inside fenced code blocks points at a
 *      file that exists.
 *
 * Run: node scripts/check-entry-contract.mjs   (wired into .githooks/pre-commit
 * whenever AGENTS.md / docs / package.json are staged).
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ENTRY = path.join(ROOT, 'AGENTS.md');

const problems = [];

const source = readFileSync(ENTRY, 'utf8');

// ---- 1. relative markdown links must resolve ----
const linkPattern = /\[[^\]]+\]\((\.[^)]+)\)/g;
for (const match of source.matchAll(linkPattern)) {
  const target = path.resolve(ROOT, match[1].split('#')[0]);
  if (!existsSync(target))
    problems.push(`dead link: ${match[1]} -> ${path.relative(ROOT, target)} 不存在`);
}

// ---- 2+3. commands in fenced code blocks must be real ----
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const scripts = pkg.scripts ?? {};
const fenced = [...source.matchAll(/```(?:bash|sh)?\n([\s\S]*?)```/g)].map((m) => m[1]);
for (const block of fenced) {
  for (const raw of block.split('\n')) {
    const line = raw
      .trim()
      .replace(/^#\s*\S.*$/, '')
      .trim();
    if (!line || line.startsWith('#')) continue;
    const npmRun = line.match(/^(?:npm run|yarn run)\s+([^\s]+)$/);
    if (npmRun) {
      const script = npmRun[1];
      if (!(script in scripts))
        problems.push(`dead command: npm run ${script} 不在 package.json scripts 中`);
      continue;
    }
    const nodeFile = line.match(/^node\s+([^\s]+\.mjs)$/);
    if (nodeFile) {
      const target = path.resolve(ROOT, nodeFile[1]);
      if (!existsSync(target)) problems.push(`dead file: node ${nodeFile[1]} 不存在`);
    }
  }
}

if (problems.length) {
  console.error('AGENTS.md 入口契约校验失败：');
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error('修正 AGENTS.md 或同步移动对应文件/脚本——导航文档说谎比没有导航更糟。');
  process.exit(1);
}
console.log('entry-contract: ok — AGENTS.md 链接与命令全部可达');
