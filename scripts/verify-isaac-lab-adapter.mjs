#!/usr/bin/env node

/**
 * isaac-lab adapter gate: pins the upstream-driving contract without an
 * Isaac Lab installation.
 *
 * This script never trains: it proves the declarative pack resolves into the
 * tutorial's contract (78D frame x 10-frame history = 780D input, 23 joint
 * actions), that the adapter source keeps its honesty rules, and that the
 * adapter process REFUSES (exit 3, no result file, no fallback) on a host
 * without RDK_ISAAC_LAB_ROOT. The full train → play → sim2sim path runs only
 * on a GPU host with a real workspace (see engines/isaac-lab-adapter/README.md).
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const adapterPath = path.join(repoRoot, 'engines/isaac-lab-adapter/adapter.py');

// ---- declarative contract --------------------------------------------------

const { resolveTaskPack, trainingRequestFor } = await import(
  path.join(repoRoot, 'scripts/resolve-task-pack.mjs')
);
const pack = resolveTaskPack('isaac-origin-rpo-flat');
assert.equal(pack.recommendedEngine, 'isaac-lab', 'pack must pin the isaac-lab engine');
assert.equal(pack.kind, 'isaac-upstream', 'upstream packs declare their own kind');
assert.ok(pack.isaacTask?.upstreamTaskId, 'upstream task id must be declared');
assert.ok(pack.isaacTask?.train, 'upstream train script must be declared');
assert.ok(Array.isArray(pack.isaacTask?.jointOrderMapping), 'joint order mapping must be recorded');

// The tutorial's stacking arithmetic: 78D frame, 10-frame history, 780D input.
assert.equal(pack.adapter.policy.observationSize, 78, 'single-frame observation size');
assert.equal(pack.adapter.policy.observationHistory.frames, 10, 'history frames');
assert.equal(pack.adapter.policy.observationHistory.order, 'oldest-first', 'concat order');
assert.equal(pack.adapter.policy.actionSize, 23, 'joint action size');

const request = trainingRequestFor(pack, {
  profile: 'smoke',
  modelId: 'isaac-gate',
  version: '0.0.0-gate',
});
assert.equal(request.contract.observationSize, 780, 'contract flat input = 78 x 10');
assert.equal(request.contract.actionSize, 23);
assert.equal(request.contract.observationLayout.length, 10, 'one layout entry per stacked frame');
assert.equal(
  request.contract.observationLayout.reduce((sum, item) => sum + item.size, 0),
  780,
  'layout entries must sum to the flat input width',
);
assert.deepEqual(
  request.contract.observationHistory,
  { frames: 10, order: 'oldest-first' },
  'contract carries the stacking declaration',
);

// ---- adapter source keeps its honesty rules --------------------------------

const source = await readFile(adapterPath, 'utf8');
assert.match(source, /PHYSICS_BACKEND = "isaac-lab"/, 'backend label is pinned');
assert.match(source, /EXIT_MISSING_STACK = 3/, 'missing-stack refusal is exit 3');
assert.match(source, /"deployable": False/, 'artifacts are never deployable');
assert.match(source, /fabricated completed run/, 'the honesty promise stays');
assert.match(source, /sim2simPassed/, 'sim2sim evidence reaches the result metrics');

// ---- process behavior: refusal without the upstream stack ------------------

const scratch = await mkdtemp(path.join(os.tmpdir(), 'rdk-isaac-adapter-'));
try {
  const requestPath = path.join(scratch, 'request.json');
  const resultPath = path.join(scratch, 'result.json');
  await writeFile(requestPath, JSON.stringify(request));

  const baseEnv = {
    ...process.env,
    RDK_SIM2REAL_REQUEST_FILE: requestPath,
    RDK_SIM2REAL_RESULT_FILE: resultPath,
    RDK_SIM2REAL_JOB_DIR: scratch,
  };
  delete baseEnv.RDK_ISAAC_LAB_ROOT;
  delete baseEnv.RDK_ISAAC_LAB_DIR;

  const refused = spawnSync('python3', [adapterPath], {
    cwd: scratch,
    encoding: 'utf8',
    env: baseEnv,
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(refused.status, 3, 'without a workspace the adapter must exit 3');
  const refusedText = `${refused.stderr}\n${refused.stdout}`;
  assert.match(refusedText, /REFUSED/, 'refusal must be loud');
  assert.match(refusedText, /RDK_ISAAC_LAB_ROOT/, 'refusal must name the missing variable');
  assert.match(refusedText, /IsaacLab/, 'refusal must carry deployment instructions');
  assert.equal(
    existsSync(resultPath),
    false,
    'no result file may exist for a refused run — no fabricated completions',
  );

  // A configured-but-invalid workspace refuses the same way: pointing the
  // variable at a directory without isaaclab.sh is not an installation.
  const fakeRoot = path.join(scratch, 'fake-isaaclab');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(fakeRoot, { recursive: true });
  const invalidRoot = spawnSync('python3', [adapterPath], {
    cwd: scratch,
    encoding: 'utf8',
    env: { ...baseEnv, RDK_ISAAC_LAB_ROOT: fakeRoot },
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(invalidRoot.status, 3, 'a workspace without isaaclab.sh must still exit 3');

  // Missing protocol files are a caller bug (exit 2), not a missing stack.
  const noProtocol = spawnSync('python3', [adapterPath], {
    cwd: scratch,
    encoding: 'utf8',
    env: { RDK_SIM2REAL_REQUEST_FILE: '', RDK_SIM2REAL_RESULT_FILE: '' },
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(noProtocol.status, 2, 'missing worker protocol files must exit 2');

  console.log(
    '[isaac-adapter] PASS — RPO pack resolves to the 780D/23D tutorial contract; ' +
      'adapter refuses honestly (exit 3) without an Isaac Lab workspace',
  );
} finally {
  await rm(scratch, { recursive: true, force: true });
}
