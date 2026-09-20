#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve('profiles');
const files = fs
  .readdirSync(root)
  .filter((name) => name.endsWith('.json'))
  .sort();
if (!files.length) throw new Error('profiles/ must contain at least one profile');
for (const file of files) {
  const p = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  const fail = (message) => {
    throw new Error(`${file}: ${message}`);
  };
  if (p.schemaVersion !== 1 || !p.id || !p.displayName) fail('schema/id/displayName required');
  if (!p.board?.platform || !p.board?.family || !p.board?.model) fail('board identity incomplete');
  if (!p.ros?.topics || typeof p.ros.topics !== 'object') fail('ros.topics required');
  // An arm driven by a local SDK (e.g. arm_sdk on loopback) legitimately has
  // no ROS topics; anything else must declare at least one.
  if (p.actuator?.kind !== 'arm' && !Object.keys(p.ros.topics).length) fail('ros.topics required');
  const topicNames = new Set();
  for (const [key, topic] of Object.entries(p.ros?.topics || {})) {
    if (!topic.name?.startsWith('/') || !topic.type?.includes('/'))
      fail(`topic ${key} is incomplete`);
    if (topicNames.has(topic.name)) fail(`topic ${key} duplicates another topic`);
    topicNames.add(topic.name);
    if (topic.qos !== undefined && !['best-effort', 'reliable'].includes(topic.qos))
      fail(`topic ${key} qos is invalid`);
  }
  if (!['diff-drive', 'omni-drive', 'joint', 'custom', 'arm'].includes(p.actuator?.kind))
    fail('unsupported actuator kind');
  if (p.actuator.kind === 'arm') {
    const sdk = p.actuator.sdk;
    if (!sdk || sdk.service !== 'arm_sdk' || sdk.host !== '127.0.0.1')
      fail('arm actuator requires actuator.sdk bound to loopback arm_sdk');
    if (!Number.isInteger(sdk.port) || sdk.port <= 0 || sdk.port > 65535)
      fail('arm actuator sdk.port invalid');
    if (!(p.actuator.maxReachMm > 0 && p.actuator.maxReachMm <= 1000))
      fail('arm actuator maxReachMm must be 0..1000');
    if (!(p.actuator.maxSpeedMmPerS > 0 && p.actuator.maxSpeedMmPerS <= 200))
      fail('arm actuator maxSpeedMmPerS must be 0..200');
    if (
      !p.actuator.gripper ||
      !(p.actuator.gripper.maxOpenWidthMm > 0 && p.actuator.gripper.maxOpenWidthMm <= 120) ||
      !(p.actuator.gripper.maxCloseForce > 0 && p.actuator.gripper.maxCloseForce <= 100)
    )
      fail('arm actuator gripper bounds invalid');
    const box = p.safety?.workspaceMm;
    const inBox =
      box &&
      ['x', 'y', 'z'].every((axis) => {
        const range = box[axis];
        return (
          Array.isArray(range) &&
          range.length === 2 &&
          range.every((v) => Number.isFinite(v)) &&
          range[0] < range[1] &&
          Math.abs(range[0]) <= p.actuator.maxReachMm &&
          Math.abs(range[1]) <= p.actuator.maxReachMm
        );
      });
    if (!inBox) fail('arm actuator requires safety.workspaceMm box within maxReachMm');
    if (!(p.safety?.speedMmPerS > 0 && p.safety.speedMmPerS <= p.actuator.maxSpeedMmPerS))
      fail('arm safety.speedMmPerS must be 0..actuator.maxSpeedMmPerS');
    if (p.runtime?.actionOutput !== 'arm-pose')
      fail('arm actuators must declare runtime.actionOutput=arm-pose');
  } else {
    if (!p.actuator.commandTopic?.startsWith('/') || !p.actuator.messageType?.includes('/'))
      fail('actuator command is incomplete');
    if (['diff-drive', 'omni-drive'].includes(p.actuator.kind) && !p.ros.topics.cmdVel)
      fail('drive actuator requires ros.topics.cmdVel');
    if (p.actuator.kind === 'joint' && !p.ros.topics.jointCommand)
      fail('joint actuator requires ros.topics.jointCommand');
    const commandTopic =
      p.actuator.kind === 'joint' ? p.ros.topics.jointCommand : p.ros.topics.cmdVel;
    if (commandTopic && commandTopic.name !== p.actuator.commandTopic)
      fail(
        `${p.actuator.kind === 'joint' ? 'jointCommand' : 'cmdVel'} topic must match actuator.commandTopic`,
      );
    if (commandTopic && commandTopic.type !== p.actuator.messageType)
      fail(
        `${p.actuator.kind === 'joint' ? 'jointCommand' : 'cmdVel'} type must match actuator.messageType`,
      );
    if (!(p.actuator.maxLinear > 0 && p.actuator.maxLinear <= 0.3))
      fail('linear safety bound invalid');
    if (!(p.actuator.maxAngular > 0 && p.actuator.maxAngular <= 1))
      fail('angular safety bound invalid');
  }
  if (!(
    Number.isInteger(p.actuator.watchdogMs) &&
    p.actuator.watchdogMs >= 500 &&
    p.actuator.watchdogMs <= 2000
  ))
    fail('watchdog must be 500..2000ms');
  if (!(
    Number.isInteger(p.policy?.observationSize) &&
    p.policy.observationSize > 0 &&
    p.policy.observationSize <= 4096
  ))
    fail('observation dimensions invalid');
  if (!(
    Number.isInteger(p.policy?.actionSize) &&
    p.policy.actionSize > 0 &&
    p.policy.actionSize <= 4096
  ))
    fail('action dimensions invalid');
  if (
    !Array.isArray(p.capabilities) ||
    !p.capabilities.length ||
    p.capabilities.some((item) => typeof item !== 'string' || !item.trim())
  )
    fail('capabilities must be a non-empty string array');
  if (
    p.runtime?.decisionHz !== undefined &&
    (!Number.isFinite(Number(p.runtime.decisionHz)) ||
      Number(p.runtime.decisionHz) < 1 ||
      Number(p.runtime.decisionHz) > 50)
  )
    fail('runtime.decisionHz must be 1..50');
  if (
    p.actuator.kind !== 'arm' &&
    p.runtime?.actionOutput !== undefined &&
    ![
      'physical-twist',
      'normalized-twist',
      ...(p.actuator.kind === 'joint' ? ['joint-position-offset'] : []),
    ].includes(String(p.runtime.actionOutput).trim())
  )
    fail(
      p.actuator.kind === 'joint'
        ? 'runtime.actionOutput must be physical-twist, normalized-twist, or joint-position-offset'
        : 'runtime.actionOutput must be physical-twist or normalized-twist',
    );
  if (p.actuator.kind === 'joint' && p.runtime?.actionOutput !== 'joint-position-offset')
    fail('joint actuators must declare runtime.actionOutput=joint-position-offset');
  if (
    p.policy?.actionSize === 2 &&
    p.runtime?.actionProjection === 'identity' &&
    !['physical-twist', 'normalized-twist'].includes(String(p.runtime?.actionOutput || ''))
  )
    fail('2D identity policies must declare runtime.actionOutput');
  if (
    p.safety?.sensorStallSec !== undefined &&
    (Number(p.safety.sensorStallSec) < 0.1 || Number(p.safety.sensorStallSec) > 2)
  )
    fail('safety.sensorStallSec must be .1..2');
  if (p.provenance !== undefined) {
    if (!['real', 'synthetic', 'template'].includes(p.provenance.kind))
      fail('provenance.kind must be real, synthetic, or template');
    if (typeof p.provenance.mock !== 'boolean') fail('provenance.mock must be boolean');
    if (p.provenance.kind === 'real' && p.provenance.mock)
      fail('real profile cannot claim mock=true');
    if (p.provenance.kind === 'synthetic' && !p.provenance.mock)
      fail('synthetic profile must claim mock=true');
  }
}
console.log(`[hardware-profile] PASS — ${files.length} profile(s) validated`);
