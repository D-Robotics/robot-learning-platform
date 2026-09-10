#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const [id = 'new-robot', family = 'diff-drive', displayName = 'New RDK Robot'] =
  process.argv.slice(2);
const families = new Set(['diff-drive', 'omni-drive', 'joint', 'custom']);
if (!/^[a-z][a-z0-9-]{1,63}$/.test(id) || !families.has(family)) {
  throw new Error(
    'usage: node scripts/create-robot-adapter.mjs <id> [diff-drive|omni-drive|joint|custom] [displayName]',
  );
}
if (!String(displayName).trim()) throw new Error('displayName must not be empty');

const profileId = `${id}-profile`;
const commandTopic = '/CHANGE_ME';
const drive = family === 'diff-drive';
const policyActionSize = drive ? 2 : 1;
const manifest = {
  schemaVersion: 1,
  id,
  displayName,
  hardwareProfileId: profileId,
  board: {
    platform: 'rdk-x5',
    family: 'rdk-custom',
    model: 'CHANGE_ME',
  },
  ros: {
    setupPaths: ['/opt/tros/humble/setup.bash', '/userdata/dev_ws/install/setup.bash'],
    topics: {
      imu: { name: '/CHANGE_ME/imu', type: 'sensor_msgs/msg/Imu', required: false },
      odom: { name: '/CHANGE_ME/odom', type: 'nav_msgs/msg/Odometry', required: false },
      battery: {
        name: '/CHANGE_ME/battery',
        type: 'sensor_msgs/msg/BatteryState',
        required: false,
      },
      cmdVel: { name: commandTopic, type: 'geometry_msgs/msg/Twist', required: true },
    },
  },
  actuator: {
    kind: family,
    commandTopic,
    messageType: 'geometry_msgs/msg/Twist',
    linearAxis: 'x',
    angularAxis: 'z',
    maxLinear: 0.1,
    maxAngular: 0.5,
    watchdogMs: 500,
  },
  runtime: {
    decisionHz: 10,
    actionProjection: drive ? 'identity' : 'custom',
  },
  safety: { maxLinear: 0.1, maxAngular: 0.5, sensorStallSec: 0.5 },
  policy: {
    observationAdapterId: `${id}-observation-v1`,
    actionAdapterId: `${id}-action-v1`,
    observationSize: 1,
    actionSize: policyActionSize,
  },
  capabilities: ['CHANGE_ME'],
  provenance: {
    kind: 'template',
    mock: true,
    note: 'Replace every CHANGE_ME value and pass conformance tests before use.',
  },
};

const adapterPath = path.join('adapters', `${id}.json`);
const profilePath = path.join('profiles', `${profileId}.json`);
for (const target of [adapterPath, profilePath]) {
  if (fs.existsSync(target)) throw new Error(`refusing to overwrite existing file: ${target}`);
}
for (const directory of ['adapters', 'profiles']) fs.mkdirSync(directory, { recursive: true });

const profile = { ...manifest, id: profileId };
delete profile.hardwareProfileId;
fs.writeFileSync(adapterPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
fs.writeFileSync(profilePath, `${JSON.stringify(profile, null, 2)}\n`, { flag: 'wx' });
console.log(`[adapter-scaffold] created ${adapterPath} and ${profilePath}`);
console.log('[adapter-scaffold] template remains mock=true until CHANGE_ME fields are validated on hardware');
