#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!process.env.ORIGINMAN_SCENE) {
  console.error('ORIGINMAN_SCENE required; no synthetic replacement model is used');
  process.exit(2);
}
const result = spawnSync(
  process.env.RDK_ORIGINMAN_PYTHON || 'python3',
  ['-m', 'pytest', path.join(root, 'engines/originman-kick/tests'), '-q'],
  { cwd: root, env: process.env, stdio: 'inherit' },
);
process.exit(result.status ?? 1);
