#!/usr/bin/env node

/**
 * Starter-engine gate: proves the real PPO trainer behind `demo:starter`.
 *
 * With numpy + torch (+ onnx for export) available this runs a short but
 * genuine training round through the worker file protocol and asserts the
 * result contract. On machines without the Python stack (CI runners) it
 * prints SKIP and exits 0 so `npm run verify` stays green — the full
 * end-to-end local-run path is still covered by smoke:sim2real-local.
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const enginePath = path.join(repoRoot, 'engines/starter-ppo/runner.py');

function pythonInterpreter() {
  for (const candidate of [
    process.env.RDK_STARTER_ENGINE_PYTHON,
    'python3',
    '/usr/bin/python3',
    '/opt/homebrew/bin/python3.12',
    '/opt/homebrew/bin/python3.11',
  ]) {
    if (!candidate) continue;
    const probe = spawnSync(candidate, ['-c', 'import numpy, torch'], {
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
    '[starter-engine] SKIP — python3 with numpy+torch not found. ' +
      'Install with: python3 -m pip install --user numpy torch onnx',
  );
  process.exit(0);
}

const probeOnnx = spawnSync(python, ['-c', 'import onnx'], { encoding: 'utf8' });
if (probeOnnx.status !== 0) {
  console.log(
    '[starter-engine] SKIP — torch available but the onnx wheel is missing. ' +
      'Install with: python3 -m pip install --user onnx',
  );
  process.exit(0);
}

const scratch = await mkdtemp(path.join(os.tmpdir(), 'rdk-starter-engine-'));
try {
  const requestPath = path.join(scratch, 'request.json');
  const resultPath = path.join(scratch, 'result.json');
  await writeFile(
    requestPath,
    JSON.stringify(
      {
        schemaVersion: 1,
        contractId: 'rdk-duck-policy-starter-v1',
        contract: {
          id: 'rdk-duck-policy-starter-v1',
          robotId: 'rdk-duck',
          jointCount: 12,
          observationSize: 42,
          actionSize: 12,
          controlHz: 50,
          physicsTimestepSeconds: 0.002,
          decimation: 10,
        },
        model: { modelId: 'starter-ppo-gate', version: '0.1.0-gate' },
        training: { profile: 'smoke', numEnvs: 16, maxIterations: 20, video: false },
      },
      null,
      2,
    ),
  );

  const run = spawnSync(
    python,
    [enginePath],
    {
      cwd: scratch,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        RDK_SIM2REAL_REQUEST_FILE: requestPath,
        RDK_SIM2REAL_RESULT_FILE: resultPath,
        RDK_STARTER_ENGINE_ITERATIONS: '20',
        RDK_STARTER_ENGINE_ENVS: '16',
        RDK_STARTER_ENGINE_STEPS: '128',
      },
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  if (run.status !== 0) {
    console.error(run.stdout || '');
    console.error(run.stderr || '');
    throw new Error(`starter engine exited with ${run.status}`);
  }

  const result = JSON.parse(await readFile(resultPath, 'utf8'));
  assert.equal(result.deployable, false, 'a CPU starter policy must never claim board deployability');
  assert.equal(result.cuda, false);
  assert.ok(result.checkpoint.artifactRef.startsWith('artifact://starter/'), 'checkpoint reference');
  const artifact = result.artifact;
  assert.equal(artifact.kind, 'source');
  assert.equal(artifact.format, 'onnx');
  assert.equal(artifact.runtime, 'cpu-onnx');
  assert.equal(artifact.threads, 1);
  assert.equal(artifact.workload, 'locomotion');
  assert.ok(artifact.sizeBytes > 100, 'exported ONNX must be non-trivial');
  assert.equal(artifact.deployable, false);
  const metrics = result.metrics;
  assert.equal(metrics.contractValid, true);
  assert.equal(metrics.observationSize, 42);
  assert.equal(metrics.actionSize, 12);
  assert.equal(metrics.iterations, 20);
  assert.ok(metrics.onnxExported === true);
  assert.ok(Number.isFinite(metrics.reward));
  assert.ok(Number.isFinite(metrics.initialReward));
  assert.ok(metrics.telemetrySamples > 0, 'engine must export an evaluation trajectory');

  const onnxPath = path.join(scratch, 'policy.onnx');
  const onnxBytes = await readFile(onnxPath);
  assert.equal(onnxBytes.length, artifact.sizeBytes, 'sizeBytes must match the exported file');
  // ONNX protobuf magic: a real exported model file, not a stub.
  const header = onnxBytes.subarray(0, 8).toString('latin1');
  assert.ok(
    onnxBytes.length > 1024 && (header.includes('onnx') || header.charCodeAt(0) >= 8),
    'exported file must be an ONNX protobuf',
  );

  const telemetryPath = path.join(scratch, 'telemetry.jsonl');
  const telemetry = (await readFile(telemetryPath, 'utf8')).trim().split('\n');
  assert.ok(telemetry.length > 0, 'telemetry.jsonl must exist');
  const firstRow = JSON.parse(telemetry[0]);
  assert.equal(firstRow.observation.length, 42);
  assert.equal(firstRow.action.length, 12);
  assert.ok(typeof firstRow.t === 'number' && firstRow.t >= 0);

  console.log(
    `[starter-engine] PASS — real PPO trainer ran ${metrics.iterations} iterations ` +
      `(reward ${metrics.initialReward} -> ${metrics.reward}, ONNX ${artifact.sizeBytes} bytes, ` +
      `${telemetry.length} telemetry samples) via ${python}`,
  );
} finally {
  await rm(scratch, { recursive: true, force: true });
}
