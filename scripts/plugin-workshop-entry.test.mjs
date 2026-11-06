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
  for (const intent of ['continue', 'results', 'start']) {
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
  assert.match(initialized.instructions, /0.6按钮工作台入口优先/);
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
  const invoke = async (visible = true, args = { intent: 'start' }, chosen = 'chosen-resource') =>
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

test('a cold Qoder launch claims authorization and opens the owned course without another prompt', async () => {
  let opened = false;
  const auth = {
    mode: 'browser-login',
    audience: status.baseUrl,
    async call(name, args) {
      assert.equal(name, 'rdk_auth_login');
      assert.equal(args.openBrowser, true);
      opened = true;
      return {
        authenticated: false,
        needsLogin: true,
        browserOpened: true,
        verificationUrl: 'https://platform.test/api/sso/plugin/authorize?id=authorized-fixture',
      };
    },
    async status() {
      return opened
        ? { authenticated: true, accountId: 'alice' }
        : { authenticated: false, needsLogin: true };
    },
  };
  let statusReads = 0;
  const result = await workshopEntry(
    { intent: 'start' },
    async (name) => {
      assert.equal(name, 'rdk_platform_status');
      assert.equal(opened, true);
      statusReads++;
      return status;
    },
    {
      authentication: auth,
      openAuthBrowser: true,
      remote: async (op) => {
        assert.equal(op, 'list');
        assert.ok(statusReads > 0);
        return { current };
      },
    },
  );
  assert.equal(result.contextId, current.contextId);
  assert.equal(result.submission.training, false);
  assert.equal(statusReads, 2);
});

test('pending browser authorization offers one link and network errors do not start auth', async () => {
  const login = 'https://platform.test/api/sso/plugin/authorize?id=owned-fixture';
  let starts = 0;
  let state = { authenticated: false, needsLogin: true };
  const auth = {
    mode: 'browser-login',
    audience: status.baseUrl,
    async status() {
      return state;
    },
    async call(_name, args) {
      starts++;
      assert.equal(args.openBrowser, false);
      return {
        authenticated: false,
        needsLogin: true,
        verificationUrl: login,
        browserOpened: false,
      };
    },
  };
  const noCourse = () => assert.fail('no course read or write before authorization');
  const pending = await workshopEntry({ intent: 'start' }, noCourse, {
    authentication: auth,
    remote: noCourse,
  });
  assert.equal(pending.stage, 'authorize');
  assert.deepEqual(pending.links, { login });
  assert.equal(pending.submission.training, false);
  assert.equal(starts, 1);
  state = { authenticated: null, needsLogin: false, nextAction: '稍后重试原请求。' };
  await assert.rejects(
    workshopEntry({}, noCourse, { authentication: auth, remote: noCourse }),
    /重试原请求/,
  );
  assert.equal(starts, 1);
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
  assert.match(list.structuredContent.studentReply, /训练算力机：GPU A\nRDK 板卡：RDK A/);
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
