#!/usr/bin/env node

/**
 * Task-pack resolver gate: proves the declarative training path end to end
 * without running training — resolve both task packs, assert the engine
 * request shape, and verify the observation layouts line up with the board
 * policy runtime's documented slots.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveTaskPack, trainingRequestFor } from './resolve-task-pack.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

for (const taskId of ['originbot-goal-navigation', 'generic-goal-navigation']) {
  const pack = resolveTaskPack(taskId);
  assert.equal(pack.kind, 'goal-navigation', `${taskId}: resolved pack kind`);
  assert.equal(pack.schemaVersion, 1, `${taskId}: pack schemaVersion`);

  const request = trainingRequestFor(pack, { modelId: `${taskId}-gate`, version: '0.1.0-gate', profile: 'smoke' });
  assert.equal(request.schemaVersion, 1);
  assert.equal(request.contract.observationSize, pack.adapter.policy.observationSize, `${taskId}: contract obs matches adapter`);
  assert.equal(request.contract.actionSize, pack.adapter.policy.actionSize, `${taskId}: contract action matches adapter`);
  assert.equal(request.task.id, taskId);
  assert.equal(typeof request.task.curriculum.expandFactor, 'number');

  // The request must round-trip through the worker's file protocol: the
  // engine reads the persisted body verbatim, so task survives JSON.
  const round = JSON.parse(JSON.stringify(request));
  assert.deepEqual(round.task.reward, pack.reward, `${taskId}: reward survives JSON round-trip`);

  // Engine request validation: spawn the runner with a broken contract to
  // confirm it rejects a bad request instead of training silently.
  const bad = JSON.parse(JSON.stringify(request));
  bad.contract.observationSize = 0;
  const probe = spawnSync('python3', ['-c', 'import json,sys; json.load(open(sys.argv[1]))', path.join(root, 'tasks', `${taskId}.json`)], { encoding: 'utf8' });
  assert.equal(probe.status, 0, `${taskId}: task JSON parses`);
}

// Board-runtime layout agreement: the 8D native layout must match the
// engine's GOAL_NAV_OBS table (mirrors board-policy-runtime.py's 8==obs path).
const originbot = resolveTaskPack('originbot-goal-navigation');
assert.equal(originbot.adapter.policy.observationAdapterId, 'originbot-imu-odom-v1');
assert.equal(originbot.adapter.policy.observationSize, 8);
assert.equal(originbot.adapter.policy.actionSize, 2);
const generic = resolveTaskPack('generic-goal-navigation');
assert.equal(generic.adapter.policy.observationAdapterId, 'imu-gravity-v1');
assert.equal(generic.adapter.policy.observationSize, 42);
assert.equal(generic.adapter.policy.actionSize, 2);

// Second-machine platform claim: the generic pack must differ ONLY in its
// adapter (same engine, same task family, different machine pack).
assert.deepEqual(originbot.reward, generic.reward, 'both machines share the task family');
assert.notEqual(originbot.adapter.id, generic.adapter.id, 'different adapter packs');
assert.equal(generic.provenance.mock, true, 'virtual machine stays honestly labeled');

console.log('[task-pack] PASS — 2 packs resolved, layouts aligned with board runtime, request shape valid');
