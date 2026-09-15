#!/usr/bin/env node

/**
 * mjx-adapter gate: proves the pure-JAX MJX worker behind the adapter.
 *
 * With jax + mujoco + mujoco-mjx + optax (+ onnx) available this runs a
 * short but genuine training round through the worker file protocol
 * against the originbot goal-navigation task pack and asserts the result
 * contract, including the honest physicsBackend="mjx" labeling (real
 * MuJoCo contact dynamics on the MJX backend) and the embedded
 * taskEvaluation evidence. A second forced-fallback run
 * (RDK_MJX_ADAPTER_FORCE_MJX=0) asserts the kinematic fallback is
 * labeled "starter-kinematic" — skipped honestly when torch is absent.
 * On machines without the Python stack (CI runners) it prints SKIP and
 * exits 0 so `npm run verify` stays green.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const adapterPath = path.join(repoRoot, 'engines/mjx-adapter/adapter.py');

function probe(python, code) {
  const out = spawnSync(python, ['-c', code], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return out.status === 0;
}

function pythonInterpreter() {
  const candidates = [
    process.env.RDK_MJX_ENGINE_PYTHON,
    // The adapter's checked-in local venv (jax/mujoco-mjx installed there)
    path.join(repoRoot, 'engines/mjx-adapter/.venv/bin/python'),
    process.env.RDK_STARTER_ENGINE_PYTHON,
    'python3',
    '/usr/bin/python3',
    '/opt/homebrew/bin/python3.12',
    '/opt/homebrew/bin/python3.11',
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (probe(candidate, 'import jax, mujoco, mujoco.mjx, optax, onnx')) {
      return candidate;
    }
  }
  return null;
}

const python = pythonInterpreter();
if (!python) {
  console.log(
    '[mjx-adapter] SKIP — python with jax+mujoco+mujoco-mjx+optax+onnx not found. ' +
      'Install with: python3 -m pip install --user jax mujoco mujoco-mjx optax onnx',
  );
  process.exit(0);
}

const { resolveTaskPack, trainingRequestFor } = await import(
  path.join(repoRoot, 'scripts/resolve-task-pack.mjs')
);
const pack = resolveTaskPack('originbot-goal-navigation');

async function runAdapter(scratch, { forceFallback }) {
  const request = trainingRequestFor(pack, {
    profile: 'smoke',
    modelId: forceFallback ? 'mjx-adapter-fallback-gate' : 'mjx-adapter-gate',
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
      RDK_MJX_ENGINE_ITERATIONS: '2',
      RDK_MJX_ENGINE_ENVS: '4',
      RDK_MJX_ENGINE_STEPS: '16',
      RDK_STARTER_ENGINE_DEVICE: 'cpu',
      ...(forceFallback ? { RDK_MJX_ADAPTER_FORCE_MJX: '0' } : {}),
    },
    maxBuffer: 4 * 1024 * 1024,
  });
  if (run.status !== 0) {
    console.error(run.stdout || '');
    console.error(run.stderr || '');
    throw new Error(`mjx adapter exited with ${run.status}`);
  }
  return JSON.parse(await readFile(resultPath, 'utf8'));
}

function assertResultContract(result, expectedBackend) {
  assert.equal(result.deployable, false, 'adapter policies are never auto-deployable');
  // Honest backend labeling: the run must say which physics actually
  // trained the policy — real MJX contact dynamics vs the starter
  // kinematic fallback — in both the top-level field and metrics.
  assert.equal(result.physicsBackend, expectedBackend);
  assert.equal(result.metrics.physicsBackend, expectedBackend);
  assert.equal(result.metrics.engine, 'mjx-ppo');
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
}

// ---- run 1: the real MJX path ------------------------------------------------
const scratch = await mkdtemp(path.join(os.tmpdir(), 'rdk-mjx-adapter-'));
try {
  const result = await runAdapter(scratch, { forceFallback: false });
  assertResultContract(result, 'mjx');

  const onnxPath = path.join(scratch, 'policy.onnx');
  const onnxBytes = await readFile(onnxPath);
  assert.equal(onnxBytes.length, result.artifact.sizeBytes, 'sizeBytes must match the file');
  assert.ok(onnxBytes.length > 1024, 'exported file must be a real ONNX protobuf');

  const evalReport = JSON.parse(await readFile(path.join(scratch, 'eval-report.json'), 'utf8'));
  assert.equal(evalReport.taskId, 'originbot-goal-navigation');
  assert.equal(evalReport.physicsBackend, 'mjx');
  assert.ok(evalReport.qualityGate, 'eval-report carries the gate verdict');
  const summary = JSON.parse(await readFile(path.join(scratch, 'training-summary.json'), 'utf8'));
  assert.equal(summary.physicsBackend, 'mjx');
  assert.equal(summary.engine, 'mjx-ppo');
  // The adapter caps the physics timestep (probe: at 0.02 MJX contact
  // solver injects energy into this stance) and derives decimation so
  // decimation * physics_dt == control period. Assert the honesty of what
  // actually ran.
  assert.ok(summary.physicsTimestepSeconds <= 0.01, 'physics timestep must be capped at 0.01');
  assert.equal(
    Number((summary.decimation * summary.physicsTimestepSeconds).toFixed(6)),
    Number((1 / summary.controlHz).toFixed(6)),
    'decimation * physics_dt must equal the control period',
  );

  console.log(
    `[mjx-adapter] PASS — pure-JAX PPO trained ${result.metrics.iterations} iterations on ` +
      `real MuJoCo physics via MJX (physicsBackend=mjx, ONNX ${result.artifact.sizeBytes} bytes, ` +
      `gate ${result.taskEvaluation.qualityGate.passed ? 'PASS' : 'FAIL(honest)'} at smoke budget, ` +
      `dt=${summary.physicsTimestepSeconds} decim=${summary.decimation}) via ${python}`,
  );
} finally {
  await rm(scratch, { recursive: true, force: true });
}

// ---- run 2: forced kinematic fallback ---------------------------------------
if (probe(python, 'import torch')) {
  const scratch2 = await mkdtemp(path.join(os.tmpdir(), 'rdk-mjx-fallback-'));
  try {
    const result = await runAdapter(scratch2, { forceFallback: true });
    assertResultContract(result, 'starter-kinematic');
    const summary = JSON.parse(
      await readFile(path.join(scratch2, 'training-summary.json'), 'utf8'),
    );
    assert.equal(summary.physicsBackend, 'starter-kinematic');
    console.log(
      '[mjx-adapter] PASS — forced fallback is honestly labeled starter-kinematic ' +
        `(same learner, starter GoalNavEnv physics)`,
    );
  } finally {
    await rm(scratch2, { recursive: true, force: true });
  }
} else {
  console.log(
    '[mjx-adapter] SKIP fallback run — torch not installed for this interpreter; ' +
      'the forced-fallback path is covered by test_mjx_adapter.py where torch exists',
  );
}
