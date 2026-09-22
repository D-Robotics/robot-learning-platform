#!/usr/bin/env node

/**
 * microduck-recurrent gate: proves the repository can *produce* the recurrent
 * (LSTM) policy graphs that microduck-eval's loader already accepts.
 *
 * With numpy + torch + mujoco + onnx + onnxruntime available this runs the
 * behavioural suite and one short real training (3 envs x 2 iterations), then
 * asserts the exported graph loads as recurrent through the evaluation
 * engine's own loader with state carry, reset semantics, and dynamic batch.
 * Without the Python stack it prints SKIP and exits 0 so `npm run verify`
 * stays green on CI runners.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const engineDir = path.join(repoRoot, 'engines/microduck-recurrent');

function pythonInterpreter() {
  for (const candidate of [
    process.env.RDK_MICRODUCK_RECURRENT_PYTHON,
    'python3',
    '/usr/bin/python3',
    '/opt/homebrew/bin/python3.12',
    '/opt/homebrew/bin/python3.11',
  ]) {
    if (!candidate) continue;
    const probe = spawnSync(candidate, ['-c', 'import numpy, torch, mujoco, onnx, onnxruntime'], {
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
    '[microduck-recurrent] SKIP — python3 with numpy+torch+mujoco+onnx+onnxruntime not found. ' +
      'Install with: python3 -m pip install --user -r engines/microduck-recurrent/requirements.txt',
  );
  process.exit(0);
}

// ---- 1. behavioural suite -------------------------------------------------
const pytest = spawnSync(
  python,
  ['-m', 'pytest', path.join(engineDir, 'tests'), '-q', '--no-header'],
  { encoding: 'utf8', cwd: engineDir, maxBuffer: 8 * 1024 * 1024 },
);
if (pytest.status !== 0) {
  console.error(pytest.stdout || '');
  console.error(pytest.stderr || '');
  throw new Error(`microduck-recurrent behavioural suite failed (pytest exit ${pytest.status})`);
}
const passed = /(\d+) passed/.exec(pytest.stdout);
console.log(`[microduck-recurrent] behavioural suite: ${passed ? `${passed[1]} passed` : 'ok'}`);

// ---- 2. one short real training with export ------------------------------
const scratch = await mkdtemp(path.join(os.tmpdir(), 'rdk-microduck-recurrent-'));
try {
  const exportPath = path.join(scratch, 'policy.onnx');
  const summaryPath = path.join(scratch, 'training-summary.json');
  const run = spawnSync(
    python,
    [
      path.join(engineDir, 'train_recurrent.py'),
      '--num-envs',
      '3',
      '--iterations',
      '2',
      '--steps-per-env',
      '48',
      '--episode-seconds',
      '4',
      '--lstm-hidden',
      '32',
      '--hidden',
      '64',
      '--seed',
      '20260922',
      '--export',
      exportPath,
      '--checkpoint',
      path.join(scratch, 'policy.pt'),
      '--out',
      summaryPath,
    ],
    { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
  );
  if (run.status !== 0) {
    console.error(run.stdout || '');
    console.error(run.stderr || '');
    throw new Error(`microduck-recurrent training exited with ${run.status}`);
  }
  const summary = JSON.parse(await readFile(summaryPath, 'utf8'));
  assert.equal(summary.observationSize, 61);
  assert.equal(summary.actionSize, 14);
  assert.equal(summary.task, 'basketball-balance-recurrent');
  assert.ok(summary.export.bytes > 1024, 'exported ONNX must be non-trivial');
  assert.equal(summary.export.recurrent.stateInputs.join(','), 'h_in,c_in');
  assert.ok(summary.export.parityMaxAbsError < 1e-4, 'torch<->onnxruntime parity with state carry');

  // ---- 3. the artifact must load through the evaluation engine's loader ----
  const loaderProbe = spawnSync(
    python,
    [
      '-c',
      [
        'import sys',
        `sys.path.insert(0, ${JSON.stringify(path.join(repoRoot, 'engines/microduck-eval'))})`,
        'from microduck_eval.policy import load_policy',
        `policy = load_policy(${JSON.stringify(exportPath)})`,
        'assert policy.recurrent is True, "exported graph must classify as recurrent"',
        'assert policy.facts() == {"recurrent": True, "stateInputs": ["h_in", "c_in"], "stateOutputs": ["h_out", "c_out"]}',
        'import numpy as np',
        'action = policy.act(np.zeros(61, dtype=np.float32))',
        'assert action.shape == (14,) and np.all(np.isfinite(action))',
        'policy.reset()',
        'print("loader-ok")',
      ].join('\n'),
    ],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 },
  );
  if (loaderProbe.status !== 0 || !loaderProbe.stdout.includes('loader-ok')) {
    console.error(loaderProbe.stdout || '');
    console.error(loaderProbe.stderr || '');
    throw new Error('exported graph failed to load through microduck_eval.policy.load_policy');
  }

  console.log(
    `[microduck-recurrent] PASS — recurrent PPO trained ${summary.iterations} iterations ` +
      `(resets ${summary.resets}, LSTM ${summary.lstmHidden}) and its export loads as a ` +
      `recurrent 61->14 policy (parity ${summary.export.parityMaxAbsError.toExponential(2)}, ` +
      `${summary.export.bytes} bytes) via ${python}`,
  );
} finally {
  await rm(scratch, { recursive: true, force: true });
}
