#!/usr/bin/env node
// This gate deliberately requires caller-owned assets: no proxy fallback.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const python = process.env.RDK_ORIGINMAN_PYTHON || 'python3';
if (!process.env.ORIGINMAN_MODEL_SOURCE) {
  console.error(
    'ORIGINMAN_MODEL_SOURCE is required; provide the original ZIP or package directory.',
  );
  process.exit(2);
}
const p = spawnSync(
  python,
  ['-m', 'pytest', path.join(root, 'engines/originman-straight/tests'), '-q'],
  { cwd: root, stdio: 'inherit', env: process.env },
);
process.exit(p.status ?? 1);
