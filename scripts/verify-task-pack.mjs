#!/usr/bin/env node

/**
 * Task-pack resolver gate: proves the declarative training path end to end
 * without running training — resolve both task packs, assert the engine
 * request shape, and verify the observation layouts line up with the board
 * policy runtime's documented slots.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveTaskPack, trainingRequestFor } from './resolve-task-pack.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

for (const taskId of ['originbot-goal-navigation', 'generic-goal-navigation']) {
  const pack = resolveTaskPack(taskId);
  assert.equal(pack.kind, 'goal-navigation', `${taskId}: resolved pack kind`);
  assert.equal(pack.schemaVersion, 1, `${taskId}: pack schemaVersion`);

  const request = trainingRequestFor(pack, {
    modelId: `${taskId}-gate`,
    version: '0.1.0-gate',
    profile: 'smoke',
  });
  assert.equal(request.schemaVersion, 1);
  assert.equal(
    request.contract.observationSize,
    pack.adapter.policy.observationSize,
    `${taskId}: contract obs matches adapter`,
  );
  assert.equal(
    request.contract.actionSize,
    pack.adapter.policy.actionSize,
    `${taskId}: contract action matches adapter`,
  );
  assert.equal(request.task.id, taskId);
  assert.equal(typeof request.task.curriculum.expandFactor, 'number');

  // Statistical-power contract: CI-gated packs must carry enough episodes
  // and a supported confidence level, or the gate verdict is noise.
  const evaluationConfig = request.task.evaluationConfig || {};
  if (request.task.qualityGate?.gateOn === 'ciLowerBound') {
    assert.ok(
      (evaluationConfig.episodesPerEnvelope ?? 0) >= 30,
      `${taskId}: gateOn=ciLowerBound needs >=30 episodes per envelope`,
    );
    assert.ok(
      [0.9, 0.95, 0.99].includes(evaluationConfig.confidenceLevel ?? 0.95),
      `${taskId}: confidenceLevel must be 0.9/0.95/0.99`,
    );
  }
  // Beyond pass/fail: a smoothness ceiling and an ablation requirement. Both are
  // optional, but a pack that declares one must declare it in a form the engine
  // and the release gate can actually judge — a criterion with no threshold (or
  // an unknown key) would read as "required" while enforcing nothing.
  const gate = request.task.qualityGate ?? {};
  if (gate.maxActionChangeRms !== undefined) {
    assert.ok(
      typeof gate.maxActionChangeRms === 'number' &&
        Number.isFinite(gate.maxActionChangeRms) &&
        gate.maxActionChangeRms > 0,
      `${taskId}: qualityGate.maxActionChangeRms must be a finite positive number`,
    );
  }
  if (gate.ablation !== undefined) {
    const ablation = gate.ablation;
    assert.ok(
      ablation && typeof ablation === 'object' && !Array.isArray(ablation),
      `${taskId}: qualityGate.ablation must be an object`,
    );
    const keys = Object.keys(ablation).sort();
    assert.deepEqual(
      keys,
      keys.filter((key) => ['requireBaseline', 'minSuccessRateDelta'].includes(key)),
      `${taskId}: qualityGate.ablation has an unknown key (allowed: requireBaseline, minSuccessRateDelta)`,
    );
    assert.ok(keys.length > 0, `${taskId}: qualityGate.ablation must state a requirement`);
    if (ablation.requireBaseline !== undefined) {
      assert.equal(
        typeof ablation.requireBaseline,
        'boolean',
        `${taskId}: ablation.requireBaseline must be a boolean`,
      );
    }
    if (ablation.minSuccessRateDelta !== undefined) {
      assert.ok(
        typeof ablation.minSuccessRateDelta === 'number' &&
          Number.isFinite(ablation.minSuccessRateDelta) &&
          ablation.minSuccessRateDelta > 0 &&
          ablation.minSuccessRateDelta <= 1,
        `${taskId}: ablation.minSuccessRateDelta must be a rate in (0, 1]`,
      );
    }
  }
  // Every pack must carry a resolved reward formula, and it must be legal for
  // the engine that will run it. A pack whose reward the engine cannot measure
  // is refused at resolve time (see the capability check in the vocabulary), so
  // this asserts the resolved shape rather than re-deriving it.
  assert.ok(
    Array.isArray(pack.rewardFormula) && pack.rewardFormula.length > 0,
    `${taskId}: resolved pack carries no rewardFormula`,
  );
  for (const entry of pack.rewardFormula) {
    assert.ok(
      ['potential', 'shaping', 'penalty', 'bonus', 'rate_limit', 'smoothness'].includes(entry.op),
      `${taskId}: unknown reward op ${JSON.stringify(entry.op)}`,
    );
    assert.ok(
      typeof entry.weight === 'number' && entry.weight > 0,
      `${taskId}: reward term ${entry.term} must carry a positive magnitude`,
    );
    assert.ok(
      ['rises', 'falls'].includes(entry.improves),
      `${taskId}: reward term ${entry.term} must declare its improvement direction`,
    );
  }
  // The reward map and the formula must not both be author-declared: the
  // resolver refuses that, so a pack carrying both would never have resolved.
  assert.equal(
    request.task.rewardFormula !== undefined && request.task.reward !== undefined,
    true,
    `${taskId}: the resolved pack carries both forms, which is only valid because the resolver produced it`,
  );

  // The 8-value envelopes must pin dropout/slip too (legacy 6 tolerated).
  for (const [name, envelope] of Object.entries(pack.domainRandomization?.evalEnvelopes ?? {})) {
    assert.ok(
      [6, 8].includes(envelope.length),
      `${taskId}: evalEnvelopes.${name} must be 6 or 8 pinned values`,
    );
    assert.ok(
      envelope.every((x) => typeof x === 'number' && Number.isFinite(x)),
      `${taskId}: evalEnvelopes.${name} must be numbers`,
    );
  }

  // The request must round-trip through the worker's file protocol: the
  // engine reads the persisted body verbatim, so task survives JSON.
  const round = JSON.parse(JSON.stringify(request));
  assert.deepEqual(round.task.reward, pack.reward, `${taskId}: reward survives JSON round-trip`);

  // Engine request validation: spawn the runner with a broken contract to
  // confirm the real entrypoint rejects a bad request before training.
  // The runner imports numpy/torch at module top, so on machines without
  // those wheels (CI runners) it exits before reaching the contract check.
  // There the probe degrades to asserting the dependency guard itself, so
  // the gate still fails loudly if the runner stops rejecting anything.
  const bad = JSON.parse(JSON.stringify(request));
  bad.contract.observationSize = 0;
  const probeDir = fs.mkdtempSync(path.join(root, '.task-pack-probe-'));
  const requestPath = path.join(probeDir, 'request.json');
  const resultPath = path.join(probeDir, 'result.json');
  fs.writeFileSync(requestPath, JSON.stringify(bad));
  try {
    const probe = spawnSync('python3', [path.join(root, 'engines', 'starter-ppo', 'runner.py')], {
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        RDK_SIM2REAL_REQUEST_FILE: requestPath,
        RDK_SIM2REAL_RESULT_FILE: resultPath,
      },
    });
    const probeOut = `${probe.stdout}\n${probe.stderr}`;
    assert.notEqual(probe.status, 0, `${taskId}: runner must reject an invalid contract`);
    if (/starter-ppo engine requires (numpy|torch)/.test(probeOut)) {
      assert.equal(
        probe.status,
        2,
        `${taskId}: dependency guard should exit 2 on engines without numpy/torch`,
      );
    } else {
      assert.match(
        probeOut,
        /contract\.observationSize and contract\.actionSize are required/,
        `${taskId}: runner rejection should identify the invalid contract`,
      );
    }
  } finally {
    fs.rmSync(probeDir, { recursive: true, force: true });
  }
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

// Engine recommendation contract: the physics-dense pack recommends MJX and
// the kinematic packs stay silent (platform default), while the resolver
// refuses unknown engine ids instead of silently dropping them.
const physics = resolveTaskPack('originbot-physics-navigation');
assert.equal(physics.recommendedEngine, 'mjx-ppo', 'physics-dense pack recommends MJX');
assert.equal(originbot.recommendedEngine, undefined, 'kinematic pack stays engine-silent');
assert.throws(
  () => resolveTaskPack('goal-navigation-clear-arena'),
  /recommendedEngine/,
  'legacy pack with an unknown engine id must fail loudly at resolve time',
);

// Full-body MicroDuck packs must resolve to the external CUDA engine and carry
// a joint-position contract all the way into the training request. This keeps
// a 61D/14D leg policy from silently falling back to the wheeled starter path.
for (const taskId of ['microduck-stand', 'microduck-walk', 'microduck-kick', 'microduck-recover']) {
  const pack = resolveTaskPack(taskId);
  const request = trainingRequestFor(pack, { profile: 'smoke' });
  assert.equal(pack.kind, 'microduck-locomotion', `${taskId}: task kind`);
  assert.equal(pack.recommendedEngine, 'microduck-rl', `${taskId}: engine recommendation`);
  assert.equal(pack.adapter.actuator.kind, 'joint', `${taskId}: joint actuator`);
  assert.equal(pack.adapter.policy.observationSize, 61, `${taskId}: observation size`);
  assert.equal(pack.adapter.policy.actionSize, 14, `${taskId}: action size`);
  assert.equal(request.contract.actionOutput, 'joint-position-offset', `${taskId}: action output`);
  assert.deepEqual(request.contract.actionScale, {
    joint: 0.35,
    units: 'rad offset from home position',
  });
  assert.ok(pack.microduckTask?.upstreamTaskId, `${taskId}: upstream task id`);
  assert.equal(pack.qualityGate?.gateOn, 'ciLowerBound', `${taskId}: quality gate`);
}
for (const [alias, canonical] of Object.entries({
  walk: 'microduck-walk',
  kick: 'microduck-kick',
  recover: 'microduck-recover',
  sit: 'microduck-stand',
})) {
  const pack = resolveTaskPack(alias);
  assert.equal(pack.id, canonical, `${alias}: UI alias resolves to canonical pack`);
  assert.equal(pack.resolvedTaskId, canonical, `${alias}: resolved task id`);
  assert.equal(pack.recommendedEngine, 'microduck-rl', `${alias}: engine recommendation`);
}

console.log(
  '[task-pack] PASS — navigation and four MicroDuck packs resolved, layouts aligned with board runtime',
);
