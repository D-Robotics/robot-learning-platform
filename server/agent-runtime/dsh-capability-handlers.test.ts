import { afterEach, describe, expect, it } from 'vitest';

import {
  createDshAuthChannel,
  createDshCapabilityHandlers,
  type LoopbackFetch,
} from './dsh-capability-handlers.js';
import { listDshCapabilityCatalog } from './dsh-capability-tools.js';

/**
 * Handlers are tested against a fake loopback fetch that records the outgoing
 * request and answers with a canned route payload. This pins the contract the
 * model sees (compact digests, stable error codes) and the enforcement wiring
 * (forwarded auth headers, idempotency keys) without booting the web app.
 */

type RecordedCall = {
  path: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
};

function fakeLoopback(replies: Array<(call: RecordedCall) => { status: number; body: unknown }>): {
  fetchImpl: LoopbackFetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchImpl: LoopbackFetch = async (path, init) => {
    const call: RecordedCall = {
      path,
      method: init.method,
      headers: init.headers,
      body: init.body,
    };
    calls.push(call);
    const reply = replies.length > 1 ? replies.shift() : replies[0];
    const answer = reply!(call);
    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetchImpl, calls };
}

const overviewPayload = {
  ok: true,
  models: [{ id: 'model-a', taskId: 'walk', status: 'ready' }],
  runs: [{ id: 'run-1', status: 'completed', modelId: 'model-a', backend: 'local' }],
  devices: [{ id: 'device-x5', profile: 'rdk-x5', status: 'online' }],
  deployments: [],
  integrations: { simulator: { browser: { entryUrl: '/mujoco/microduck/' } } },
};

afterEach(() => {
  // Drain any auth-channel entries a failed test left behind.
});

