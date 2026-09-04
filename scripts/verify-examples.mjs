#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const manifestPath = path.join(root, 'examples', 'rdk-duck-policy-manifest.json');
const telemetryPath = path.join(root, 'examples', 'telemetry-sample.jsonl');

function fail(message) {
  throw new Error(`[examples] ${message}`);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`${path.relative(root, file)} is not valid JSON: ${error instanceof Error ? error.message : error}`);
  }
}

const manifest = readJson(manifestPath);
if (manifest.schemaVersion !== 1) fail('manifest schemaVersion must be 1');
if (manifest.robot?.id !== 'rdk-duck') fail('manifest must describe rdk-duck');
if (manifest.contract?.id !== 'rdk-duck-policy-v1') fail('manifest contract id is unexpected');
const observationSize = manifest.contract?.observationSize;
const actionSize = manifest.contract?.actionSize;
if (!Number.isSafeInteger(observationSize) || observationSize <= 0)
  fail('manifest contract observationSize must be a positive integer');
if (!Number.isSafeInteger(actionSize) || actionSize <= 0)
  fail('manifest contract actionSize must be a positive integer');
if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0)
  fail('manifest must contain an artifact');
if (!manifest.artifacts.some((item) => item.role === 'policy' && item.format === 'onnx'))
  fail('manifest must contain an ONNX policy artifact');
for (const artifact of manifest.artifacts) {
  if (typeof artifact.ref !== 'string' || !artifact.ref.startsWith('artifact://'))
    fail(`artifact ${artifact.id || '<unknown>'} must use artifact://`);
}

const lines = fs
  .readFileSync(telemetryPath, 'utf8')
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);
if (lines.length < 2) fail('telemetry sample must contain at least two lines');
let previous = -Infinity;
for (const [index, line] of lines.entries()) {
  const sample = readJsonFromLine(line, index);
  if (!Number.isFinite(sample.t) || sample.t < previous) fail(`telemetry line ${index + 1} has bad t`);
  previous = sample.t;
  for (const [field, expectedSize] of [
    ['observation', observationSize],
    ['action', actionSize],
  ]) {
    if (!Array.isArray(sample[field]) || sample[field].length !== expectedSize) {
      fail(`telemetry line ${index + 1} ${field} must contain exactly ${expectedSize} values`);
    }
    if (sample[field].some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
      fail(`telemetry line ${index + 1} ${field} contains a non-finite/non-number value`);
    }
  }
}

function readJsonFromLine(line, index) {
  try {
    return JSON.parse(line);
  } catch (error) {
    fail(`telemetry line ${index + 1} is not valid JSON: ${error instanceof Error ? error.message : error}`);
  }
}

console.log(`[examples] PASS — manifest + ${lines.length} ordered telemetry samples`);
