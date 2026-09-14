/**
 * Product bindings for the DSH capability tools.
 *
 * Each handler calls this service's own authenticated domain routes over the
 * loopback executor instead of reaching into store internals. That keeps one
 * enforcement path — RBAC, motion switches, release-evidence gates, ledger
 * serialization — behind every model-initiated action, identical to what the
 * legacy agent executor and the web UI exercise.
 *
 * DSH tools are registered once at startup and have no per-request channel,
 * while HTTP auth is per-request. `createDshAuthChannel` bridges that gap: the
 * chat route stashes the caller's forwarded headers for the duration of one
 * turn, and handlers read them from the queue head. DSH turns are serialized
 * through the same channel (one in-flight turn), so the head always belongs
 * to the turn currently executing tools.
 */
import type { DshCapabilityHandlers } from './dsh-capability-tools.js';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import { readSim2RealAgentResponseText } from '../routes/sim2real-agent-routes.js';

export type LoopbackFetch = (
  path: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal: AbortSignal;
  },
) => Promise<Response>;

type ChannelEntry = { headers: Record<string, string> };

const channel: ChannelEntry[] = [];

/** Forward one turn's caller identity (cookie / authorization) to tool calls. */
export function createDshAuthChannel(): {
  withAuth<T>(headers: Record<string, string>, work: () => Promise<T>): Promise<T>;
} {
  return {
    withAuth: async <T>(headers: Record<string, string>, work: () => Promise<T>) => {
      const entry: ChannelEntry = { headers };
      channel.push(entry);
      try {
        return await work();
      } finally {
        const index = channel.indexOf(entry);
        if (index >= 0) channel.splice(index, 1);
      }
    },
  };
}

function forwardedHeaders(): Record<string, string> {
  return { ...(channel[0]?.headers ?? {}) };
}

function loopbackFetch(): LoopbackFetch {
  const port = Number(process.env.RDK_SIM2REAL_PORT ?? 18_102);
  const base = `http://127.0.0.1:${Number.isInteger(port) && port >= 1_024 && port <= 65_535 ? port : 18_102}`;
  return async (path, init) => {
    const response = await fetch(base + path, {
      method: init.method,
      headers: { accept: 'application/json', ...init.headers },
      body: init.body,
      redirect: 'error',
      signal: init.signal,
    });
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

type LoopbackResult = { status: number; ok: boolean; body: Record<string, unknown> };

async function call(
  fetchImpl: LoopbackFetch,
  signal: AbortSignal,
  path: string,
  init: { method: string; json?: unknown; idempotencyKey?: string },
): Promise<LoopbackResult> {
  const headers = { ...forwardedHeaders() };
  if (init.json !== undefined) headers['content-type'] = 'application/json';
  if (init.idempotencyKey) headers['idempotency-key'] = init.idempotencyKey;
  const raw = await fetchImpl(path, {
    method: init.method,
    headers,
    body: init.json === undefined ? undefined : JSON.stringify(init.json),
    signal,
  });
  const text = await readSim2RealAgentResponseText(raw);
  let body: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(text || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    // HTML error pages and non-JSON bodies collapse to an empty payload;
    // the HTTP status alone drives the failure path.
  }
  return { status: raw.status, ok: raw.ok, body };
}

/**
 * Model-facing failures carry a short stable code plus the route's own
 * user-facing message; transport detail and upstream bodies never reach the
 * conversation.
 */
class CapabilityError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CapabilityError';
  }
}

function fail(status: number, body: Record<string, unknown>, fallback: string): never {
  const routeMessage = typeof body.message === 'string' ? body.message.trim() : '';
  throw new CapabilityError(
    status >= 400 && status < 500 ? 'DSH_CAPABILITY_REJECTED' : 'DSH_CAPABILITY_FAILED',
    routeMessage || fallback,
  );
}

function argsRecord(args: unknown): Record<string, unknown> {
  return args && typeof args === 'object' && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : {};
}

/**
 * DSH requires tool results to be lossless JSON: a property holding
 * `undefined` survives normal `JSON.stringify` elision but fails the
 * registry's canonical-value check, so every optional field is normalized to
 * a concrete value before returning.
 */
function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function defined(value: unknown): unknown {
  return value === undefined ? null : value;
}

function argString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value.trim().slice(0, 128) : '';
}