describe('DSH capability handlers', () => {
  it('binds every catalog entry to a product route handler', () => {
    const { fetchImpl } = fakeLoopback([() => ({ status: 200, body: {} })]);
    const catalog = listDshCapabilityCatalog(createDshCapabilityHandlers({ fetchImpl }));
    expect(catalog.length).toBeGreaterThan(30);
    expect(catalog.every((item) => item.bound)).toBe(true);
  });

  it('covers workspace catalog reads and keeps request filters explicit', async () => {
    const { fetchImpl, calls } = fakeLoopback([
      () => ({ status: 200, body: { counts: { projects: 2 }, latest: { run: null } } }),
      () => ({ status: 200, body: { projects: [{ id: 'p1', name: '导航', slug: 'nav' }] } }),
      () => ({ status: 200, body: { datasets: [{ id: 'd1', name: '轨迹', status: 'ready' }] } }),
      () => ({ status: 200, body: { runs: [{ id: 'r1', status: 'completed' }] } }),
    ]);
    const handlers = createDshCapabilityHandlers({ fetchImpl });
    const exec = { signal: new AbortController().signal } as never;

    await expect(handlers.rdk_workspace_summary({}, exec)).resolves.toMatchObject({
      counts: { projects: 2 },
    });
    await expect(handlers.rdk_projects_list({}, exec)).resolves.toEqual({
      projects: [{ id: 'p1', name: '导航', slug: 'nav', description: null }],
    });
    await expect(handlers.rdk_datasets_list({}, exec)).resolves.toMatchObject({
      datasets: [{ id: 'd1', name: '轨迹', status: 'ready' }],
    });
    await expect(
      handlers.rdk_runs_list({ modelId: 'model-a', status: 'completed', limit: 7 }, exec),
    ).resolves.toMatchObject({ runs: [{ id: 'r1', status: 'completed' }] });
    expect(calls.at(-1)?.path).toBe('/api/sim2real/runs?modelId=model-a&status=completed&limit=7');
  });

  it('routes model validation, artifact promotion and deployment lifecycle actions', async () => {
    const { fetchImpl, calls } = fakeLoopback([
      () => ({ status: 200, body: { validation: { valid: true, errors: [], warnings: [] } } }),
      () => ({ status: 200, body: { artifact: { id: 'a1', status: 'published' } } }),
      () => ({ status: 200, body: { deployment: { id: 'dep-1', status: 'planned' } } }),
      () => ({ status: 200, body: { deploymentId: 'dep-1', history: [], verification: null } }),
      () => ({ status: 200, body: { deployment: { id: 'dep-1', status: 'cancelled' } } }),
    ]);
    const handlers = createDshCapabilityHandlers({ fetchImpl });
    const exec = { signal: new AbortController().signal } as never;
    await expect(
      handlers.rdk_model_validate({ manifest: { robot: { id: 'x' } } }, exec),
    ).resolves.toMatchObject({
      valid: true,
    });
    await expect(
      handlers.rdk_artifact_promote({ artifactId: 'a1', status: 'published' }, exec),
    ).resolves.toMatchObject({ artifactId: 'a1', status: 'published' });
    await expect(
      handlers.rdk_deployment_status({ deploymentId: 'dep-1' }, exec),
    ).resolves.toMatchObject({
      deployment: { status: 'planned' },
    });
    await expect(
      handlers.rdk_deployment_history({ deploymentId: 'dep-1' }, exec),
    ).resolves.toMatchObject({
      deploymentId: 'dep-1',
    });
    await expect(
      handlers.rdk_deployment_cancel({ deploymentId: 'dep-1' }, exec),
    ).resolves.toMatchObject({
      status: 'cancelled',
    });
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'POST /api/sim2real/models/validate',
      'PATCH /api/sim2real/artifacts/a1',
      'GET /api/sim2real/deployments/dep-1',
      'GET /api/sim2real/deployments/dep-1/history',
      'POST /api/sim2real/deployments/dep-1/cancel',
    ]);
  });

  it('passes the selected device to board station tools and compacts telemetry', async () => {
    const { fetchImpl, calls } = fakeLoopback([
      () => ({ status: 200, body: { ok: true, status: { state: 'idle' } } }),
      () => ({
        status: 200,
        body: {
          ok: true,
          telemetry: [
            {
              id: 'chunk-1',
              source: 'board-agent',
              sequence: 3,
              receivedAt: '2026-01-01T00:00:00Z',
              samples: [{ t: 1 }, { t: 2 }],
              attested: true,
            },
          ],
          count: 1,
        },
      }),
    ]);
    const handlers = createDshCapabilityHandlers({ fetchImpl });
    const exec = { signal: new AbortController().signal } as never;
    await expect(
      handlers.rdk_board_station_status({ deviceId: 'device-x5' }, exec),
    ).resolves.toMatchObject({ status: { state: 'idle' } });
    const telemetry = (await handlers.rdk_telemetry_list({ runId: 'run-1' }, exec)) as Record<
      string,
      unknown
    >;
    expect(telemetry.telemetry).toEqual([
      {
        id: 'chunk-1',
        source: 'board-agent',
        sequence: 3,
        receivedAt: '2026-01-01T00:00:00Z',
        sampleCount: 2,
        droppedCount: null,
        attested: true,
      },
    ]);
    expect(calls[0].path).toBe('/api/sim2real/board-station/status?deviceId=device-x5');
  });

  it('forwards the caller session headers to loopback route calls', async () => {
    const { fetchImpl, calls } = fakeLoopback([() => ({ status: 200, body: overviewPayload })]);
    const handlers = createDshCapabilityHandlers({ fetchImpl });
    const channel = createDshAuthChannel();

    await channel.withAuth({ cookie: 'session=abc', authorization: 'Bearer tok' }, async () =>
      handlers.rdk_workspace_overview({}, { signal: new AbortController().signal } as never),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe('/api/sim2real/overview');
    expect(calls[0].headers.cookie).toBe('session=abc');
    expect(calls[0].headers.authorization).toBe('Bearer tok');
  });

  it('keeps concurrent auth contexts isolated and reuses a turn id for writes', async () => {
    const { fetchImpl, calls } = fakeLoopback([
      () => ({ status: 200, body: overviewPayload }),
      () => ({ status: 200, body: overviewPayload }),
      () => ({ status: 201, body: { ok: true, run: { id: 'run-a', status: 'queued' } } }),
      () => ({ status: 201, body: { ok: true, run: { id: 'run-b', status: 'queued' } } }),
    ]);
    const handlers = createDshCapabilityHandlers({ fetchImpl });
    const channel = createDshAuthChannel();
    const exec = { signal: new AbortController().signal } as never;
    await Promise.all([
      channel.withAuth({ cookie: 'alice', 'x-sim2real-turn-id': 'turn-a' }, () =>
        handlers.rdk_training_submit({}, exec),
      ),
      channel.withAuth({ cookie: 'bob', 'x-sim2real-turn-id': 'turn-b' }, () =>
        handlers.rdk_training_submit({}, exec),
      ),
    ]);
    const submits = calls.filter((call) => call.path === '/api/sim2real/runs');
    expect(submits).toHaveLength(2);
    expect(new Set(submits.map((call) => call.headers.cookie))).toEqual(new Set(['alice', 'bob']));
    expect(submits[0].headers['idempotency-key']).toMatch(/^dsh-training-turn-[ab]-0$/);
    expect(submits[1].headers['idempotency-key']).toMatch(/^dsh-training-turn-[ab]-0$/);
  });

  it('separates repeated writes of the same kind within one turn', async () => {
    const { fetchImpl, calls } = fakeLoopback([
      () => ({ status: 201, body: { ok: true, run: { id: 'run-1', status: 'queued' } } }),
      () => ({ status: 201, body: { ok: true, run: { id: 'run-2', status: 'queued' } } }),
    ]);
    const handlers = createDshCapabilityHandlers({ fetchImpl });
    const channel = createDshAuthChannel();
    const exec = { signal: new AbortController().signal } as never;
    await channel.withAuth({ 'x-sim2real-turn-id': 'turn-repeat' }, async () => {
      await handlers.rdk_training_submit({}, exec);
      await handlers.rdk_training_submit({}, exec);
    });
    const keys = calls
      .filter((call) => call.path === '/api/sim2real/runs')
      .map((call) => call.headers['idempotency-key']);
    expect(keys).toEqual(['dsh-training-turn-repeat-0', 'dsh-training-turn-repeat-1']);
  });

  it('digests the overview to compact model/run/device facts', async () => {
    const { fetchImpl } = fakeLoopback([() => ({ status: 200, body: overviewPayload })]);
    const handlers = createDshCapabilityHandlers({ fetchImpl });

    const result = (await handlers.rdk_workspace_overview({}, {
      signal: new AbortController().signal,
    } as never)) as Record<string, unknown>;

    expect(result.models).toEqual([{ id: 'model-a', taskId: 'walk', status: 'ready' }]);
    expect(result.runs).toEqual([
      { id: 'run-1', status: 'completed', modelId: 'model-a', backend: 'local' },
    ]);
    expect(result.devices).toEqual([{ id: 'device-x5', profile: 'rdk-x5', status: 'online' }]);
  });

  it('surfaces the route message and a rejected code on 4xx', async () => {
    const { fetchImpl } = fakeLoopback([
      () => ({ status: 200, body: overviewPayload }),
      () => ({ status: 403, body: { ok: false, message: '当前账号没有智能体执行权限。' } }),
    ]);
    const handlers = createDshCapabilityHandlers({ fetchImpl });

    await expect(
      handlers.rdk_training_submit({}, { signal: new AbortController().signal } as never),
    ).rejects.toMatchObject({
      name: 'CapabilityError',
      code: 'DSH_CAPABILITY_REJECTED',
      message: expect.stringContaining('智能体执行权限'),
    });
  });

  it('submits training through the guarded runs route with an idempotency key', async () => {
    const { fetchImpl, calls } = fakeLoopback([
      () => ({ status: 200, body: overviewPayload }),
      () => ({ status: 201, body: { ok: true, run: { id: 'run-42', status: 'queued' } } }),
    ]);
    const handlers = createDshCapabilityHandlers({ fetchImpl });

    const result = (await handlers.rdk_training_submit({}, {
      signal: new AbortController().signal,
    } as never)) as Record<string, unknown>;

    expect(result.runId).toBe('run-42');
    expect(result.status).toBe('queued');
    expect(result.modelId).toBe('model-a');
    const submit = calls.find(
      (call) => call.method === 'POST' && call.path === '/api/sim2real/runs',
    );
    expect(submit).toBeTruthy();
    expect(submit!.headers['idempotency-key']).toMatch(/^dsh-/);
    const parsed = JSON.parse(submit!.body!) as Record<string, unknown>;
    expect(parsed.modelId).toBe('model-a');
    expect(parsed.backend).toBe('local');
    expect(parsed.training).toEqual({ profile: 'smoke' });
  });

  it('summarizes evaluation metrics and replay evidence', async () => {
    const { fetchImpl, calls } = fakeLoopback([
      () => ({ status: 200, body: overviewPayload }),
      () => ({
        status: 200,
        body: {
          ok: true,
          run: { id: 'run-1', status: 'completed', metrics: { reward: 3.2, successRate: 0.9 } },
          evaluation: {
            replay: { sampleCount: 120, fallCount: 2, doneCount: 8 },
            warnings: ['样本率偏低'],
          },
        },
      }),
    ]);
    const handlers = createDshCapabilityHandlers({ fetchImpl });

    const result = (await handlers.rdk_evaluation_summarize({}, {
      signal: new AbortController().signal,
    } as never)) as Record<string, unknown>;

    expect(result.runId).toBe('run-1');
    expect(result.metrics).toMatchObject({ reward: 3.2, successRate: 0.9 });
    expect(result.replay).toEqual({ sampleCount: 120, fallCount: 2, doneCount: 8 });
    expect(result.warnings).toEqual(['样本率偏低']);
    expect(calls.some((call) => call.path === '/api/sim2real/runs/run-1/evaluate')).toBe(true);
  });

  it('reports a mock-only preflight as a drill, not a failure', async () => {
    const { fetchImpl } = fakeLoopback([
      () => ({ status: 200, body: overviewPayload }),
      () => ({ status: 201, body: { ok: true, deployment: { id: 'dep-7', status: 'created' } } }),
      () => ({
        status: 409,
        body: { ok: false, error: 'SIM2REAL_PREFLIGHT_MOCK_ONLY', preflight: { mock: true } },
      }),
    ]);
    const handlers = createDshCapabilityHandlers({ fetchImpl });

    const result = (await handlers.rdk_deployment_preflight({}, {
      signal: new AbortController().signal,
    } as never)) as Record<string, unknown>;

    expect(result.deploymentId).toBe('dep-7');
    expect(result.mock).toBe(true);
    expect(result.passed).toBe(false);
  });

  it('fails board stop when either stop route does not confirm', async () => {
    const { fetchImpl } = fakeLoopback([
      () => ({ status: 200, body: { ok: true } }),
      () => ({ status: 502, body: { ok: false } }),
    ]);
    const handlers = createDshCapabilityHandlers({ fetchImpl });

    await expect(
      handlers.rdk_board_stop({}, { signal: new AbortController().signal } as never),
    ).rejects.toMatchObject({
      code: 'DSH_CAPABILITY_FAILED',
      message: expect.stringContaining('策略与驱动'),
    });
  });

  it('rejects connect and status calls that miss their required id argument', async () => {
    const { fetchImpl } = fakeLoopback([]);
    const handlers = createDshCapabilityHandlers({ fetchImpl });
    const exec = { signal: new AbortController().signal } as never;

    await expect(handlers.rdk_device_connect({}, exec)).rejects.toMatchObject({
      code: 'DSH_CAPABILITY_REJECTED',
    });
    await expect(handlers.rdk_training_status({}, exec)).rejects.toMatchObject({
      code: 'DSH_CAPABILITY_REJECTED',
    });
  });
});

