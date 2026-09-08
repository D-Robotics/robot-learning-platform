#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const manifestPath = path.join(root, 'examples', 'rdk-duck-policy-manifest.json');
const starterManifestPath = path.join(root, 'examples', 'starter-ppo-manifest.json');
const telemetryPath = path.join(root, 'examples', 'telemetry-sample.jsonl');
const microduckDemoTelemetryPath = path.join(
  root,
  'services',
  'sim2real-web',
  'public',
  'demo',
  'microduck-telemetry-sample.jsonl',
);
const localEnginePath = path.join(root, 'examples', 'local-engine-reference.mjs');

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
if (!fs.existsSync(localEnginePath)) fail('local-engine-reference.mjs is missing');
if (!fs.readFileSync(localEnginePath, 'utf8').includes('RDK_SIM2REAL_RESULT_FILE'))
  fail('local engine example must implement the worker result-file protocol');
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

// The starter-ppo manifest must stay aligned with the real engine in
// engines/starter-ppo/runner.py: dimensions, layout sum, and the declared
// CPU-onnx locomotion runtime all gate what demo:starter trains and exports.
const starterManifest = readJson(starterManifestPath);
if (starterManifest.schemaVersion !== 1) fail('starter manifest schemaVersion must be 1');
if (starterManifest.robot?.id !== 'rdk-duck') fail('starter manifest must describe rdk-duck');
const starterContract = starterManifest.contract;
if (starterContract.observationSize !== 42 || starterContract.actionSize !== 12) {
  fail('starter manifest must declare the engine 42D/12D contract');
}
const layoutTotal = (starterContract.observationLayout || []).reduce(
  (sum, item) => sum + item.size,
  0,
);
if (layoutTotal !== starterContract.observationSize) {
  fail('starter manifest observationLayout must sum to observationSize');
}
if (starterContract.decimation !== 10 || starterContract.controlHz !== 50) {
  fail('starter manifest must declare the engine 50Hz x decimation 10 loop');
}
const starterPolicy = (starterManifest.artifacts || []).find(
  (item) => item.role === 'policy' && item.format === 'onnx',
);
if (
  !starterPolicy ||
  starterPolicy.runtime !== 'cpu-onnx' ||
  starterPolicy.workload !== 'locomotion' ||
  starterPolicy.threads !== 1
) {
  fail('starter manifest must declare the one-thread cpu-onnx locomotion policy');
}
if (!fs.existsSync(path.join(root, 'engines', 'starter-ppo', 'runner.py'))) {
  fail('engines/starter-ppo/runner.py is missing');
}

// Execute the reference engine once with a disposable request/result pair so
// the public example is proven runnable, not merely present in the tree.
const exampleScratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rdk-sim2real-example-'));
try {
  const requestFile = path.join(exampleScratch, 'request.json');
  const resultFile = path.join(exampleScratch, 'result.json');
  fs.writeFileSync(
    requestFile,
    JSON.stringify(
      {
        schemaVersion: 1,
        contractId: manifest.contract.id,
        model: { modelId: manifest.modelId, version: manifest.version },
        contract: manifest.contract,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  const execution = spawnSync(process.execPath, [localEnginePath], {
    cwd: root,
    env: {
      ...process.env,
      RDK_SIM2REAL_REQUEST_FILE: requestFile,
      RDK_SIM2REAL_RESULT_FILE: resultFile,
      RDK_SIM2REAL_EXAMPLE_DELAY_MS: '0',
    },
    encoding: 'utf8',
  });
  if (execution.status !== 0) {
    fail(`local engine example failed: ${execution.stderr || execution.stdout || 'unknown error'}`);
  }
  const result = readJson(resultFile);
  if (result.deployable !== false || result.cuda !== false) {
    fail('local engine example must remain a non-deployable, CPU protocol fixture');
  }
  if (!String(result.checkpoint?.artifactRef || '').startsWith('artifact://')) {
    fail('local engine example must emit an opaque checkpoint artifact reference');
  }
} finally {
  fs.rmSync(exampleScratch, { recursive: true, force: true });
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

// The browser's one-click demo fixture is deliberately checked separately
// from the RDK Duck example above. It must stay aligned with the MicroDuck
// contract so a presentation cannot silently load the wrong vector shape.
if (!fs.existsSync(microduckDemoTelemetryPath)) {
  fail('MicroDuck demo telemetry fixture is missing');
}
const microduckLines = fs
  .readFileSync(microduckDemoTelemetryPath, 'utf8')
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);
if (microduckLines.length < 3) fail('MicroDuck demo telemetry must contain a header and samples');
const microduckHeader = readJsonFromLine(microduckLines[0], 0);
if (
  microduckHeader.type !== 'header' ||
  microduckHeader.source !== 'demo-fixture' ||
  microduckHeader.contractId !== 'microduck-policy-v1'
) {
  fail('MicroDuck demo telemetry header must identify the synthetic microduck-policy-v1 fixture');
}
let microduckPrevious = -Infinity;
let microduckSamples = 0;
for (const [index, line] of microduckLines.slice(1).entries()) {
  const sample = readJsonFromLine(line, index + 1);
  if (sample.type !== 'step') fail(`MicroDuck demo telemetry line ${index + 2} must be a step`);
  if (!Number.isFinite(sample.t) || sample.t < microduckPrevious) {
    fail(`MicroDuck demo telemetry line ${index + 2} has bad t`);
  }
  microduckPrevious = sample.t;
  for (const [field, expectedSize] of [
    ['observation', 61],
    ['action', 14],
  ]) {
    if (!Array.isArray(sample[field]) || sample[field].length !== expectedSize) {
      fail(`MicroDuck demo telemetry line ${index + 2} ${field} must contain exactly ${expectedSize} values`);
    }
    if (sample[field].some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
      fail(`MicroDuck demo telemetry line ${index + 2} ${field} contains a non-finite/non-number value`);
    }
  }
  microduckSamples += 1;
}
if (microduckSamples < 2) fail('MicroDuck demo telemetry must contain at least two steps');

function readJsonFromLine(line, index) {
  try {
    return JSON.parse(line);
  } catch (error) {
    fail(`telemetry line ${index + 1} is not valid JSON: ${error instanceof Error ? error.message : error}`);
  }
}

console.log(
  `[examples] PASS — manifests (rdk-duck + starter-ppo) + ${lines.length} ordered RDK Duck samples + ${microduckSamples} MicroDuck demo samples`,
);