/** Compact, low-cardinality overview the model can reason over in one call. */
function overviewDigest(body: Record<string, unknown>): Record<string, unknown> {
  const models = Array.isArray(body.models) ? body.models : [];
  const runs = Array.isArray(body.runs) ? body.runs : [];
  const devices = Array.isArray(body.devices) ? body.devices : [];
  const deployments = Array.isArray(body.deployments) ? body.deployments : [];
  const integrations = (body.integrations ?? {}) as Record<string, unknown>;
  const simulator = (integrations.simulator ?? {}) as Record<string, unknown>;
  return {
    models: models.map((item) => {
      const model = (item ?? {}) as Record<string, unknown>;
      return { id: str(model.id), taskId: str(model.taskId), status: str(model.status) };
    }),
    runs: runs.slice(0, 10).map((item) => {
      const run = (item ?? {}) as Record<string, unknown>;
      return {
        id: str(run.id),
        status: str(run.status),
        modelId: str(run.modelId),
        backend: str(run.backend),
      };
    }),
    devices: devices.map((item) => {
      const device = (item ?? {}) as Record<string, unknown>;
      return { id: str(device.id), profile: str(device.profile), status: str(device.status) };
    }),
    deployments: deployments.slice(0, 5).map((item) => {
      const deployment = (item ?? {}) as Record<string, unknown>;
      return {
        id: str(deployment.id),
        status: str(deployment.status),
        mode: str(deployment.mode),
      };
    }),
    integrations: {
      simulator: defined(simulator.entryUrl ?? simulator.browser ?? null),
      boardAgent: defined(integrations.boardAgent),
      localTraining: defined(integrations.local),
    },
  };
}

function firstModelId(body: Record<string, unknown>): string {
  const models = Array.isArray(body.models) ? body.models : [];
  const model = (models[0] ?? {}) as Record<string, unknown>;
  return typeof model.id === 'string' ? model.id : 'builtin-microduck';
}

function firstDeviceId(body: Record<string, unknown>): string | null {
  const devices = Array.isArray(body.devices) ? body.devices : [];
  const device = (devices[0] ?? {}) as Record<string, unknown>;
  return typeof device.id === 'string' && device.id ? device.id : null;
}

/**
 * Real product handlers for the ten `rdk_*` DSH tools. Write operations ride
 * the same routes the UI uses, so RBAC and the motion/release gates apply
 * unchanged; nothing here bypasses a gate.
 */
