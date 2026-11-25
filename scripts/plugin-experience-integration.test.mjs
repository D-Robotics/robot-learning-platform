import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import test from 'node:test';
import { createSim2RealWebApp } from '../services/sim2real-web/server.ts';
import { flushSim2RealAudit } from '../server/sim2real/audit-log.ts';
import { main } from '../plugins/rdk-robot-learning-platform/scripts/experience.mjs';

test('plugin CLI prepares the native OriginMan entry without creating runs', async () => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'rdk-experience-'));
  const oldEnv = { ...process.env };
  let server;
  try {
    process.env.RDK_SIM2REAL_STORAGE_DIR = path.join(scratch, 'ledger');
    process.env.RDK_SIM2REAL_DEPLOYMENT = 'local';
    process.env.RDK_SIM2REAL_REQUIRE_MICRODUCK = '0';
    delete process.env.RDK_SIM2REAL_MICRODUCK_ROOT;
    delete process.env.RDK_SIM2REAL_MICRODUCK_URL;
    delete process.env.RDK_SIM2REAL_AUTH_MODE;
    for (const key of ['COOKIE', 'USERNAME', 'PASSWORD'])
      delete process.env[`RDK_SIM2REAL_MCP_${key}`];
    server = createSim2RealWebApp().listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    process.env.RDK_SIM2REAL_MCP_BASE_URL = base;
    process.env.RDK_ROBOT_LEARNING_PLATFORM_ROOT = process.cwd();
    process.env.RDK_ROBOT_LEARNING_PLATFORM_CONFIG = path.join(scratch, 'missing.json');
    process.env.RDK_ROBOT_LEARNING_PLATFORM_NODE = process.execPath;
    const profile = 'plugins/rdk-robot-learning-platform/references/experience-profile.json';
    const before = await (await fetch(`${base}/api/v1/duck/runs`)).json();
    const result = await main(['prepare', profile]);
    assert.equal(result.status, 'prepared');
    const entry = new URL(result.entryUrl);
    assert.equal(entry.origin, base);
    assert.match(result.entryUrl, /originman/);
    assert.equal(result.execution.simulationRunning, false);
    const after = await (await fetch(`${base}/api/v1/duck/runs`)).json();
    assert.deepEqual(after, before);
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key];
    Object.assign(process.env, oldEnv);
    await flushSim2RealAudit();
    await fs.rm(scratch, { recursive: true, force: true });
  }
});

test('retained MCP core resolves Run prefixes through the platform and stops on lookup failures', async () => {
  const { connectAuthenticatedCore } =
    await import('../plugins/rdk-robot-learning-platform/scripts/authenticated-core.mjs');
  const { experienceProxy } =
    await import('../plugins/rdk-robot-learning-platform/scripts/experience-mcp.mjs');
  const { createSim2RealRun } = await import('../server/sim2real/sim2real-store.ts');
  const { BUILTIN_MICRODUCK_MODEL } = await import('../shared/sim2real.ts');
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'rdk-run-prefix-'));
  const oldEnv = { ...process.env };
  let server, core;
  try {
    process.env.RDK_SIM2REAL_STORAGE_DIR = path.join(scratch, 'ledger');
    process.env.RDK_SIM2REAL_DEPLOYMENT = 'local';
    process.env.RDK_SIM2REAL_REQUIRE_MICRODUCK = '0';
    delete process.env.RDK_SIM2REAL_AUTH_MODE;
    const seed = await createSim2RealRun({
      modelId: BUILTIN_MICRODUCK_MODEL.id,
      backend: 'contract',
      status: 'completed',
      summary: 'Prefix test fixture',
    });
    const ledgerPath = path.join(process.env.RDK_SIM2REAL_STORAGE_DIR, 'sim2real.json');
    const ledger = JSON.parse(await fs.readFile(ledgerPath, 'utf8'));
    const runId = '6a526fe7-5802-4655-a1bf-74a68d748a17';
    ledger.runs = [
      { ...seed, id: '1c372c20-915c-4547-8a7c-a4e0b8add2f4' },
      { ...seed, id: runId },
    ];
    await fs.writeFile(ledgerPath, JSON.stringify(ledger));
    server = createSim2RealWebApp().listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = 'http://127.0.0.1:' + server.address().port;
    const authentication = { audience: base, cookie: async () => null };
    core = await connectAuthenticatedCore({ authentication });
    const proxy = experienceProxy(core, { authentication });
    await proxy('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'run-lookup-integration', version: '1' },
    });
    await proxy('notifications/initialized', {});
    const call = (identifier) =>
      proxy('tools/call', { name: 'rdk_training_status', arguments: { runId: identifier } });

    const unique = await call('6a526fe7');
    assert.equal(unique.isError, undefined);
    const report = unique.structuredContent;
    assert.equal(report.runId, runId);
    assert.equal(report.requestedRunId, '6a526fe7');
    const url = new URL(report.studioNavigation.arguments.url);
    assert.equal(url.searchParams.get('runId'), runId);

    const missing = await call('00000000');
    assert.equal(missing.structuredContent.error.platformCode, 'SIM2REAL_RUN_NOT_FOUND');
    assert.equal(missing.structuredContent.stopWorkflow, true);
    assert.equal(missing.structuredContent.studioNavigation, undefined);

    ledger.runs.unshift({ ...seed, id: '6a526fe7-5888-4888-8888-888888888888' });
    await fs.writeFile(ledgerPath, JSON.stringify(ledger));
    const ambiguous = await call('6a526fe7');
    assert.equal(ambiguous.structuredContent.error.platformCode, 'SIM2REAL_RUN_ID_AMBIGUOUS');
    assert.equal(ambiguous.structuredContent.stopWorkflow, true);
    assert.equal(ambiguous.structuredContent.studioNavigation, undefined);
  } finally {
    await core?.close();
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key];
    Object.assign(process.env, oldEnv);
    await flushSim2RealAudit();
    await fs.rm(scratch, { recursive: true, force: true });
  }
});

