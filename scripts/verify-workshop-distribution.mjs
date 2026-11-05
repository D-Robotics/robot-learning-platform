#!/usr/bin/env node
/** Real stdio/HTTP lifecycle against an explicitly synthetic classroom server; never claims learned policy quality. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  connectMcp,
  readToolResult,
} from '../plugins/rdk-robot-learning-platform/scripts/experience.mjs';
const args = process.argv.slice(2);
const failureCase = args[2] === '--failure-case';
if (
  ![2, 3].includes(args.length) ||
  (args.length === 3 && !failureCase) ||
  args[0] !== '--plugin-dir'
)
  throw Error(
    'Usage: node scripts/verify-workshop-distribution.mjs --plugin-dir <built-distribution>',
  );
const distribution = path.resolve(args[1]);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rdk-course-journey-'));
const root = path.join(temp, '课程 plugin');
fs.cpSync(distribution, root, { recursive: true });
const home = path.join(temp, 'private-home');
fs.mkdirSync(home);
let client, server;
const state = {
  approved: false,
  authStarts: 0,
  models: [],
  runs: new Map(),
  writes: [],
  mediaRequests: 0,
  historyRequests: 0,
  brokenDigest: false,
};
const hash = 'a'.repeat(64);
let origin;
const evidence = (phase, sourceRunId) => ({
  schemaVersion: 1,
  hardwareEligible: false,
  phase,
  seed: 7,
  requestedTimesteps: 8192,
  actualTimesteps: 8192,
  pushMaxForce: 8.1,
  policySha256: hash,
  ...(phase === 'evaluate'
    ? {
        sourceRunId,
        baselineRecovered: 31,
        rlRecovered: 0,
        normalStanding: false,
        clearGain: false,
        selectedCase: 0,
        cases: Array.from({ length: 31 }, (_, i) => ({
          index: i,
          force:
            i === 30
              ? 0
              : [-7.9, -7.55, -7.3, -7.05, -6.8, 6.8, 7.05, 7.3, 7.55, 7.9][Math.floor(i / 3)],
          start: i === 30 ? 2.75 : [1.55, 2.75, 3.95][i % 3],
          baseline: true,
          initial: true,
          rl: false,
          frozen: false,
          fallen: true,
        })),
        traces: ['reference', 'imu-feedback', 'untrained', 'rl'].map((controller) => ({
          controller,
          frames: [[0, 0, 0, 0]],
        })),
        video: { sha256: 'b'.repeat(64), bytes: 100 },
      }
    : {}),
});
const cookie = 'rdk_sso_web_session=owned-fixture';
const login = {
  id: randomBytes(16).toString('hex'),
  secret: randomBytes(32).toString('base64url'),
};
try {
  server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://fixture');
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : {};
      const route = url.pathname
        .replace(/^\/robotics-learning/, '')
        .replace('/api/sim2real/', '/api/v1/duck/');
      const json = (value, status = 200) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      if (route === '/api/sso/plugin/start') {
        state.authStarts++;
        return json({
          ...login,
          verificationUrl: origin + '/api/sso/plugin/authorize?id=' + login.id,
          userCode: login.id.slice(0, 8).toUpperCase(),
          expiresAt: Date.now() + 300000,
        });
      }
      if (route === '/api/sso/plugin/poll') {
        assert.equal(body.id, login.id);
        assert.equal(req.headers.authorization, 'Bearer ' + login.secret);
        return state.approved
          ? json({
              status: 'authenticated',
              accountId: 'classroom-fixture',
              expiresAt: Date.now() + 600000,
              cookie,
            })
          : json({ status: 'pending' }, 202);
      }
      if (route === '/api/sso/me')
        return json({ user: req.headers.cookie === cookie ? { id: 'classroom-fixture' } : null });
      if (route === '/healthz') return json({ ready: true, degraded: [] });
      if (req.headers.cookie !== cookie) return json({ error: 'LOGIN_REQUIRED' }, 401);
      if (route === '/api/v1/duck/auth/session')
        return json({ authenticated: true, accountId: 'classroom-fixture' });
      if (route === '/api/v1/duck/overview')
        return json({ models: state.models, runs: [...state.runs.values()].map((x) => x.run) });
      if (route === '/api/v1/duck/lineage') {
        const run = state.runs.get(url.searchParams.get('runId'))?.run;
        return run ? json({ lineage: { run } }) : json({ error: 'NOT_FOUND' }, 404);
      }
      if (route === '/api/v1/duck/models/validate')
        return json({
          validation: {
            valid: body.manifest?.contract?.observationSize === 14,
            errors: [],
            warnings: [],
          },
        });
      if (route === '/api/v1/duck/models' && req.method === 'GET')
        return json({ models: state.models });
      if (route === '/api/v1/duck/models' && req.method === 'POST') {
        assert.equal(state.models.length, 0);
        assert.match(req.headers['idempotency-key'], /^dsh-model-originman-course-[a-f0-9]{64}-0$/);
        state.models.push({ id: 'model-fixture', manifest: body });
        return json(
          { model: state.models[0], productId: 'originman', contractId: body.contract.id },
          201,
        );
      }
      if (route === '/api/v1/duck/compute-resources')
        return json({
          computeResources: [
            { id: 'worker-fixture', name: 'OriginMan classroom', source: 'server-runner' },
          ],
        });
      if (route === '/api/v1/duck/compute-resources/worker-fixture/test')
        return json({
          ok: true,
          connected: true,
          computeResource: { id: 'worker-fixture', status: 'online', cuda: true },
        });
      if (route === '/api/v1/duck/runs' && req.method === 'GET') {
        state.historyRequests++;
        return json({ runs: [] });
      }
      if (route === '/api/v1/duck/runs' && req.method === 'POST') {
        const phase = body.training.originmanWorkshop.phase;
        const id = phase === 'train' ? 'train-fixture' : 'eval-fixture';
        assert.equal(body.computeResourceId, 'worker-fixture');
        assert.equal(body.training.originmanWorkshop.device, 'cuda');
        assert.equal(body.training.originmanWorkshop.timesteps, 8192);
        assert.ok(!state.runs.has(id), 'duplicate submission');
        // The retained legacy core does not expose groupId in its submit schema.
        // The wrapper must preserve the operation through its stable submission key.
        assert.match(req.headers['idempotency-key'], /^dsh-training-om-[a-f0-9]+-(train|eval)-0$/);
        if (phase === 'evaluate')
          assert.equal(
            req.headers['idempotency-key'].replace('-eval-0', '-train-0'),
            state.trainKey,
          );
        if (phase === 'evaluate')
          assert.equal(body.training.originmanWorkshop.sourceRunId, 'train-fixture');
        const run = {
          id,
          modelId: body.modelId,
          status: failureCase && phase === 'train' ? 'failed' : 'running',
          mock: false,
          backend: 'local',
          taskId: body.taskId,
          contractId: 'custom-policy-originman-recovery-v1',
          computeResourceId: body.computeResourceId,
          training: body.training,
          artifact: { sha256: hash },
          metrics: {
            contractValid: true,
            observationSize: 14,
            actionSize: 2,
            originmanWorkshop: evidence(phase, body.training.originmanWorkshop.sourceRunId),
          },
        };
        state.runs.set(id, { run, reads: 0 });
        if (phase === 'train') state.trainKey = req.headers['idempotency-key'];
        state.writes.push(body);
        return json({ run }, 201);
      }
      const matched = /^\/api\/v1\/duck\/runs\/([^/]+)(?:\/(lineage|workshop-video))?$/.exec(route);
      if (matched) {
        const stored = state.runs.get(matched[1]);
        if (!stored) return json({ error: 'NOT_FOUND' }, 404);
        const run = structuredClone(stored.run);
        if (matched[2] === 'workshop-video') {
          state.mediaRequests++;
          return json({ error: 'fixture media is intentionally not served' }, 501);
        }
        if (matched[2] === 'lineage') return json({ lineage: { run } });
        stored.reads++;
        if (stored.reads >= 2 && !failureCase) {
          stored.run.status = 'completed';
          run.status = 'completed';
        }
        if (state.brokenDigest && run.id === 'eval-fixture')
          run.metrics.originmanWorkshop.policySha256 = 'c'.repeat(64);
        return json({ run });
      }
      return json({ error: 'UNEXPECTED_ROUTE', route }, 404);
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'FIXTURE_ASSERTION', message: error.message }));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + server.address().port;
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  for (const key of Object.keys(env))
    if (key.startsWith('RDK_STUDIO_') || key.startsWith('RDK_SIM2REAL_')) delete env[key];
  const setup = spawnSync(
    process.execPath,
    [path.join(root, 'configure.mjs'), '--platform-url', origin + '/robotics-learning'],
    { encoding: 'utf8', env, timeout: 10000 },
  );
  assert.equal(setup.status, 0, setup.stderr);
  const config = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'))).mcpServers[
    'rdk-learning-platform'
  ];
  const open = () =>
    connectMcp({
      command: config.command,
      args: config.args,
      env: { ...env, ...config.env },
      timeoutMs: 15000,
    });
  const init = async () => {
    await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'course-distribution-fixture', version: '1' },
    });
    client.notify('notifications/initialized');
  };
  const call = async (name, arguments_ = {}) =>
    readToolResult(await client.request('tools/call', { name, arguments: arguments_ }));
  client = open();
  await init();
  const catalog = await client.request('tools/list', {});
  assert.ok(catalog.tools.some((t) => t.name === 'rdk_auth_login'));
  assert.equal((await call('rdk_auth_status')).authenticated, false);
  assert.equal(state.authStarts, 0);
  const pending = await call('rdk_auth_login', { openBrowser: false });
  assert.equal(pending.authenticated, false);
  assert.ok(pending.verificationUrl);
  await client.close();
  client = open();
  await init();
  for (let attempt = 0; attempt < 6; attempt++)
    assert.equal((await call('rdk_auth_status')).userCode, pending.userCode);
  assert.equal(state.authStarts, 1);
  state.approved = true;
  assert.equal((await call('rdk_auth_status')).authenticated, true);
  assert.equal((await call('rdk_auth_login', { openBrowser: false })).authenticated, true);
  assert.equal(state.authStarts, 1);
  const guide = await call('rdk_experience_guide');
  const contextId = guide.shortTraining.operation.contextId;
  const train = await call('rdk_originman_short_train', { contextId });
  assert.equal(train.submission.runId, 'train-fixture');
  assert.equal(train.recipeSource.newModelRegistered, true);
  await assert.rejects(
    call('rdk_originman_short_train', { contextId: 'invented-new-experiment' }),
    /绑定原Run/,
  );
  await assert.rejects(call('rdk_training_submit', {}), /绑定原Run/);
  assert.equal(state.writes.length, 1);
  assert.equal(state.historyRequests, 0);
  assert.equal(state.models.length, 1);
  if (failureCase) {
    assert.equal(train.stopWorkflow, true);
    await assert.rejects(call('rdk_originman_short_evaluate', { contextId }), /绑定原Run/);
    assert.equal(state.writes.length, 1);
    console.log(
      JSON.stringify({
        passed: true,
        fixtureOnly: true,
        failureGuardPassed: true,
        trainingSubmissions: 1,
        evaluationSubmissions: 0,
        newContextAndRawSubmitBlocked: true,
      }),
    );
  } else {
    assert.equal(
      (await call('rdk_training_wait', { runId: train.submission.runId })).status,
      'completed',
    );
    await client.close();
    client = open();
    await init();
    assert.equal((await call('rdk_auth_status')).authenticated, true);
    const repeated = await call('rdk_originman_short_train', { contextId });
    assert.equal(repeated.alreadySubmitted, true);
    assert.equal(state.writes.length, 1);
    const evaluation = await call('rdk_originman_short_evaluate', { contextId });
    assert.equal(evaluation.submission.runId, 'eval-fixture');
    assert.equal((await call('rdk_training_wait', { runId: 'eval-fixture' })).status, 'completed');
    const result = await call('rdk_experiment_resume', { contextId });
    assert.equal(result.association.executionVerified, true);
    assert.equal(result.quality.clearGain, false);
    assert.equal(result.playback.state, 'recorded');
    assert.equal(result.playback.verifiedInPlayer, false);
    assert.equal(
      result.links.video,
      origin + '/robotics-learning/api/v1/duck/runs/eval-fixture/workshop-video?format=webm',
    );
    assert.equal(state.mediaRequests, 0);
    await call('rdk_originman_short_evaluate', { contextId });
    assert.equal(state.writes.length, 2);
    await client.close();
    client = open();
    await init();
    const restored = await call('rdk_experiment_resume', { contextId });
    assert.equal(restored.training.runId, 'train-fixture');
    assert.equal(restored.evaluation.runId, 'eval-fixture');
    await assert.rejects(call('rdk_replay_video', { runId: 'eval-fixture' }), /OriginMan评测视频/);
    assert.equal(state.writes.length, 2);
    state.brokenDigest = true;
    await assert.rejects(call('rdk_experiment_resume', { contextId }), /摘要/);
    assert.equal(state.writes.length, 2);
    console.log(
      JSON.stringify({
        passed: true,
        fixtureOnly: true,
        realLearningVerified: false,
        realVideoPlaybackVerified: false,
        version: result.pluginRuntime.version,
        toolCount: catalog.tools.length,
        firstLogin: true,
        authorizationSurvivedMcpRestart: true,
        confirmationCodesIssued: state.authStarts,
        firstCourseModelRegistered: true,
        historyRequired: false,
        trainingSubmissions: 1,
        evaluationSubmissions: 1,
        restartRecovery: true,
        resumedCourseRejectsTelemetryRender: true,
        repeatSubmissionPrevented: true,
        parentAndDigestVerified: true,
        changedDigestRejected: true,
        qualityNotOverclaimed: true,
        videoLinkCorrect: true,
        mediaNotFetchedByPlugin: true,
      }),
    );
  }
} finally {
  await client?.close();
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  fs.rmSync(temp, { recursive: true, force: true });
}
