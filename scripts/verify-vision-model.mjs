#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, 'vision', 'originbot-yolo11n.json');
const model = JSON.parse(fs.readFileSync(file, 'utf8'));
assert.equal(model.schemaVersion, 1);
assert.equal(model.device.platform, 'rdk-x5');
assert.equal(model.device.input.width, 640);
assert.equal(model.device.input.height, 640);
assert.equal(model.device.input.format, 'nv12');
assert.equal(model.artifact.kind, 'compiled');
assert.equal(model.artifact.format, 'bin');
assert.equal(model.artifact.runtime, 'bpu');
assert.match(
  model.artifact.sourceUrl,
  /^https:\/\/archive\.d-robotics\.cc\/downloads\/rdk_model_zoo\/rdk_x5\//,
);
assert.equal(model.observation.size, model.observation.fields.length);
assert.equal(model.observation.missingTarget, 'zero-with-confidence-0');
assert.equal(model.provenance.mock, false);
console.log(
  '[vision-model] PASS — official X5 YOLO11n manifest and 8D target observation contract validated',
);