test('plugin registers an existing Worker through real platform HTTP and tests the original resource', async () => {
  const { createServer } = await import('node:http');
  const { connectAuthenticatedCore } =
    await import('../plugins/rdk-robot-learning-platform/scripts/authenticated-core.mjs');
  const { experienceProxy } =
    await import('../plugins/rdk-robot-learning-platform/scripts/experience-mcp.mjs');
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'rdk-worker-register-'));
  const oldEnv = { ...process.env };
  let server, core, worker;
  try {
    process.env.RDK_SIM2REAL_STORAGE_DIR = path.join(scratch, 'ledger');
    process.env.RDK_SIM2REAL_DEPLOYMENT = 'local';
    delete process.env.RDK_SIM2REAL_AUTH_MODE;
    worker = createServer((request, response) => {
      assert.equal(request.url, '/healthz');
      assert.equal(request.headers.authorization, 'Bearer fixture-private-worker-token');
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ ok: true, engines: ['starter-ppo'], mock: true, cuda: false }));
    }).listen(0, '127.0.0.1');
    await once(worker, 'listening');
    const runnerUrl = `http://127.0.0.1:${worker.address().port}/train`;
    const file = path.join(scratch, 'worker.json');
    await fs.writeFile(
      file,
      JSON.stringify({
        name: 'Isolated registration fixture',
        runnerUrl,
        runnerToken: 'fixture-private-worker-token',
      }),
      { mode: 0o600 },
    );
    server = createSim2RealWebApp().listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = 'http://127.0.0.1:' + server.address().port;
    const authentication = {
      audience: base,
      cookie: async () => null,
      status: async () => ({ authenticated: true, accountId: 'fixture-owner' }),
    };
    core = await connectAuthenticatedCore({ authentication });
    const proxy = experienceProxy(core, { authentication });
    const call = () =>
      proxy('tools/call', {
        name: 'rdk_development_targets',
        arguments: { action: 'register-compute', connectionFile: file },
      });
    const first = await call();
    assert.equal(first.isError, undefined, JSON.stringify(first));
    assert.equal(first.structuredContent.connected, true);
    const repeated = await call();
    assert.equal(
      repeated.structuredContent.computeResourceId,
      first.structuredContent.computeResourceId,
    );
    assert.ok(!JSON.stringify(first).includes('fixture-private-worker-token'));
    const records = await (await fetch(base + '/api/sim2real/compute-resources')).json();
    assert.equal(records.computeResources.length, 1);
    assert.equal(records.computeResources[0].mock, true);
    assert.equal(records.computeResources[0].runnerToken, undefined);
  } finally {
    await core?.close();
    for (const service of [server, worker])
      if (service) {
        service.closeAllConnections();
        await new Promise((resolve) => service.close(resolve));
      }
    for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key];
    Object.assign(process.env, oldEnv);
    await flushSim2RealAudit();
    await fs.rm(scratch, { recursive: true, force: true });
  }
});

