import { afterEach, describe, expect, it } from 'vitest';

import {
  createDshAuthChannel,
  createDshCapabilityHandlers,
  type LoopbackFetch,
} from './dsh-capability-handlers.js';

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
