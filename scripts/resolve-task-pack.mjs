#!/usr/bin/env node

/**
 * Resolve a declarative task pack into a self-contained engine request.
 *
 * A task pack = tasks/<id>.json (reward, termination, curriculum,
 * domain-randomization, quality gate) + adapters/<adapterId>.json (safety
 * clamps, decision rate, observation layout, contract dimensions). The
 * engine process receives the merged spec embedded in the training request,
 * so it never needs repository paths: the platform, not the engine, owns
 * task and adapter resolution.
 *
 * Usage:
 *   node scripts/resolve-task-pack.mjs originbot-goal-navigation [context.json]
 * Prints the resolved request-task object as JSON. An optional context JSON
 * provides modelId/version/profile overrides.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

import { resolveRewardFormula } from './reward-vocabulary.mjs';

// The UI keeps the short, human-facing action ids (walk/kick/recover/sit) so
// existing recordings and run history remain stable. Resolve those ids to the
// full declarative MicroDuck packs before a request reaches a worker.
const TASK_ALIASES = Object.freeze({
  walk: 'microduck-walk',
  kick: 'microduck-kick',
  recover: 'microduck-recover',
  sit: 'microduck-stand',
});

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
}

function pair(value, where) {
  assert.ok(
    Array.isArray(value) &&
      value.length === 2 &&
      value.every((x) => typeof x === 'number' && Number.isFinite(x)),
    `${where} must be [min, max]`,
  );
  assert.ok(value[0] <= value[1], `${where} min must not exceed max`);
  return value;
}

export function resolveTaskPack(taskId, context = {}) {
  const resolvedTaskId = TASK_ALIASES[taskId] || taskId;
  const task = readJson(path.join('tasks', `${resolvedTaskId}.json`));
  const adapter = readJson(path.join('adapters', `${task.adapterId}.json`));
  assert.equal(task.schemaVersion, 1, 'task schemaVersion must be 1');
  assert.equal(adapter.schemaVersion, 1, 'adapter schemaVersion must be 1');
  assert.equal(
    task.observationAdapterId,
    adapter.policy.observationAdapterId,
    `task declares observation adapter ${task.observationAdapterId} but ${task.adapterId} provides ${adapter.policy.observationAdapterId}`,
  );
  assert.equal(
    task.actionAdapterId,
    adapter.policy.actionAdapterId,
    `task declares action adapter ${task.actionAdapterId} but ${task.adapterId} provides ${adapter.policy.actionAdapterId}`,
  );

  const decisionHz = Number(adapter.runtime?.decisionHz) || 10;
  const controlHz = Number(context.controlHz) || decisionHz;
  const physicsTimestepSeconds = Number(context.physicsTimestepSeconds) || 0.02;
  const decimation = Math.max(1, Math.round(controlHz * physicsTimestepSeconds));

  // Observation history stacking (the RPO-style "stack N past frames" policy
  // input). The frame layout stays the adapter's observationSize; the history
  // multiplies the policy's flat input width. Only the concat order this
  // platform implements is accepted — an unimplemented order must fail at
  // resolve time, not become a silently reordered policy input on the board.
  const historyDeclaration = adapter.policy.observationHistory;
  if (historyDeclaration != null) {
    assert.ok(
      historyDeclaration &&
        typeof historyDeclaration === 'object' &&
        !Array.isArray(historyDeclaration),
      'adapter policy.observationHistory must be an object like {"frames": 3, "order": "oldest-first"}',
    );
    assert.ok(
      Number.isInteger(historyDeclaration.frames) &&
        historyDeclaration.frames >= 1 &&
        historyDeclaration.frames <= 64,
      `adapter policy.observationHistory.frames must be an integer in [1, 64] (got ${JSON.stringify(historyDeclaration.frames)})`,
    );
    const order = historyDeclaration.order || 'oldest-first';
    assert.equal(
      order,
      'oldest-first',
      `adapter policy.observationHistory.order must be 'oldest-first' (got ${JSON.stringify(order)})`,
    );
  }

  // Engine routing is platform policy, so the recommendation is validated here:
  // an unknown id fails loudly instead of being silently dropped (and later
  // defaulting the task to the kinematic engine). It is resolved before the
  // reward, because the reward vocabulary is checked against the engine that
  // will actually run the task.
  if (
    task.recommendedEngine != null &&
    !['starter-ppo', 'mjx-ppo', 'microduck-rl', 'isaac-lab'].includes(task.recommendedEngine)
  ) {
    throw new Error(
      `recommendedEngine must be 'starter-ppo', 'mjx-ppo', 'microduck-rl' or 'isaac-lab' (got ${JSON.stringify(task.recommendedEngine)})`,
    );
  }
  // Packs without a recommendation run on the platform default (the kinematic
  // starter engine), which is also what its capability set is checked against.
  const engine = task.recommendedEngine || 'starter-ppo';
  const rewardFormula = resolveRewardFormula(
    { reward: task.reward, rewardFormula: task.rewardFormula },
    engine,
  );

  const pack = {
    schemaVersion: 1,
    kind: task.kind || 'goal-navigation',
    id: task.id,
    displayName: task.displayName,
    observationAdapterId: task.observationAdapterId,
    actionAdapterId: task.actionAdapterId,
    recommendedEngine: task.recommendedEngine,
    adapter,
    reward: task.reward,
    // The validated reward, in the vocabulary form the engines evaluate. A pack
    // that declared no formula carries the expansion of its legacy `reward` map,
    // so every engine has exactly one representation to implement.
    rewardFormula,
    termination: task.termination,
    workspace: task.workspace,
    curriculum: task.curriculum,
    domainRandomization: task.domainRandomization,
    evaluationConfig: task.evaluationConfig,
    qualityGate: task.qualityGate,
    microduckTask: task.microduckTask,
    isaacTask: task.isaacTask,
    ...(resolvedTaskId !== taskId ? { requestedTaskId: taskId, resolvedTaskId } : {}),
    controlHz,
    physicsTimestepSeconds,
    decimation,
    seed: Number.isInteger(context.seed) ? context.seed : 7,
    provenance: task.provenance || {
      kind: 'task-pack',
      mock: true,
      note: 'Declarative task pack resolved from tasks/ + adapters/.',
    },
  };
  // The adapter's clamps are the single actuator truth: the engine, the
  // board runtime, and this resolver all read the same numbers.
  const dr = pack.domainRandomization || {};
  for (const key of [
    'motorGain',
    'lagTauSeconds',
    'gyroNoiseStdRadSec',
    'odomNoiseStdM',
    'angularBiasRadSec',
    'actionLatencySteps',
    'odomDropoutProb',
    'slipScale',
  ]) {
    if (dr[key]) pair(dr[key], `domainRandomization.${key}`);
  }
  if (
    dr.actionLatencySteps &&
    !dr.actionLatencySteps.every((value) => Number.isInteger(value) && value >= 0)
  ) {
    throw new Error('domainRandomization.actionLatencySteps must be non-negative integers');
  }
  for (const [name, envelope] of Object.entries(dr.evalEnvelopes || {})) {
    if (![6, 8].includes(envelope.length))
      throw new Error(`domainRandomization.evalEnvelopes.${name} must contain 6 or 8 values`);
    if (!Number.isInteger(envelope[5]) || envelope[5] < 0)
      throw new Error(
        `domainRandomization.evalEnvelopes.${name}[5] latencySteps must be a non-negative integer`,
      );
  }
  return pack;
}

export function trainingRequestFor(pack, context = {}) {
  const observationSize = pack.adapter.policy.observationSize;
  const actionSize = pack.adapter.policy.actionSize;
  // Contract observationSize is the policy's flat VECTOR input width (the same
  // convention the manifest validator enforces), so a history-stacked policy
  // carries frames × frameWidth here, with one layout entry per stacked frame
  // ordered oldest-first — the exact concat order the engine and the board
  // runtime implement.
  const history = pack.adapter.policy.observationHistory || null;
  const historyFrames = Math.max(1, Math.min(64, Number(history?.frames) || 1));
  const modelObservationSize = observationSize * historyFrames;
  const observationLayout =
    historyFrames > 1
      ? Array.from({ length: historyFrames }, (_, index) => ({
          name: `${pack.observationAdapterId}@t-${historyFrames - 1 - index}`,
          size: observationSize,
        }))
      : [{ name: pack.observationAdapterId, size: observationSize }];
  return {
    schemaVersion: 1,
    contractId: `${pack.id}-policy-v1`,
    contract: {
      id: `${pack.id}-policy-v1`,
      robotId: pack.adapter.id,
      observationSize: modelObservationSize,
      actionSize,
      controlHz: pack.controlHz,
      physicsTimestepSeconds: pack.physicsTimestepSeconds,
      decimation: pack.decimation,
      observationAdapterId: pack.observationAdapterId,
      actionAdapterId: pack.actionAdapterId,
      actionOutput: pack.adapter.runtime?.actionOutput,
      actionScale:
        pack.adapter.actuator?.kind === 'joint'
          ? {
              joint: Number(pack.adapter.runtime?.actionScaleRad ?? 0.35),
              units: 'rad offset from home position',
            }
          : {
              linear: Number(pack.adapter.actuator?.maxLinear ?? 0.3),
              angular: Number(pack.adapter.actuator?.maxAngular ?? 1),
              units: 'm/s,rad/s',
            },
      observationLayout,
      ...(historyFrames > 1
        ? { observationHistory: { frames: historyFrames, order: 'oldest-first' } }
        : {}),
    },
    model: {
      modelId: context.modelId || `${pack.id}-ppo`,
      version: context.version || '0.1.0',
    },
    training: {
      profile: context.profile || 'smoke',
      numEnvs: context.numEnvs,
      maxIterations: context.maxIterations,
      video: false,
    },
    task: pack,
  };
}

const taskId = process.argv[2];
if (taskId) {
  let context = {};
  if (process.argv[3]) context = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
  process.stdout.write(JSON.stringify(resolveTaskPack(taskId, context), null, 2) + '\n');
}