test('plugin choreography is screened before dispatch and a retry returns its existing Run', async () => {
  const { createHash } = await import('node:crypto');
  const { createServer } = await import('node:http');
  const { connectAuthenticatedCore } =
    await import('../plugins/rdk-robot-learning-platform/scripts/authenticated-core.mjs');
  const { experienceProxy } =
    await import('../plugins/rdk-robot-learning-platform/scripts/experience-mcp.mjs');
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'rdk-reference-screen-'));
  const oldEnv = { ...process.env };
  let server, core, worker;
  try {
    process.env.RDK_SIM2REAL_STORAGE_DIR = path.join(scratch, 'ledger');
    process.env.RDK_SIM2REAL_DEPLOYMENT = 'local';
    delete process.env.RDK_SIM2REAL_AUTH_MODE;
    delete process.env.RDK_ORIGINMAN_MOTION_DIR;
    let screens = 0;
    let launches = 0;
    let screenMode = 'fail';
    worker = createServer(async (request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.url === '/healthz') {
        response.end(
          JSON.stringify({ ok: true, engines: ['originman-reference-ppo'], mock: false }),
        );
      } else if (request.url === '/originman-reference/screen') {
        screens++;
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = Buffer.concat(chunks);
        const framesExpected = JSON.parse(body).joint_pos.length;
        if (screenMode === 'busy') {
          response.writeHead(409).end('{}');
          return;
        }
        const completed = screenMode !== 'fail';
        response.end(
          JSON.stringify({
            ok: true,
            referenceSha256:
              screenMode === 'unverified'
                ? 'a'.repeat(64)
                : createHash('sha256').update(body).digest('hex'),
            sceneSha256: 'b'.repeat(64),
            calibrationSha256: 'c'.repeat(64),
            gate: {
              completed,
              framesExpected,
              framesEvaluated: completed ? framesExpected : 8,
              firstFailedFrame: completed ? null : 8,
              maxTiltDeg: completed ? 20 : 33,
            },
          }),
        );
      } else if (request.url === '/train') {
        launches++;
        response.end(
          JSON.stringify({ status: 'running', runId: 'reference-fixture-job', mock: false }),
        );
      } else {
        response.writeHead(404).end('{}');
      }
    }).listen(0, '127.0.0.1');
    await once(worker, 'listening');
    server = createSim2RealWebApp().listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = 'http://127.0.0.1:' + server.address().port;
    const request = (route, body) =>
      fetch(
        base + '/api/v1/duck/' + route,
        body === undefined
          ? {}
          : {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            },
      );
    const created = await request('compute-resources', {
      name: 'Reference screening fixture',
      runnerUrl: 'http://127.0.0.1:' + worker.address().port + '/train',
    });
    assert.equal(created.status, 201);
    const { computeResource } = await created.json();
    const check = await request('compute-resources/' + computeResource.id + '/test', {});
    assert.ok(check.ok, await check.clone().text());
    const authentication = {
      audience: base,
      cookie: async () => null,
      status: async () => ({ authenticated: true, accountId: 'fixture-owner' }),
    };
    core = await connectAuthenticatedCore({ authentication });
    const proxy = experienceProxy(core, { authentication });
    const call = (args = {}) =>
      proxy('tools/call', {
        name: 'rdk_originman_dance_train',
        arguments: {
          contextId: 'reference-screen',
          computeResourceId: computeResource.id,
          dance: { blocks: [{ id: 'example-arms' }] },
          numEnvs: 1,
          referenceTrainingSteps: 8192,
          ...args,
        },
      });
    const failed = await call();
    assert.equal(
      failed.structuredContent?.error?.platformCode,
      'ORIGINMAN_REFERENCE_SCREEN_REQUIRED',
      JSON.stringify(failed),
    );
    screenMode = 'unverified';
    const unverified = await call();
    assert.equal(unverified.structuredContent?.error?.httpStatus, 503, JSON.stringify(unverified));
    assert.equal(launches, 0);
    assert.equal((await (await request('runs')).json()).runs.length, 0);
    screenMode = 'pass';
    const submitted = await call();
    assert.equal(submitted.structuredContent?.run?.status, 'running', JSON.stringify(submitted));
    const runId = submitted.structuredContent.run.id;
    screenMode = 'busy';
    assert.equal((await call()).structuredContent?.run?.id, runId);
    const conflict = await call({ numEnvs: 2 });
    assert.equal(conflict.structuredContent?.error?.platformCode, 'SIM2REAL_IDEMPOTENCY_CONFLICT');
    assert.equal(
      (await call({ contextId: 'reference-new' })).structuredContent?.error?.httpStatus,
      409,
    );
    assert.equal(screens, 4);
    assert.equal(launches, 1);
  } finally {
    await core?.close();
    for (const service of [server, worker])
      if (service) {
        service.closeAllConnections();
        await new Promise((resolve) => service.close(resolve));
      }
    for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key];
    Object.assign(process.env, oldEnv);
    await flushSim2RealAudit();
    await fs.rm(scratch, { recursive: true, force: true });
  }
});
