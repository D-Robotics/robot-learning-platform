import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { selectCourseAssets } from '../plugins/rdk-robot-learning-platform/scripts/course-setup.mjs';
import { createMcpConfiguration } from '../plugins/rdk-robot-learning-platform/configure.mjs';
const manifest = JSON.parse(
  fs.readFileSync(
    new URL(
      '../plugins/rdk-robot-learning-platform/references/originman-manifest.json',
      import.meta.url,
    ),
  ),
);
const registered = () => ({
  id: 'registered-course',
  manifest: {
    ...structuredClone(manifest),
    robot: { id: 'originman', variant: 'legs' },
    contract: { ...structuredClone(manifest.contract), robotId: 'originman' },
  },
});
test('bundled course matches the formal OriginMan registration identity without changing its policy contract', async () => {
  assert.equal(manifest.robot.id, 'originman');
  assert.equal(manifest.contract.robotId, 'originman');
  assert.equal(manifest.contract.id, 'custom-policy-originman-recovery-v1');
  const asset = await selectCourseAssets(
    {
      manifest,
      computeResourceId: 'course-resource',
      readModels: async () => ({ models: [registered()] }),
    },
    async (name) => {
      assert.equal(name, 'rdk_compute_resources_list');
      return { computeResources: [{ id: 'course-resource', name: 'OriginMan course' }] };
    },
  );
  assert.equal(asset.model.id, 'registered-course');
});
test('a real layout mismatch stops before resource lookup and tells the learner to contact the course maintainer', async () => {
  const model = registered();
  model.manifest.contract.observationLayout[0].size = 5;
  let calls = 0;
  await assert.rejects(
    selectCourseAssets({ manifest, readModels: async () => ({ models: [model] }) }, async () => {
      calls++;
    }),
    (e) =>
      e.platformCode === 'WORKSHOP_MODEL_CONTRACT_MISMATCH' &&
      e.stopWorkflow === true &&
      /立即结束/.test(e.nextAction),
  );
  assert.equal(calls, 0);
});
test('configured classroom resource is selected only from the current account and never falls back', async () => {
  const call = async () => ({
    computeResources: [
      { id: 'first', name: 'OriginMan old' },
      { id: 'second', name: 'OriginMan course' },
    ],
  });
  const input = {
    manifest,
    readModels: async () => ({ models: [registered()] }),
    computeResourceId: 'second',
  };
  assert.equal((await selectCourseAssets(input, call)).resource.id, 'second');
  await assert.rejects(
    selectCourseAssets({ ...input, computeResourceId: 'foreign' }, call),
    /当前账号不可见/,
  );
  await assert.rejects(
    selectCourseAssets({ ...input, computeResourceId: undefined }, call),
    (e) =>
      e.platformCode === 'WORKSHOP_RESOURCE_SELECTION_REQUIRED' &&
      e.stopWorkflow === false &&
      e.details.choices.length === 2,
  );
});
test('classroom binding is public configuration and invalid bindings are rejected', () => {
  const options = {
    root: '/course/plugin',
    nodePath: '/runtime/node',
    courseResourceId: '12345678-abcd-4321-abcd-123456789abc',
  };
  const env = createMcpConfiguration(options).mcpServers['rdk-learning-platform'].env;
  assert.equal(env.RDK_WORKSHOP_COMPUTE_RESOURCE_ID, options.courseResourceId);
  assert.equal(env.RDK_STUDIO_INHERIT_LOGIN, '0');
  assert.throws(
    () => createMcpConfiguration({ ...options, courseResourceId: 'not a resource' }),
    /资源标识无效/,
  );
});

test('waiting continues through a Run-bound cursor and rejects stale or cross-Run cursors', async () => {
  const { experienceProxy } =
    await import('../plugins/rdk-robot-learning-platform/scripts/experience-mcp.mjs');
  let requests = 0;
  const proxy = experienceProxy(
    {
      request: async () => {
        requests++;
        return { structuredContent: { runId: 'run-a', status: 'running' } };
      },
    },
    { waitBudgetMs: 1 },
  );
  const call = (arguments_) =>
    proxy('tools/call', { name: 'rdk_training_wait', arguments: arguments_ });
  const first = (await call({ runId: 'run-a' })).structuredContent;
  assert.equal(first.waiting, true);
  assert.equal(first.nextPollArguments.runId, 'run-a');
  assert.match(first.nextPollArguments.pollCursor, /^[a-f0-9-]{36}$/);
  const second = (await call(first.nextPollArguments)).structuredContent;
  assert.notEqual(second.nextPollArguments.pollCursor, first.nextPollArguments.pollCursor);
  const before = requests;
  assert.equal(
    (await call(first.nextPollArguments)).structuredContent.error.platformCode,
    'WAIT_CURSOR_MISMATCH',
  );
  assert.equal(
    (await call({ ...second.nextPollArguments, runId: 'run-b' })).structuredContent.error
      .platformCode,
    'WAIT_CURSOR_MISMATCH',
  );
  assert.equal(requests, before);
});

test('workshop replay applicability is clarified without changing core schemas, safety or other tools', async () => {
  const { experienceProxy } =
    await import('../plugins/rdk-robot-learning-platform/scripts/experience-mcp.mjs');
  const original = {
    name: 'rdk_replay_video',
    description: '原始真机回放说明',
    inputSchema: { type: 'object', properties: { runId: { type: 'string' } } },
    annotations: { readOnlyHint: false, destructiveHint: false },
  };
  const other = { ...structuredClone(original), name: 'other_tool' };
  const snapshot = structuredClone(original);
  const proxy = experienceProxy({ request: async () => ({ tools: [original, other] }) });
  const tools = (await proxy('tools/list', {})).tools;
  assert.match(tools[0].description, /仅用于真机遥测/);
  assert.match(tools[0].description, /OriginMan/);
  assert.ok(tools[0].description.endsWith(snapshot.description));
  assert.deepEqual({ ...tools[0], description: snapshot.description }, snapshot);
  assert.deepEqual(original, snapshot);
  assert.deepEqual(tools[1], other);
});
