#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve('profiles');
const files = fs.readdirSync(root).filter((name) => name.endsWith('.json')).sort();
if (!files.length) throw new Error('profiles/ must contain at least one profile');
for (const file of files) {
  const p = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  const fail = (message) => { throw new Error(`${file}: ${message}`); };
  if (p.schemaVersion !== 1 || !p.id || !p.displayName) fail('schema/id/displayName required');
  if (!p.board?.platform || !p.board?.family || !p.board?.model) fail('board identity incomplete');
  for (const [key, topic] of Object.entries(p.ros?.topics || {})) {
    if (!topic.name?.startsWith('/') || !topic.type?.includes('/')) fail(`topic ${key} is incomplete`);
  }
  if (!['diff-drive', 'omni-drive', 'joint', 'custom'].includes(p.actuator?.kind)) fail('unsupported actuator kind');
  if (!p.actuator.commandTopic?.startsWith('/') || !p.actuator.messageType?.includes('/')) fail('actuator command is incomplete');
  if (!(p.actuator.maxLinear > 0 && p.actuator.maxLinear <= .3)) fail('linear safety bound invalid');
  if (!(p.actuator.maxAngular > 0 && p.actuator.maxAngular <= 1)) fail('angular safety bound invalid');
  if (!(p.actuator.watchdogMs >= 500)) fail('watchdog must be >=500ms');
  if (!(p.policy?.observationSize > 0 && p.policy?.actionSize > 0)) fail('policy dimensions required');
}
console.log(`[hardware-profile] PASS — ${files.length} profile(s) validated`);
