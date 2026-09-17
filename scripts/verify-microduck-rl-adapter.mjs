#!/usr/bin/env node
/**
 * Contract check for engines/microduck-rl-adapter/adapter.py — no GPU required.
 *
 * The upstream stack only exists on a CUDA box, but the parts that can silently
 * break the platform contract are pure Python: the task-id mapping, the reward
 * parser that feeds the live curve, and the shape of the result the worker
 * accepts. This script pins all three against the worker's own regexes so a
 * regression fails here instead of on the GPU machine.
 *
 * Usage: node scripts/verify-microduck-rl-adapter.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADAPTER = path.join(ROOT, 'engines', 'microduck-rl-adapter', 'adapter.py');

// Copied verbatim from services/sim2real-web/local-training-worker.mjs: the
// engine's stdout must satisfy THIS pattern for the curve to appear at all.
const PROGRESS_LINE_RE =
  /iter (\d+)\/(\d+) meanReward=(-?\d+(?:\.\d+)?) recentSuccess=(\d+(?:\.\d+)?)(?: goalRange=\[([^\]]*)\])?(?: elapsed=(\d+(?:\.\d+)?)s)?/g;
// Mirrors server/sim2real/robogo-runner.ts safeArtifact(): an artifact whose
// metadata fails any of these is silently dropped from the run record, which is
// exactly how the first end-to-end attempt lost its ONNX.
const ARTIFACT_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/;
const ARTIFACT_KINDS = new Set(['source', 'compiled']);
const ARTIFACT_FORMATS = new Set(['pytorch', 'onnx', 'bin', 'hbm', 'gguf', 'unknown']);
const ARTIFACT_REF_RE =
  /^artifact:\/\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}(?:\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}){0,8}$/;

const python = process.env.PYTHON || 'python3';
const probe = JSON.parse(
  execFileSync(python, [ADAPTER.replace(/adapter\.py$/, 'adapter_probe.py')], {
    encoding: 'utf8',
    cwd: ROOT,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  }),
);

// 1. Task mapping -----------------------------------------------------------
assert.equal(probe.taskIds.walk, 'Mjlab-Velocity-Flat-MicroDuck');
assert.equal(probe.taskIds.kick, 'Mjlab-BallKick-Flat-MicroDuck');
assert.equal(probe.taskIds.roughSit, 'Mjlab-SitStand-Rough-MicroDuck');
assert.equal(probe.taskIds.explicit, 'Mjlab-Spin-Flat-MicroDuck');
assert.equal(probe.taskIds.unknown, 'Mjlab-Velocity-Flat-MicroDuck');
for (const id of Object.values(probe.taskIds)) {
  assert.match(id, /^Mjlab-[A-Za-z]+-/);
}

// 2. Reward parser ----------------------------------------------------------
// Lines are emitted split across arbitrary chunk boundaries on purpose: the
// worker hands the engine's stdout over in 64 KiB chunks that cut mid-line.
for (const line of probe.progressLines) {
  const matches = [...line.matchAll(PROGRESS_LINE_RE)];
  assert.equal(matches.length, 1, `progress line did not match the worker regex: ${line}`);
  assert.equal(Number(matches[0][1]), matches[0][1] ? Number(matches[0][1]) : 0);
}
assert.deepEqual(
  probe.progressIterations,
  [1, 2, 3, 4, 5],
  'every iteration with a reward buffer must produce exactly one curve point',
);
assert.equal(probe.lastReward, 15.5);
assert.equal(probe.lastEpisodeLength, 290);
assert.equal(
  probe.firstIterationWithoutReward,
  true,
  'iteration 0 must be skipped, not zero-filled',
);

// 3. Result shape -----------------------------------------------------------
assert.equal(probe.result.physicsBackend, 'mjlab-mujoco-warp');
assert.equal(
  probe.result.deployable,
  false,
  'BPU compilation is out of scope: never claim deployable',
);
assert.equal(probe.result.cuda, true);
assert.equal(probe.result.metrics.contractValid, true);
assert.equal(probe.result.metrics.observationSize, 61);
assert.equal(probe.result.metrics.actionSize, 14);
assert.equal(probe.result.metrics.engine, 'microduck-rl');
assert.match(probe.result.artifact.ref, ARTIFACT_REF_RE);
assert.match(probe.result.artifact.ref, /policy\.onnx$/);
assert.match(probe.result.checkpoint.artifactRef, ARTIFACT_REF_RE);
assert.equal(probe.result.artifact.format, 'onnx');
// The platform's artifact contract accepts only source|compiled; anything else
// makes the server drop the artifact from the run record entirely.
assert.equal(probe.result.artifact.kind, 'compiled');
assert.match(probe.result.artifact.artifactId, ARTIFACT_ID_RE);
assert.ok(ARTIFACT_KINDS.has(probe.result.artifact.kind));
assert.ok(ARTIFACT_FORMATS.has(probe.result.artifact.format));
assert.match(probe.result.artifact.sha256, /^[a-f0-9]{64}$/);
assert.equal(probe.result.artifact.runtime, 'onnxruntime-cpu');
assert.equal(probe.result.artifact.workload, 'locomotion');
assert.equal(probe.result.checkpoint.iteration, 1500);
// safeCheckpoint() in the server enforces this id shape; a colon or a path
// silently removes the checkpoint from the run record.
assert.match(probe.result.checkpoint.checkpointId, /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/);
assert.deepEqual(Object.keys(probe.result.checkpoint).sort(), [
  'artifactRef',
  'checkpointId',
  'iteration',
]);
assert.equal(probe.summary.upstream.taskId, 'Mjlab-Velocity-Flat-MicroDuck');
assert.equal(probe.summary.numEnvs, 64);
assert.equal(probe.summary.physicsBackend, 'mjlab-mujoco-warp');
assert.equal(probe.summary.onnxExported, true);
assert.equal(probe.summary.rewardCurve.length, 5);
assert.equal(probe.result.metrics.loggedIterations, 5);
assert.equal(probe.result.metrics.checkpointIteration, 1500);
// mjlab 1.3.0 prints per-term episode metrics in the same block; they are
// captured as evidence and never required to exist.
assert.equal(probe.summary.episodeMetrics['episode_termination/fell_over'], 2.3333);

// 3b. Experiment selection --------------------------------------------------
// Concurrent jobs share upstream's `logs/rsl_rl`, so the adapter must claim
// only the directory this run created, and must rank checkpoints by iteration
// (mjlab writes model_0.pt before the first gradient step).
assert.equal(probe.experiments.markerDirs, 2, 'both concurrent job dirs must be discoverable');
assert.equal(probe.experiments.selectedFresh, true);
assert.equal(probe.experiments.selectedStaleWhenNothingNew, true);
assert.equal(probe.experiments.checkpoint, 'model_4.pt');
assert.equal(probe.experiments.checkpointIteration, 4);
assert.equal(probe.experiments.emptyDirHasNoCheckpoint, true);

// 3c. Export command --------------------------------------------------------
// The exporter must be the upstream script with an explicit checkpoint and the
// job-local destination the worker hashes.
assert.deepEqual(probe.exportCommand, [
  '/usr/local/bin/uv',
  'run',
  'scripts/export.py',
  'Mjlab-Velocity-Flat-MicroDuck',
  '--checkpoint-file',
  '/repo/logs/rsl_rl/velocity/run/model_1500.pt',
  '--onnx-file',
  '/job/policy.onnx',
]);

// 4. Refusal paths ----------------------------------------------------------
// A missing upstream stack must exit 3 (the platform's "engine unavailable"
// signal) and must not write a result file.
assert.equal(probe.missingStackExitCode, 3);
assert.equal(probe.missingStackWroteResult, false);

// 5. ONNX export gate -------------------------------------------------------
// The gate runs the exported graph on probe observations before the platform
// hashes it as a policy. Its pure contract surfaces are pinned here; the
// session-level checks (finiteness/determinism/sensitivity) only run where
// the artifact and onnxruntime both exist.
const gate = probe.exportGate;
assert.equal(gate.feedforward.recurrent, false);
assert.equal(gate.feedforward.input_name, 'obs');
assert.equal(gate.lstm.recurrent, true);
assert.deepEqual(gate.lstm.state_pairs, [
  ['h_in', 'h_out'],
  ['c_in', 'c_out'],
]);
assert.deepEqual(gate.initialStyle.state_pairs, [['initial_h', 'h']]);
// Anything ambiguous must be refused, never guessed.
assert.notEqual(gate.rejections.twoObs, 'accepted');
assert.notEqual(gate.rejections.stateOneSide, 'accepted');
assert.notEqual(gate.rejections.ambiguousPair, 'accepted');
// Verdict assembly: one failed check fails the gate; no runtime = skip.
assert.equal(gate.verdicts.passed.verdict, 'passed');
assert.equal(gate.verdicts.oneFailureFails.verdict, 'failed');
assert.ok(gate.verdicts.oneFailureFails.reasons[0].includes('sensitivity'));
assert.equal(gate.verdicts.noRuntimeSkips.verdict, 'skipped');
// The gate verdict reaches the ledger as one flat string the worker keeps.
assert.equal(probe.result.metrics.onnxGate, 'passed');
assert.deepEqual(probe.summary.onnxExportGate.checks, {
  contract: true,
  finiteness: true,
  determinism: true,
  sensitivity: true,
});

console.log('verify:microduck-rl-adapter OK');
console.log(
  `  task mapping: ${Object.keys(probe.taskIds).length} cases · curve points: ${probe.progressIterations.length} · artifact: ${probe.result.artifact.ref} · export gate: ${gate.verdicts.passed.verdict}`,
);
