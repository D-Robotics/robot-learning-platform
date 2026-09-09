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
  if (!p.ros?.topics || typeof p.ros.topics !== 'object' || !Object.keys(p.ros.topics).length) fail('ros.topics required');
  const topicNames = new Set();
  for (const [key, topic] of Object.entries(p.ros?.topics || {})) {
    if (!topic.name?.startsWith('/') || !topic.type?.includes('/')) fail(`topic ${key} is incomplete`);
    if (topicNames.has(topic.name)) fail(`topic ${key} duplicates another topic`);
    topicNames.add(topic.name);
    if (topic.qos !== undefined && !['best-effort', 'reliable'].includes(topic.qos)) fail(`topic ${key} qos is invalid`);
  }
  if (!['diff-drive', 'omni-drive', 'joint', 'custom'].includes(p.actuator?.kind)) fail('unsupported actuator kind');
  if (!p.actuator.commandTopic?.startsWith('/') || !p.actuator.messageType?.includes('/')) fail('actuator command is incomplete');
  if (['diff-drive', 'omni-drive'].includes(p.actuator.kind) && !p.ros.topics.cmdVel) fail('drive actuator requires ros.topics.cmdVel');
  if (p.ros?.topics?.cmdVel && p.ros.topics.cmdVel.name !== p.actuator.commandTopic) fail('cmdVel topic must match actuator.commandTopic');
  if (p.ros?.topics?.cmdVel && p.ros.topics.cmdVel.type !== p.actuator.messageType) fail('cmdVel type must match actuator.messageType');
  if (!(p.actuator.maxLinear > 0 && p.actuator.maxLinear <= .3)) fail('linear safety bound invalid');
  if (!(p.actuator.maxAngular > 0 && p.actuator.maxAngular <= 1)) fail('angular safety bound invalid');
  if (!(Number.isInteger(p.actuator.watchdogMs) && p.actuator.watchdogMs >= 500 && p.actuator.watchdogMs <= 2000)) fail('watchdog must be 500..2000ms');
  if (!(Number.isInteger(p.policy?.observationSize) && p.policy.observationSize > 0 && p.policy.observationSize <= 4096)) fail('observation dimensions invalid');
  if (!(Number.isInteger(p.policy?.actionSize) && p.policy.actionSize > 0 && p.policy.actionSize <= 4096)) fail('action dimensions invalid');
  if (!Array.isArray(p.capabilities) || !p.capabilities.length || p.capabilities.some((item) => typeof item !== 'string' || !item.trim())) fail('capabilities must be a non-empty string array');
  if (p.runtime?.decisionHz !== undefined && (!(Number.isFinite(Number(p.runtime.decisionHz))) || Number(p.runtime.decisionHz) < 1 || Number(p.runtime.decisionHz) > 50)) fail('runtime.decisionHz must be 1..50');
  if (p.safety?.sensorStallSec !== undefined && (Number(p.safety.sensorStallSec) < .1 || Number(p.safety.sensorStallSec) > 2)) fail('safety.sensorStallSec must be .1..2');
  if (p.provenance !== undefined) {
    if (!['real', 'synthetic', 'template'].includes(p.provenance.kind)) fail('provenance.kind must be real, synthetic, or template');
    if (typeof p.provenance.mock !== 'boolean') fail('provenance.mock must be boolean');
    if (p.provenance.kind === 'real' && p.provenance.mock) fail('real profile cannot claim mock=true');
    if (p.provenance.kind === 'synthetic' && !p.provenance.mock) fail('synthetic profile must claim mock=true');
  }
}
console.log(`[hardware-profile] PASS — ${files.length} profile(s) validated`);
