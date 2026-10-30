#!/usr/bin/env node
/** Read-only combination checks against an explicitly selected retained candidate. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  connectMcp,
  readToolResult,
} from '../plugins/rdk-robot-learning-platform/scripts/experience.mjs';
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(
    'Usage: node scripts/verify-originman-retained-release.mjs --baseline <root> --candidate <root> --output <private-json>; configure RDK_SIM2REAL_MCP_BASE_URL for the owned test instance. No training is submitted.',
  );
  process.exit(0);
}
function arg(key) {
  const i = args.indexOf(key);
  if (i < 0 || !args[i + 1]) throw new Error(`Missing ${key}`);
  return path.resolve(args[i + 1]);
}
const baseline = arg('--baseline'),
  candidate = arg('--candidate'),
  output = arg('--output');
if (!process.env.RDK_SIM2REAL_MCP_BASE_URL)
  throw new Error('Select the owned test instance explicitly.');
const connections = [];
async function connect(root) {
  const client = connectMcp({
    command: process.execPath,
    args: [path.join(root, 'dist-server/services/duck-lab-mcp/server.js')],
  });
  connections.push(client);
  await client.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'originman-retained-regression', version: '1' },
  });
  return client;
}
try {
  const old = await connect(baseline),
    current = await connect(candidate);
  const before = (await old.request('tools/list')).tools,
    after = (await current.request('tools/list')).tools;
  for (const tool of before) {
    const kept = after.find((item) => item.name === tool.name);
    assert.ok(kept, `Lost upstream tool: ${tool.name}`);
    assert.deepEqual(kept.annotations, tool.annotations, `Changed safety annotation: ${tool.name}`);
    for (const name of Object.keys(tool.inputSchema.properties ?? {}))
      assert.ok(name in kept.inputSchema.properties, `Lost argument ${tool.name}.${name}`);
    for (const name of tool.inputSchema.required ?? [])
      assert.ok(
        kept.inputSchema.required?.includes(name),
        `Lost required argument ${tool.name}.${name}`,
      );
  }
  assert.ok(after.some((tool) => tool.name === 'rdk_workshop_catalog'));
  const call = async (name, argumentsValue = {}) =>
    readToolResult(await current.request('tools/call', { name, arguments: argumentsValue }));
  const ids = async () => (await call('rdk_runs_list')).runs.map((run) => run.id).sort();
  const initial = await ids();
  const reference = await call('rdk_workshop_catalog', { robot: 'originman' });
  assert.equal(reference.robot, 'originman');
  assert.equal(reference.manifest.contract.observationSize, 14);
  assert.equal(reference.manifest.contract.actionSize, 2);
  const failures = [];
  for (const argumentsValue of [
    { backend: 'locla' },
    { unsupportedTrajectoryPath: '/not-an-upload' },
  ]) {
    const result = await current.request('tools/call', {
      name: 'rdk_training_submit',
      arguments: argumentsValue,
    });
    assert.equal(
      result.isError,
      true,
      'Invalid training input must be rejected without a new Run.',
    );
    failures.push(result);
  }
  const preflight = await call('rdk_training_preflight', { taskId: 'originman-recovery' });
  assert.equal(preflight.report.engine, 'originman-recovery');
  assert.equal(preflight.report.trainingPerformed, false);
  assert.equal(preflight.report.hardwareEligible, false);
  assert.equal(preflight.report.readyForSmokeTraining, true);
  assert.equal(preflight.report.checks.length, 7);
  assert.deepEqual(await ids(), initial, 'Read-only preflight or invalid input created a Run.');
  const report = {
    passed: true,
    scope:
      'Retained runtime catalog/schema preservation and actual OriginMan environment probe. Not Studio user-login or hardware acceptance.',
    baselineTools: before.length,
    candidateTools: after.length,
    preservedToolNames: before.map((tool) => tool.name),
    referenceAvailable: reference.reference?.available === true,
    preflight,
    invalidInputResults: failures,
    runCountBefore: initial.length,
    trainingSubmitted: false,
    hardwareVerified: false,
  };
  await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(
    JSON.stringify({
      passed: true,
      baselineTools: before.length,
      candidateTools: after.length,
      preflightReady: true,
      runsUnchanged: true,
    }),
  );
} finally {
  await Promise.allSettled(connections.map((client) => client.close()));
}
