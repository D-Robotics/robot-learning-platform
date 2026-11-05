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
