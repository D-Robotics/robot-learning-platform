#!/usr/bin/env node

/**
 * mjlab-rsl-rl adapter gate: proves the rsl_rl worker behind the adapter.
 *
 * With rsl-rl-lib==2.2.3 (+ numpy/torch/onnx) available this runs a short
 * but genuine training round through the worker file protocol against the
 * originbot goal-navigation task pack and asserts the result contract,
 * including the honest physicsBackend labeling and the embedded
 * taskEvaluation evidence. On machines without the Python stack (CI
 * runners) it prints SKIP and exits 0 so `npm run verify` stays green.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const adapterPath = path.join(repoRoot, 'engines/mjlab-rsl-rl-adapter/adapter.py');

function pythonInterpreter() {
  for (const candidate of [
    process.env.RDK_STARTER_ENGINE_PYTHON,
    'python3',
    '/usr/bin/python3',
    '/opt/homebrew/bin/python3.12',
    '/opt/homebrew/bin/python3.11',
  ]) {
    if (!candidate) continue;
    const probe = spawnSync(candidate, ['-c', 'import numpy, torch, rsl_rl, onnx'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (probe.status === 0) return candidate;
  }
  return null;
}

const python = pythonInterpreter();
if (!python) {
  console.log(
    '[mjlab-adapter] SKIP — python3 with numpy+torch+rsl_rl+onnx not found. ' +
      'Install with: python3 -m pip install --user numpy torch onnx rsl-rl-lib==2.2.3',
  );
  process.exit(0);
}

const { resolveTaskPack, trainingRequestFor } = await import(
  path.join(repoRoot, 'scripts/resolve-task-pack.mjs')
);
const pack = resolveTaskPack('originbot-goal-navigation');
const request = trainingRequestFor(pack, {
  profile: 'smoke',
  modelId: 'rsl-rl-adapter-gate',
  version: '0.1.0-gate',
});

const scratch = await mkdtemp(path.join(os.tmpdir(), 'rdk-mjlab-adapter-'));
try {
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
      RDK_STARTER_ENGINE_ITERATIONS: '2',
      RDK_STARTER_ENGINE_ENVS: '4',
      RDK_STARTER_ENGINE_STEPS: '16',
      RDK_STARTER_ENGINE_DEVICE: 'cpu',
      RDK_RSL_ADAPTER_FORCE_MJLAB: '0',
    },
    maxBuffer: 4 * 1024 * 1024,
  });
  if (run.status !== 0) {
    console.error(run.stdout || '');
    console.error(run.stderr || '');
    throw new Error(`rsl-rl adapter exited with ${run.status}`);
  }

  const result = JSON.parse(await readFile(resultPath, 'utf8'));
  assert.equal(result.deployable, false, 'adapter policies are never auto-deployable');
  // Honest backend labeling: without mjlab installed the run must say it
  // trained on the kinematic fallback, never claim mjlab.
  assert.equal(result.physicsBackend, 'starter-kinematic');
  assert.equal(result.metrics.physicsBackend, 'starter-kinematic');
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
  // 2 iterations must NOT pass a 0.7 gate — an honest gate fails closed on
  // insufficient evidence rather than reporting a lucky PASS.
  assert.equal(taskEvaluation.qualityGate.passed, false);

  const onnxPath = path.join(scratch, 'policy.onnx');
  const onnxBytes = await readFile(onnxPath);
  assert.equal(onnxBytes.length, result.artifact.sizeBytes, 'sizeBytes must match the file');
  assert.ok(onnxBytes.length > 1024, 'exported file must be a real ONNX protobuf');

  const evalReport = JSON.parse(await readFile(path.join(scratch, 'eval-report.json'), 'utf8'));
  assert.equal(evalReport.taskId, 'originbot-goal-navigation');
  assert.ok(evalReport.qualityGate, 'eval-report carries the gate verdict');
  const summary = JSON.parse(await readFile(path.join(scratch, 'training-summary.json'), 'utf8'));
  assert.equal(summary.physicsBackend, 'starter-kinematic');

  console.log(
    `[mjlab-adapter] PASS — rsl_rl OnPolicyRunner trained ${result.metrics.iterations} iterations ` +
      `on the starter-kinematic backend (ONNX ${result.artifact.sizeBytes} bytes, ` +
      `gate ${taskEvaluation.qualityGate.passed ? 'PASS' : 'FAIL(honest)'} at smoke budget) via ${python}`,
  );
} finally {
  await rm(scratch, { recursive: true, force: true });
}
