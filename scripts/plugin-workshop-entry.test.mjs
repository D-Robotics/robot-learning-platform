import test from 'node:test';
import assert from 'node:assert/strict';
import { workshopEntry } from '../plugins/rdk-robot-learning-platform/scripts/workshop-entry.mjs';
import { experienceProxy } from '../plugins/rdk-robot-learning-platform/scripts/experience-mcp.mjs';
const current = {
  contextId: 'ws-current',
  stage: 'training',
  training: { runId: 't', status: 'running' },
};
const status = {
  baseUrl: 'https://platform.test/learning',
  session: { authenticated: true, accountId: 'alice' },
};
test('short continue/results use shared current without scanning runs or writing submissions', async () => {
  for (const intent of ['continue', 'results']) {
    const calls = [];
    const result = await workshopEntry(
      { intent },
      async (name) => {
        calls.push(name);
        assert.equal(name, 'rdk_platform_status');
        return status;
      },
      {
        remote: async (op) => {
          assert.equal(op, 'list');
          return { current };
        },
      },
    );
    assert.deepEqual(calls, ['rdk_platform_status', 'rdk_platform_status']);
    assert.equal(result.contextId, current.contextId);
    assert.match(result.links.workshop, /context=ws-current$/);
    assert.equal(result.submission.training, false);
    assert.match(result.studentReply, /查看训练进度/);
    assert.doesNotMatch(result.studentReply, /先看参考|选预算/);
    assert.match(result.delivery, /内置/);
  }
});
test('ambiguous history offers page selection and never guesses latest', async () => {
  const result = await workshopEntry({ intent: 'continue' }, async () => status, {
    remote: async () => ({ current: null, sessions: [{ contextId: 'one' }, { contextId: 'two' }] }),
  });
  assert.equal(result.contextId, null);
  assert.equal(result.links.workshop, 'https://platform.test/learning/workshop.html');
  assert.match(result.studentReply, /选择/);
});
test('explicit selection belongs to the current authenticated platform; arbitrary args and unauthed calls stop', async () => {
  const ops = [];
  const r = await workshopEntry({ intent: 'continue', contextId: 'chosen' }, async () => status, {
    remote: async (op, input) => {
      ops.push([op, input]);
      return op === 'list' ? { current } : { session: { ...current, contextId: input.contextId } };
    },
  });
  assert.equal(r.contextId, 'chosen');
  assert.deepEqual(ops[1], ['select', { contextId: 'chosen' }]);
  await assert.rejects(
    workshopEntry({ timesteps: 500000 }, async () => status),
    /开始/,
  );
  await assert.rejects(
    workshopEntry({}, async () => ({ session: { authenticated: false } }), {
      remote: async () => {
        throw Error('must not call');
      },
    }),
    /登录/,
  );
});
test('native text-only host gets short actionable entry and preserves expert tool catalog', async () => {
  const p = experienceProxy({
    request: async (method, _args) =>
      method === 'tools/list'
        ? { tools: [{ name: 'expert_tool' }] }
        : method === 'initialize'
          ? { capabilities: { tools: {} } }
          : { content: [{ type: 'text', text: JSON.stringify(status) }] },
    workshopSession: async () => ({ current }),
  });
  const initialized = await p('initialize', { clientInfo: { name: 'Qoder', version: '0.5.3' } });
  assert.match(initialized.instructions, /打开按钮工作台/);
  assert.doesNotMatch(
    initialized.instructions,
    /用户只说Workshop\/彩排\/验证流程但没选预算，调用空参数/,
  );
  const tools = await p('tools/list');
  assert.ok(tools.tools.some((t) => t.name === 'expert_tool'));
  assert.ok(tools.tools.some((t) => t.name === 'rdk_workshop'));
  const r = await p('tools/call', { name: 'rdk_workshop', arguments: { intent: 'continue' } });
  assert.notEqual(r.isError, true);
  assert.equal(r.structuredContent.contextId, 'ws-current');
  assert.match(r.content[0].text, /workshop.html/);
  const compact = JSON.parse(r.content[0].text);
  assert.deepEqual(
    compact.qoderNavigation.steps.map((s) => s.tool),
    ['navigate_page', 'list_pages', 'select_page'],
  );
  assert.equal(compact.qoderNavigation.steps[0].arguments.url, compact.links.workshop);
  assert.match(compact.qoderNavigation.steps[2].argumentsFrom, /pageId/);
  assert.equal(compact.studentReply.split('\n').length, 2);
});

