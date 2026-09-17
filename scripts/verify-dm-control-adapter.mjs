#!/usr/bin/env node

/**
 * dm-control-adapter gate: proves the dm_control worker behind the adapter.
 *
 * With dm_control + mujoco + jax (+ onnx) available this runs a short but
 * genuine training round through the worker file protocol against the
 * originbot goal-navigation task pack and asserts the result contract,
 * including the honest physicsBackend="dm-control-mujoco" labeling
 * (DeepMind's env API driving CPU MuJoCo physics compiled from the shared
 * scene source) and the embedded taskEvaluation evidence. On machines
 * without the Python stack (CI runners) it prints SKIP and exits 0 so
 * `npm run verify` stays green.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const adapterPath = path.join(repoRoot, 'engines/dm-control-adapter/adapter.py');

function probe(python, code) {
  const out = spawnSync(python, ['-c', code], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return out.status === 0;
}

function pythonInterpreter() {
  const candidates = [
    process.env.RDK_DMC_ENGINE_PYTHON,
    // The shared engine venv (jax/mujoco/dm_control installed there)
    path.join(repoRoot, 'engines/mjx-adapter/.venv/bin/python'),
    process.env.RDK_STARTER_ENGINE_PYTHON,
    'python3',
    '/usr/bin/python3',
    '/opt/homebrew/bin/python3.12',
    '/opt/homebrew/bin/python3.11',
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (probe(candidate, 'import dm_control, mujoco, jax, optax, onnx')) {
      return candidate;
    }
  }
  return null;
}

const python = pythonInterpreter();
if (!python) {
  console.log(
    '[dm-control-adapter] SKIP — python with dm_control+mujoco+jax+optax+onnx not found. ' +
      'Install with: python3 -m pip install --user dm_control mujoco jax optax onnx',
  );
  process.exit(0);
}

const { resolveTaskPack, trainingRequestFor } = await import(
  path.join(repoRoot, 'scripts/resolve-task-pack.mjs')
);
const pack = resolveTaskPack('originbot-goal-navigation');

const scratch = await mkdtemp(path.join(os.tmpdir(), 'rdk-dmc-adapter-'));
try {
  const request = trainingRequestFor(pack, {
    profile: 'smoke',
    modelId: 'dm-control-adapter-gate',
    version: '0.1.0-gate',
  });
  const requestPath = path.join(scratch, 'request.json');
  const resultPath = path.join(scratch, 'result.json');
  await writeFile(requestPath, JSON.stringify(request, null, 2));
  const run = spawnSync(python, [adapterPath], {
    cwd: scratch,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      RDK_SIM2REAL_REQUEST_FILE: requestPath,
      RDK_SIM2REAL_RESULT_FILE: resultPath,
      RDK_DMC_ENGINE_ITERATIONS: '2',
      RDK_DMC_ENGINE_ENVS: '4',
      RDK_DMC_ENGINE_STEPS: '16',
    },
    maxBuffer: 4 * 1024 * 1024,
  });
  if (run.status !== 0) {
    console.error(run.stdout || '');
    console.error(run.stderr || '');
    throw new Error(`dm-control adapter exited with ${run.status}`);
  }
  const result = JSON.parse(await readFile(resultPath, 'utf8'));

  // ---- the honest-label contract -------------------------------------------
  assert.equal(result.deployable, false, 'adapter policies are never auto-deployable');
  assert.equal(result.physicsBackend, 'dm-control-mujoco');
  assert.equal(result.metrics.physicsBackend, 'dm-control-mujoco');
  assert.equal(result.metrics.engine, 'dm-control-ppo');
  assert.equal(result.artifact.format, 'onnx');
  assert.ok(result.artifact.sizeBytes > 100, 'ONNX actor must be non-trivial');
  assert.equal(result.artifact.deployable, false);
  assert.equal(result.metrics.contractValid, true);
  assert.ok(result.metrics.iterations === 2, 'iteration budget must be reported honestly');

  // The engine-side task evaluation is embedded so the TS release gate can
  // recompute the verdict from measured evidence.
  const taskEvaluation = result.taskEvaluation;
  assert.ok(taskEvaluation, 'taskEvaluation evidence must be embedded in the result');
  assert.ok(taskEvaluation.qualityGate, 'quality gate verdict must be present');
  assert.equal(taskEvaluation.taskId, 'originbot-goal-navigation');
  const nominal = taskEvaluation.trained?.envelopes?.nominal;
  assert.ok(nominal, 'nominal envelope metrics must be present');
  assert.ok(Number.isFinite(nominal.successRateCiLow), 'Wilson CI bounds must be recorded');
  assert.ok(nominal.successRateCiLow <= nominal.successRate, 'Wilson CI low must bracket the rate');
  assert.ok(
    nominal.successRateCiHigh >= nominal.successRate,
    'Wilson CI high must bracket the rate',
  );
  // 2 iterations must NOT pass a 0.7 gate — an honest gate fails closed on
  // insufficient evidence rather than reporting a lucky PASS.
  assert.equal(taskEvaluation.qualityGate.passed, false);

  // ---- artifacts on disk ----------------------------------------------------
  const onnxPath = path.join(scratch, 'policy.onnx');
  const onnxBytes = await readFile(onnxPath);
  assert.equal(onnxBytes.length, result.artifact.sizeBytes, 'sizeBytes must match the file');
  assert.ok(onnxBytes.length > 1024, 'exported file must be a real ONNX protobuf');

  const summary = JSON.parse(await readFile(path.join(scratch, 'training-summary.json'), 'utf8'));
  assert.equal(summary.physicsBackend, 'dm-control-mujoco');
  assert.equal(summary.engine, 'dm-control-ppo');
  assert.ok(summary.dmControlVersion, 'the dm_control version that produced the artifact');
  assert.ok(summary.controlHz > 0, 'control rate recorded');

  const sums = await readFile(path.join(scratch, 'SHA256SUMS'), 'utf8');
  assert.ok(sums.includes('policy.onnx'), 'integrity manifest covers the policy');
  assert.ok(sums.includes('training-summary.json'), 'manifest covers the summary');

  console.log(
    `[dm-control-adapter] PASS — JAX PPO trained ${result.metrics.iterations} iterations inside ` +
      `dm_control Environments over real CPU MuJoCo physics (physicsBackend=dm-control-mujoco, ` +
      `ONNX ${result.artifact.sizeBytes} bytes, ` +
      `gate ${result.taskEvaluation.qualityGate.passed ? 'PASS' : 'FAIL(honest)'} at smoke budget) ` +
      `via ${python}`,
  );
} finally {
  await rm(scratch, { recursive: true, force: true });
}