describe('DSH docs knowledge tools', () => {
  const exec = { signal: new AbortController().signal } as never;
  const docsResponse = (body: unknown, status = 200): Response =>
    ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(body),
    }) as unknown as Response;

  it('searches the official forum and returns deduplicated topic links', async () => {
    const calls: string[] = [];
    const docsFetchImpl = async (path: string) => {
      calls.push(path);
      return docsResponse({
        posts: [
          { topic_id: 35286, blurb: 'LeRobot ACT 在 S600 上的完整落地步骤' },
          { topic_id: 35286, blurb: '重复命中应去重' },
          { topic_id: 35484, blurb: 'InternVL2.5 在 X5 上的 BPU 部署' },
        ],
        topics: [
          { id: 35286, slug: 'lerobot-act-s600', title: 'LeRobot ACT + RDK S600 全流程落地指南' },
          { id: 35484, slug: 'topic', title: '在RDK X5上部署官方Internvl2_5' },
        ],
      });
    };
    const handlers = createDshCapabilityHandlers({ docsFetchImpl });
    const result = (await handlers.rdk_docs_search(
      { query: 'S600 ACT 部署' },
      exec,
    )) as { results: Array<{ title: string; url: string }>; source: string };

    expect(calls).toEqual([`/search.json?q=${encodeURIComponent('S600 ACT 部署')}`]);
    expect(result.results).toHaveLength(2);
    expect(result.results[0]).toMatchObject({
      title: 'LeRobot ACT + RDK S600 全流程落地指南',
      url: 'https://forum.d-robotics.cc/t/lerobot-act-s600/35286',
    });
    expect(result.source).toContain('forum.d-robotics.cc');
  });

  it('reports a helpful hint when the search has no hits', async () => {
    const handlers = createDshCapabilityHandlers({
      docsFetchImpl: async () => docsResponse({ posts: [], topics: [] }),
    });
    const result = (await handlers.rdk_docs_search({ query: '不存在的词条' }, exec)) as {
      results: unknown[];
      hint: string;
    };
    expect(result.results).toHaveLength(0);
    expect(result.hint).toContain('developer.d-robotics.cc');
  });

  it('reads a topic and strips HTML from post bodies', async () => {
    const calls: string[] = [];
    const handlers = createDshCapabilityHandlers({
      docsFetchImpl: async (path: string) => {
        calls.push(path);
        return docsResponse({
          title: 'LeRobot ACT + RDK S600 全流程落地指南',
          slug: 'lerobot-act-s600',
          post_stream: {
            posts: [
              { username: 'official-bot', cooked: '<p>步骤一：<b>烧录</b> OE 映像</p><p>见附件</p>' },
              { username: 'engineer', cooked: '<p>实测 5 iter 即可收敛&nbsp;质疑帖</p>' },
            ],
          },
        });
      },
    });
    const result = (await handlers.rdk_docs_read({ topicId: 35286 }, exec)) as {
      title: string;
      url: string;
      content: string[];
      truncated: boolean;
    };

    expect(calls).toEqual(['/t/35286.json']);
    expect(result.title).toContain('LeRobot ACT');
    expect(result.url).toBe('https://forum.d-robotics.cc/t/lerobot-act-s600/35286');
    expect(result.content[0]).toContain('楼主 official-bot：步骤一： 烧录 OE 映像 见附件');
    expect(result.content[1]).toContain('1楼 engineer');
    expect(result.truncated).toBe(false);
  });

  it('maps upstream failures to a capability failure instead of leaking transport errors', async () => {
    const handlers = createDshCapabilityHandlers({
      docsFetchImpl: async () => docsResponse({ error: 'boom' }, 503),
    });
    await expect(handlers.rdk_docs_search({ query: 'S600' }, exec)).rejects.toMatchObject({
      code: 'DSH_CAPABILITY_FAILED',
    });
    await expect(handlers.rdk_docs_read({}, exec)).rejects.toMatchObject({
      code: 'DSH_CAPABILITY_REJECTED',
    });
  });
});