test('account switch during a shared-current read fails closed before returning an experiment link', async () => {
  let reads = 0;
  await assert.rejects(
    workshopEntry(
      { intent: 'continue' },
      async () => {
        reads++;
        return reads === 1
          ? status
          : { ...status, session: { authenticated: true, accountId: 'bob' } };
      },
      { remote: async () => ({ current }) },
    ),
    /账号或平台已变化/,
  );
});

test('new draft reuses selected course assets among multiple resources, after ownership and health checks', async () => {
  const { readFile } = await import('node:fs/promises');
  const manifest = JSON.parse(
    await readFile(
      new URL(
        '../plugins/rdk-robot-learning-platform/references/originman-manifest.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  const calls = [];
  const invoke = async (
    visible = true,
    args = { intent: 'new', computeResourceId: 'chosen-resource' },
    chosen = 'chosen-resource',
  ) =>
    workshopEntry(
      args,
      async (name, args) => {
        calls.push({ name, args });
        if (name === 'rdk_platform_status') return status;
        if (name === 'rdk_model_validate') return { valid: true };
        if (name === 'rdk_compute_resources_list')
          return {
            computeResources: [
              { id: 'other', name: 'OriginMan other' },
              ...(visible ? [{ id: 'chosen-resource', name: 'OriginMan selected' }] : []),
            ],
          };
        if (name === 'rdk_compute_resource_test')
          return { id: args.computeResourceId, connected: true, status: 'online', mock: false };
        throw Error('Unexpected call ' + name);
      },
      {
        readModels: async () => ({ models: [{ id: 'chosen-model', manifest }] }),
        courseReadiness: async ({ computeResourceId }) => ({
          computeResourceId,
          trainingSubmitted: false,
          report: {
            schemaVersion: 1,
            readyForSmokeTraining: true,
            trainingPerformed: false,
            device: 'cuda',
            engine: 'originman-recovery-reflect',
            taskId: 'originman-recovery',
          },
        }),
        remote: async (op, input) => {
          if (op === 'list')
            return {
              current: {
                contextId: 'old',
                stage: 'results',
                modelId: 'chosen-model',
                computeResourceId: 'chosen-resource',
              },
            };
          assert.equal(op, 'create');
          assert.deepEqual(input, {
            modelId: 'chosen-model',
            computeResourceId: chosen,
          });
          return { session: { contextId: 'new', stage: 'ready', ...input } };
        },
      },
    );
  assert.equal((await invoke()).contextId, 'new');
  assert.ok(
    calls.some(
      (c) =>
        c.name === 'rdk_compute_resource_test' && c.args.computeResourceId === 'chosen-resource',
    ),
  );
  const changed = await invoke(true, { intent: 'new', computeResourceId: 'other' }, 'other');
  assert.equal(changed.session.computeResourceId, 'other');
  assert.match(changed.studentReply, /OriginMan other/);
  await assert.rejects(
    invoke(true, { intent: 'continue', computeResourceId: 'other' }),
    /新建实验/,
  );
  await assert.rejects(invoke(false), /当前账号不可见/);
});

test('cold Workshop previews offline and only surfaces an already requested authorization', async () => {
  const login = 'https://platform.test/api/sso/plugin/authorize?id=owned-fixture';
  let state = { authenticated: false, needsLogin: true };
  const noCourse = () => assert.fail('no platform operation or new authorization');
  const authentication = { audience: status.baseUrl, status: async () => state, call: noCourse };
  const options = { authentication, remote: noCourse };
  const preview = await workshopEntry({}, noCourse, options);
  assert.equal(preview.stage, 'preview');
  assert.match(preview.links.workshop, /workshop\.html\?start=1$/);
  assert.match(preview.studentReply, /开始实操/);
  assert.equal(preview.submission.training, false);
  // A fresh 'new' preview intentionally reads no account data; authorization is
  // only requested when the learner resumes or actually starts practice.
  const freshPreview = await workshopEntry({ intent: 'new' }, noCourse, options);
  assert.equal(freshPreview.stage, 'preview');
  const requiresLogin = await workshopEntry(
    { intent: 'continue', contextId: 'ws-cold' },
    noCourse,
    options,
  );
  assert.equal(requiresLogin.stage, 'authorize');
  assert.deepEqual(requiresLogin.links, {});
  state = { ...state, verificationUrl: login };
  assert.deepEqual((await workshopEntry({}, noCourse, options)).links, { login });
  state = { authenticated: null, needsLogin: false, nextAction: '稍后重试原请求。' };
  await assert.rejects(workshopEntry({}, noCourse, options), /重试原请求/);
});

test('starting Workshop opens a fresh preview even when the current experiment has results', async () => {
  for (const [intent, current, stage] of [
    ['start', null, 'choose-compute'],
    ['new', { contextId: 'previous', stage: 'results' }, 'choose-compute'],
    ['start', { contextId: 'previous', stage: 'results' }, 'choose-compute'],
    [undefined, { contextId: 'previous', stage: 'results' }, 'choose-compute'],
  ]) {
    const result = await workshopEntry(
      intent === undefined ? {} : { intent },
      async (name) => {
        assert.equal(name, 'rdk_platform_status');
        return status;
      },
      {
        remote: async () => {
          assert.fail(
            `Fresh entry must not read the current experiment (${current?.contextId ?? 'none'})`,
          );
          return { current };
        },
      },
    );
    assert.equal(result.stage, stage);
    assert.equal(result.contextId, null);
    assert.match(result.links.workshop, /workshop\.html\?start=1$/);
    assert.equal(result.submission.training, false);
  }
});

test('development target entry separates workers from boards, keeps scope and requests the exact connection', async () => {
  let accountId = 'alice';
  const calls = [];
  const p = experienceProxy(
    {
      request: async () => ({ tools: [] }),
      developmentTarget: async (op, args) => {
        calls.push([op, args.accountId, args.targetId]);
        assert.equal(args.accountId, 'alice');
        if (op === 'compute')
          return { computeResources: [{ id: 'w1', name: 'GPU A', runnerUrl: 'private-runner' }] };
        if (op === 'boards')
          return { connections: [{ id: 'b1', label: 'RDK A', host: 'private-host' }] };
        if (op === 'test-compute') return { computeResource: { id: 'w1' }, connected: true };
        if (op === 'connect-board')
          return { connection: { id: 'b1', tunnelActive: true }, probe: { ok: false } };
        throw Error(op);
      },
    },
    { authentication: { status: async () => ({ authenticated: !!accountId, accountId }) } },
  );
  const invoke = (args) => p('tools/call', { name: 'rdk_development_targets', arguments: args });
  const list = await invoke({ action: 'list' });
  assert.match(list.structuredContent.studentReply, /训练算力机：GPU A[^\n]*\nRDK 板卡：RDK A/);
  assert.doesNotMatch(JSON.stringify(list), /private-/);
  assert.equal((await invoke({ action: 'connect-board', targetId: 'w1' })).isError, true);
  assert.equal(
    (await invoke({ action: 'test-compute', targetId: 'w1' })).structuredContent.connected,
    true,
  );
  const board = await invoke({ action: 'connect-board', targetId: 'b1' });
  assert.equal(board.structuredContent.tunnelActive, true);
  assert.equal(board.structuredContent.agentReady, false);
  assert.match(board.structuredContent.studentReply, /探测未通过/);
  assert.deepEqual(
    calls.filter(([op]) => op === 'connect-board'),
    [['connect-board', 'alice', 'b1']],
  );
  accountId = null;
  const before = calls.length;
  assert.equal((await invoke({})).isError, true);
  assert.equal(calls.length, before);
});
