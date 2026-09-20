#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('adapters');
const files = fs
  .readdirSync(root)
  .filter((name) => name.endsWith('.json'))
  .sort();
if (files.length < 2) throw new Error('at least two hardware adapter profiles are required');
const ids = new Set();
for (const file of files) {
  const profile = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  if (!profile.id || ids.has(profile.id))
    throw new Error(`invalid or duplicate adapter id: ${file}`);
  ids.add(profile.id);
  if (profile.schemaVersion !== 1) throw new Error(`${file}: schemaVersion must be 1`);
  if (!profile.board?.platform || !profile.board?.family || !profile.board?.model) {
    throw new Error(`${file}: board identity is incomplete`);
  }
  const topics = profile.ros?.topics;
  if (!topics || typeof topics !== 'object') throw new Error(`${file}: ros.topics required`);
  for (const sensor of ['imu', 'odom', 'battery']) {
    if (!topics[sensor]?.name || !topics[sensor]?.type)
      throw new Error(`${file}: ros.topics.${sensor} is incomplete`);
    if (!String(topics[sensor].name).startsWith('/'))
      throw new Error(`${file}: ros.topics.${sensor}.name must be absolute`);
  }
  const actuatorFamily = profile.actuator?.kind;
  if (!['diff-drive', 'omni-drive', 'joint', 'custom'].includes(actuatorFamily))
    throw new Error(`${file}: actuator.kind must be diff-drive, omni-drive, joint, or custom`);
  if (!profile.actuator.commandTopic) throw new Error(`${file}: actuator.commandTopic is required`);
  const commandKey = actuatorFamily === 'joint' ? 'jointCommand' : 'cmdVel';
  if (!topics[commandKey]?.name || !topics[commandKey]?.type)
    throw new Error(`${file}: ros.topics.${commandKey} is required for ${actuatorFamily}`);
  if (profile.actuator.commandTopic !== topics[commandKey].name)
    throw new Error(`${file}: ${commandKey} topic must match actuator.commandTopic`);
  if (profile.actuator.messageType !== topics[commandKey].type)
    throw new Error(`${file}: ${commandKey} type must match actuator.messageType`);
  if (!profile.actuator.messageType?.includes('/'))
    throw new Error(`${file}: actuator.messageType required`);
  const safety = profile.safety || {};
  if (!(safety.maxLinear > 0 && safety.maxLinear <= 0.3))
    throw new Error(`${file}: maxLinear outside platform limit`);
  if (!(safety.maxAngular > 0 && safety.maxAngular <= 1))
    throw new Error(`${file}: maxAngular outside platform limit`);
  if (!(profile.actuator.watchdogMs >= 500)) throw new Error(`${file}: watchdog must be >= 500ms`);
  if (!(profile.policy?.observationSize > 0 && profile.policy?.actionSize > 0))
    throw new Error(`${file}: policy dimensions required`);
  if (
    !Array.isArray(profile.capabilities) ||
    !profile.capabilities.length ||
    profile.capabilities.some((item) => typeof item !== 'string' || !item.trim())
  )
    throw new Error(`${file}: capabilities must be a non-empty string array`);
  if (
    profile.policy.actionSize === 2 &&
    profile.runtime?.actionProjection === 'identity' &&
    !['physical-twist', 'normalized-twist'].includes(String(profile.runtime?.actionOutput || ''))
  )
    throw new Error(
      `${file}: 2D identity policies must declare runtime.actionOutput (physical-twist or normalized-twist)`,
    );
  if (actuatorFamily === 'joint') {
    if (profile.runtime?.actionOutput !== 'joint-position-offset')
      throw new Error(
        `${file}: joint policies must declare runtime.actionOutput=joint-position-offset`,
      );
    if (
      !Array.isArray(profile.runtime?.jointNames) ||
      profile.runtime.jointNames.length !== profile.policy.actionSize
    )
      throw new Error(`${file}: runtime.jointNames must match policy.actionSize`);
    if (
      !Array.isArray(profile.runtime?.homePositionRad) ||
      profile.runtime.homePositionRad.length !== profile.policy.actionSize
    )
      throw new Error(`${file}: runtime.homePositionRad must match policy.actionSize`);
  }
}
console.log(
  `[hardware-adapters] PASS — ${files.length} declarative profiles validated (${[...ids].join(', ')})`,
);
