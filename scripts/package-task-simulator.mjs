#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let output = path.join(root, 'dist/task-simulator');
for (let index = 2; index < process.argv.length; index++) {
  if (process.argv[index] === '--help') {
    console.log(
      'Usage: node scripts/package-task-simulator.mjs [--output directory]\nThe output must be empty; only reviewed runtime files are copied.',
    );
    process.exit(0);
  }
  if (
    process.argv[index] !== '--output' ||
    !process.argv[index + 1] ||
    process.argv[index + 1].startsWith('--')
  ) {
    console.error(`[task-simulator-package] Unknown or incomplete option: ${process.argv[index]}`);
    process.exit(1);
  }
  output = path.resolve(process.argv[++index]);
}

// Preserve the service's repository-relative imports without shipping training
// checkpoints, videos, private configuration, a virtualenv, or engine evidence.
const files = [
  'LICENSE',
  'scripts/start-task-simulator.mjs',
  'docs/simulation.md',
  ...[
    'app.py',
    'models.py',
    'task_simulation.py',
    'simulation_auth.py',
    'requirements.txt',
    'README.md',
  ].map((name) => `services/mujoco-web/${name}`),
  ...['app.js', 'lang.js', 'styles.css', 'index.html'].map(
    (name) => `services/mujoco-web/static/${name}`,
  ),
  'services/mujoco-web/registry/README.md',
  ...['__init__.py', 'originbot.py', 'calibration.json', 'README.md'].map(
    (name) => `assets/originbot/${name}`,
  ),
  ...[
    'proxy_common.py',
    'balance_env.py',
    'ballbalance_env.py',
    'ladder_env.py',
    'swing_env.py',
  ].map((name) => `engines/microduck-recurrent/${name}`),
  'engines/microduck-football/football_env.py',
].sort();

try {
  const existing = await stat(output).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (existing && (!existing.isDirectory() || (await readdir(output)).length)) {
    throw new Error(
      'Output already exists and is not an empty directory; choose a new --output directory',
    );
  }
  // Validate inputs before creating a partial release.
  const contents = await Promise.all(
    files.map(async (name) => ({ name, bytes: await readFile(path.join(root, name)) })),
  );
  await mkdir(output, { recursive: true });
  const manifest = [];
  for (const { name, bytes } of contents) {
    const destination = path.join(output, name);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
    manifest.push({
      path: name,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  const payloadSha256 = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
  await writeFile(
    path.join(output, 'task-simulator-manifest.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        sourceCommit: revision.status === 0 ? revision.stdout.trim() : null,
        payloadSha256,
        files: manifest,
      },
      null,
      2,
    )}\n`,
  );
  console.log(JSON.stringify({ ok: true, output, fileCount: files.length, payloadSha256 }));
} catch (error) {
  console.error(`[task-simulator-package] ${error.message}`);
  process.exitCode = 1;
}
