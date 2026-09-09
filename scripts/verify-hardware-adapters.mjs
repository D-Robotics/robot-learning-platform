#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('adapters');
const files = fs.readdirSync(root).filter((name) => name.endsWith('.json')).sort();
if (files.length < 2) throw new Error('at least two hardware adapter profiles are required');
const ids = new Set();
for (const file of files) {
  const profile = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  if (!profile.id || ids.has(profile.id)) throw new Error(`invalid or duplicate adapter id: ${file}`);
  ids.add(profile.id);
  if (!Array.isArray(profile.platforms) || !profile.platforms.length) throw new Error(`${file}: platforms required`);
  for (const sensor of ['imu', 'odom', 'battery']) {
    if (!profile.sensors?.[sensor]?.topic) throw new Error(`${file}: sensors.${sensor}.topic required`);
  }
  if (profile.actuator?.type !== 'twist' || !profile.actuator.topic) throw new Error(`${file}: only declared twist actuator profiles are accepted`);
  const safety = profile.safety || {};
  if (!(safety.maxLinear > 0 && safety.maxLinear <= 0.3)) throw new Error(`${file}: maxLinear outside platform limit`);
  if (!(safety.maxAngular > 0 && safety.maxAngular <= 1)) throw new Error(`${file}: maxAngular outside platform limit`);
  if (!(safety.watchdogMs >= 500)) throw new Error(`${file}: watchdog must be >= 500ms`);
}
console.log(`[hardware-adapters] PASS — ${files.length} declarative profiles validated (${[...ids].join(', ')})`);