export function createDshCapabilityHandlers(
  options: { fetchImpl?: LoopbackFetch } = {},
): DshCapabilityHandlers {
  const fetchImpl = options.fetchImpl ?? loopbackFetch();
  const run = (signal: AbortSignal) => ({
    signal,
    fetch: (path: string, init: { method: string; json?: unknown; idempotencyKey?: string }) =>
      call(fetchImpl, signal, path, init),
  });
  return {
    async rdk_workspace_overview(_args: unknown, exec: ToolRunContext) {
      const result = await run(exec.signal).fetch('/api/sim2real/overview', { method: 'GET' });
      if (!result.ok) fail(result.status, result.body, '工作区读取失败');
      return overviewDigest(result.body);
    },

    async rdk_device_discover(_args: unknown, exec: ToolRunContext) {
      const result = await run(exec.signal).fetch('/api/sim2real/device-connections', {
        method: 'GET',
      });
      if (!result.ok) fail(result.status, result.body, '设备列表读取失败');
      const connections = Array.isArray(result.body.connections) ? result.body.connections : [];
      return {
        connections: connections.map((item) => {
          const record = (item ?? {}) as Record<string, unknown>;
          return {
            id: str(record.id),
            label: str(record.label),
            host: str(record.host),
            tunnelActive: defined(record.tunnelActive),
          };
        }),
      };
    },

    async rdk_device_connect(args: unknown, exec: ToolRunContext) {
      const input = argsRecord(args);
      const connectionId = argString(input, 'connectionId');
      if (!connectionId)
        throw new CapabilityError('DSH_CAPABILITY_REJECTED', '请提供 connectionId。');
      const result = await run(exec.signal).fetch(
        `/api/sim2real/device-connections/${encodeURIComponent(connectionId)}/connect`,
        { method: 'POST', json: {} },
      );
      if (!result.ok) fail(result.status, result.body, '设备连接失败');
      const connection = (result.body.connection ?? {}) as Record<string, unknown>;
      const probe = (result.body.probe ?? {}) as Record<string, unknown>;
      return {
        connectionId,
        tunnelActive: defined(connection.tunnelActive),
        probe: {
          ok: defined(probe.ok),
          platform: str(probe.platform),
          model: str(probe.model),
        },
      };
    },

    async rdk_board_health(_args: unknown, exec: ToolRunContext) {
      const result = await run(exec.signal).fetch('/api/sim2real/board-station/health', {
        method: 'GET',
      });
      if (!result.ok) fail(result.status, result.body, '板端健康检查失败');
      const agent = (result.body.agent ?? {}) as Record<string, unknown>;
      const device = (result.body.device ?? {}) as Record<string, unknown>;
      return {
        online: result.body.ok !== false,
        device: { id: str(device.id), profile: str(device.profile) },
        agent: {
          state: str(agent.state ?? result.body.status),
          capabilities: defined(agent.capabilities),
          actuatorControl: defined(agent.actuatorControl),
        },
      };
    },

    async rdk_training_submit(args: unknown, exec: ToolRunContext) {
      const input = argsRecord(args);
      const overview = await run(exec.signal).fetch('/api/sim2real/overview', { method: 'GET' });
      if (!overview.ok) fail(overview.status, overview.body, '工作区读取失败');
      const modelId = argString(input, 'modelId') || firstModelId(overview.body);
      const idempotencyKey = `dsh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const result = await run(exec.signal).fetch('/api/sim2real/runs', {
        method: 'POST',
        idempotencyKey,
        json: {
          modelId,
          backend: 'local',
          taskId: argString(input, 'taskId') || 'walk',
          training: { profile: argString(input, 'profile') || 'smoke' },
          ...(argString(input, 'computeResourceId')
            ? { computeResourceId: argString(input, 'computeResourceId') }
            : {}),
        },
      });
      if (!result.ok) fail(result.status, result.body, 'GPU 训练提交失败');
      const trainingRun = (result.body.run ?? {}) as Record<string, unknown>;
      return {
        runId: str(trainingRun.id),
        status: str(trainingRun.status),
        modelId,
        note: '任务已提交；用 rdk_training_status 查询进度。',
      };
    },

    async rdk_training_status(args: unknown, exec: ToolRunContext) {
      const input = argsRecord(args);
      const runId = argString(input, 'runId');
      if (!runId) throw new CapabilityError('DSH_CAPABILITY_REJECTED', '请提供 runId。');
      let target = runId;
      if (!target) {
        const overview = await run(exec.signal).fetch('/api/sim2real/overview', { method: 'GET' });
        const runs = overview.ok && Array.isArray(overview.body.runs) ? overview.body.runs : [];
        target = String(((runs[0] ?? {}) as Record<string, unknown>).id ?? '');
      }
      if (!target)
        throw new CapabilityError('DSH_CAPABILITY_REJECTED', '当前没有可查询的训练任务。');
      const result = await run(exec.signal).fetch(
        `/api/sim2real/runs/${encodeURIComponent(target)}`,
        { method: 'GET' },
      );
      if (!result.ok) fail(result.status, result.body, '训练状态查询失败');
      const trainingRun = (result.body.run ?? {}) as Record<string, unknown>;
      const metrics = (trainingRun.metrics ?? {}) as Record<string, unknown>;
      return {
        runId: str(trainingRun.id),
        status: str(trainingRun.status),
        modelId: str(trainingRun.modelId),
        backend: str(trainingRun.backend),
        metrics: {
          reward: defined(metrics.reward),
          successRate: defined(metrics.successRate),
          fallRate: defined(metrics.fallRate),
          iterations: defined(metrics.iterations),
        },
      };
    },

    async rdk_simulator_open(_args: unknown, exec: ToolRunContext) {
      const overview = await run(exec.signal).fetch('/api/sim2real/overview', { method: 'GET' });
      if (!overview.ok) fail(overview.status, overview.body, '工作区读取失败');
      const digest = overviewDigest(overview.body);
      const integrations = (digest.integrations ?? {}) as Record<string, unknown>;
      const entryUrl =
        (typeof integrations.simulator === 'string' && integrations.simulator) ||
        (process.env.RDK_SIM2REAL_MICRODUCK_URL
          ? '/mujoco/microduck-proxy/'
          : '/mujoco/microduck/');
      return {
        entryUrl: String(entryUrl),
        note: '在浏览器打开该路径即可查看参考仿真。',
      };
    },

    async rdk_evaluation_summarize(args: unknown, exec: ToolRunContext) {
      const input = argsRecord(args);
      let runId = argString(input, 'runId');
      if (!runId) {
        const overview = await run(exec.signal).fetch('/api/sim2real/overview', { method: 'GET' });
        if (!overview.ok) fail(overview.status, overview.body, '工作区读取失败');
        const runs = Array.isArray(overview.body.runs) ? overview.body.runs : [];
        const latest =
          runs.find(
            (item) => String((item as Record<string, unknown>).status ?? '') === 'completed',
          ) ?? runs[0];
        runId = String((latest as Record<string, unknown> | undefined)?.id ?? '');
      }
      if (!runId)
        throw new CapabilityError('DSH_CAPABILITY_REJECTED', '当前没有可汇总的训练运行。');
      const result = await run(exec.signal).fetch(
        `/api/sim2real/runs/${encodeURIComponent(runId)}/evaluate`,
        { method: 'POST', json: {} },
      );
      if (!result.ok) fail(result.status, result.body, '评测执行失败');
      const trainingRun = (result.body.run ?? {}) as Record<string, unknown>;
      const metrics = (trainingRun.metrics ?? {}) as Record<string, unknown>;
      const evaluation = (result.body.evaluation ?? {}) as Record<string, unknown>;
      const replay = (evaluation.replay ?? {}) as Record<string, unknown>;
      return {
        runId,
        status: trainingRun.status,
        metrics: {
          reward: defined(metrics.reward),
          successRate: defined(metrics.successRate),
          fallRate: defined(metrics.fallRate),
          iterations: defined(metrics.iterations),
        },
        replay: {
          sampleCount: defined(replay.sampleCount),
          fallCount: defined(replay.fallCount),
          doneCount: defined(replay.doneCount),
        },
        warnings: Array.isArray(evaluation.warnings) ? evaluation.warnings.slice(0, 3) : [],
      };
    },

    async rdk_deployment_preflight(args: unknown, exec: ToolRunContext) {
      const input = argsRecord(args);
      const overview = await run(exec.signal).fetch('/api/sim2real/overview', { method: 'GET' });
      if (!overview.ok) fail(overview.status, overview.body, '工作区读取失败');
      const modelId = argString(input, 'modelId') || firstModelId(overview.body);
      const deviceId = argString(input, 'deviceId') || firstDeviceId(overview.body);
      if (!deviceId) throw new CapabilityError('DSH_CAPABILITY_REJECTED', '当前没有可用目标板卡。');
      const idempotencyKey = `dsh-deploy-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const created = await run(exec.signal).fetch('/api/sim2real/deployments', {
        method: 'POST',
        idempotencyKey,
        json: { modelId, deviceId, mode: 'preflight' },
      });
      if (!created.ok) fail(created.status, created.body, '部署计划创建失败');
      const deployment = (created.body.deployment ?? {}) as Record<string, unknown>;
      const deploymentId = typeof deployment.id === 'string' ? deployment.id : '';
      if (!deploymentId)
        throw new CapabilityError('DSH_CAPABILITY_FAILED', '部署计划创建未返回 ID。');
      const result = await run(exec.signal).fetch(
        `/api/sim2real/deployments/${encodeURIComponent(deploymentId)}/preflight`,
        { method: 'POST', json: {} },
      );
      const mockDrill =
        !result.ok &&
        (result.body.error === 'SIM2REAL_PREFLIGHT_MOCK_ONLY' ||
          ((result.body.preflight ?? null) as Record<string, unknown> | null)?.mock === true);
      if (!result.ok && !mockDrill) fail(result.status, result.body, '只读预检失败');
      const preflight = (result.body.preflight ?? {}) as Record<string, unknown>;
      return {
        deploymentId,
        modelId,
        deviceId,
        passed: preflight.passed === true,
        mock: mockDrill || preflight.mock === true,
        checks: defined(preflight.checks),
        note: mockDrill ? '协议演练通过；模拟 BoardAgent 不构成真机证据。' : '',
      };
    },

    async rdk_board_stop(_args: unknown, exec: ToolRunContext) {
      const context = run(exec.signal);
      let policyStop: LoopbackResult | null = null;
      let driveStop: LoopbackResult | null = null;
      try {
        policyStop = await context.fetch('/api/sim2real/board-station/policy/stop', {
          method: 'POST',
          json: {},
        });
      } catch {
        // Always attempt the independent emergency drive stop below.
      }
      try {
        driveStop = await context.fetch('/api/sim2real/board-station/drive/stop', {
          method: 'POST',
          json: {},
        });
      } catch {
        // The failure below records that the safety state is unknown.
      }
      if (
        !policyStop ||
        !driveStop ||
        !policyStop.ok ||
        !driveStop.ok ||
        policyStop.body.ok === false ||
        driveStop.body.ok === false
      ) {
        throw new CapabilityError('DSH_CAPABILITY_FAILED', '停止命令未能同时确认策略与驱动状态。');
      }
      return { policyStopped: true, driveStopped: true };
    },
  };
}
