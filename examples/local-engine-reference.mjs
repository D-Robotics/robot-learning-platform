#!/usr/bin/env node

/**
 * Minimal external-engine adapter for local-training-worker.mjs.
 *
 * This program is intentionally not a reinforcement-learning implementation.
 * It demonstrates the file protocol that a real MicroDuck/RDK Duck trainer
 * must implement:
 *   1. read RDK_SIM2REAL_REQUEST_FILE;
 *   2. run the training job in this process;
 *   3. write a result containing a managed artifact:// reference to
 *      RDK_SIM2REAL_RESULT_FILE.
 *
 * The generated reference is a protocol fixture, not a downloadable model.
 * Replace this file with the organisation's PPO/Isaac/MuJoCo entrypoint in a
 * deployment and keep the worker's shell:false boundary unchanged.
 */

import { readFile, writeFile } from 'node:fs/promises';

const requestPath = String(process.env.RDK_SIM2REAL_REQUEST_FILE ?? '').trim();
const resultPath = String(process.env.RDK_SIM2REAL_RESULT_FILE ?? '').trim();

if (!requestPath || !resultPath) {
  throw new Error(
    'RDK_SIM2REAL_REQUEST_FILE and RDK_SIM2REAL_RESULT_FILE are required; run this through local-training-worker.mjs',
  );
}

const request = JSON.parse(await readFile(requestPath, 'utf8'));
if (!request || typeof request !== 'object' || Array.isArray(request)) {
  throw new Error('request.json must contain an object');
}
if (request.schemaVersion !== 1) throw new Error('schemaVersion must be 1');

const contract = request.contract;
const model = request.model;
if (!contract || typeof contract !== 'object' || Array.isArray(contract)) {
  throw new Error('request.contract is required');
}
if (!model || typeof model !== 'object' || Array.isArray(model)) {
  throw new Error('request.model is required');
}

const modelId = String(model.modelId ?? '').trim();
const version = String(model.version ?? '').trim();
const observationSize = Number(contract.observationSize);
const actionSize = Number(contract.actionSize);
if (!modelId || !version) throw new Error('model.modelId and model.version are required');
if (!Number.isSafeInteger(observationSize) || observationSize < 1) {
  throw new Error('contract.observationSize must be a positive integer');
}
if (!Number.isSafeInteger(actionSize) || actionSize < 1) {
  throw new Error('contract.actionSize must be a positive integer');
}

// A real engine would call its trainer here. The short delay makes the
// example useful in a local end-to-end demo without hiding that it is only a
// protocol fixture.
const delayMs = Number(process.env.RDK_SIM2REAL_EXAMPLE_DELAY_MS ?? 100);
if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > 30_000) {
  throw new Error('RDK_SIM2REAL_EXAMPLE_DELAY_MS must be between 0 and 30000');
}
if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));

const safePart = (value) =>
  value
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'model';
const artifactKey = `${safePart(modelId)}/${safePart(version)}`;

await writeFile(
  resultPath,
  JSON.stringify(
    {
      checkpoint: {
        checkpointId: `reference-${safePart(version)}`,
        artifactRef: `artifact://example/${artifactKey}/checkpoint`,
        iteration: 1,
      },
      artifact: {
        artifactId: `reference-${safePart(modelId)}`,
        artifactRef: `artifact://example/${artifactKey}/policy`,
        kind: 'source',
        format: 'unknown',
        deployable: false,
      },
      metrics: {
        contractValid: true,
        observationSize,
        actionSize,
        reward: 0,
        iterations: 1,
      },
      // This is deliberately false: the reference has not produced a model
      // that can be deployed to an RDK board.
      deployable: false,
      cuda: false,
    },
    null,
    2,
  ),
  { mode: 0o600 },
);

console.log(`reference engine wrote protocol result for ${modelId}@${version}`);
