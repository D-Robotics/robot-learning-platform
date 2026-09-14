import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The board-sessions card turns spooled lifecycle markers (session-started /
 * session-stopped) into a structured audit surface inside the run detail
 * dialog. Like the retraining advisor it is a read-only GET: opening the
 * dialog and reading sessions must never issue a POST, and every server
 * string (sessionId, stopReason, model fingerprint) must reach the DOM via
 * textContent. Honesty rules under test: interrupted sessions are labelled
 * as broken evidence rather than "healthy", unattested sessions stay
 * review-only, and the card exists for any real run — even non-terminal
 * statuses where the retraining advisor stays hidden.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'public');
const [html, telemetrySource, appSource] = await Promise.all([
  readFile(path.join(root, 'index.html'), 'utf8'),
  readFile(path.join(root, 'telemetry-core.js'), 'utf8'),
  readFile(path.join(root, 'app.js'), 'utf8'),
]);

const RUN_ID = 'run-real-1';
const SESSIONS_PATH = `/sim2real/runs/${RUN_ID}/board-sessions`;

const openWindows: Array<InstanceType<typeof JSDOM>['window']> = [];

afterEach(async () => {
  for (const window of openWindows.splice(0)) {
    window.document
      .querySelector<HTMLButtonElement>('.sidebar [data-view-target="overview"]')
      ?.click();
    await new Promise((resolve) => setTimeout(resolve, 5));
    window.close();
  }
  vi.restoreAllMocks();
});

function model() {
  return {
    id: 'model-1',
    builtin: true,
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-10T00:00:00.000Z',
    manifest: {
      schemaVersion: 1,
      modelId: 'microduck-test',
      displayName: 'MicroDuck Test',
      version: '1.0.0',
      robot: { id: 'microduck', variant: 'legs' },
      contract: {
        id: 'microduck-policy-v1',
        robotId: 'microduck',
        jointCount: 14,
        observationSize: 61,
        actionSize: 14,
        controlHz: 50,
        physicsTimestepSeconds: 0.005,
        decimation: 4,
        observationLayout: [{ name: 'state', size: 61 }],
      },
      simulator: { backends: ['browser', 'local'], policyArtifactId: 'policy' },
      artifacts: [
        {
          id: 'policy',
          role: 'policy',
          name: 'Policy',
          kind: 'source',
          format: 'onnx',
          ref: 'artifact://tests/policy.onnx',
        },
      ],
    },
  };
}

function realRun() {
  return {
    id: RUN_ID,
    modelId: 'model-1',
    backend: 'local',
    status: 'completed',
    summary: '真实本地训练 run',
    mock: false,
    taskId: 'walk',
    training: { profile: 'standard', algorithm: 'sac' },
    metrics: { contractValid: true, observationSize: 61, actionSize: 14, successRate: 0.9 },
    createdAt: '2026-09-11T00:00:00.000Z',
  };
}

function overview() {
  const selectedModel = model();
  const contract = selectedModel.manifest.contract;
  return {
    ok: true,
    schemaVersion: 1,
    identity: null,
    productProfiles: [
      {
        id: 'microduck',
        displayName: 'MicroDuck',
        contractMode: 'fixed',
        contractId: contract.id,
        targetPlatforms: ['rdk-x5'],
        accessories: [],
      },
    ],
    selectedProductId: 'microduck',
    selectedContract: contract,
    contract,
    availableContracts: [],
    contracts: { microduck: [], originbot: [], 'rdk-duck': [] },
    models: [selectedModel],
    runs: [
      realRun(),
      {
        // A real-but-failed run still owns board session evidence; the
        // retraining advisor is the panel that requires a terminal status.
        id: 'run-failed-1',
        modelId: selectedModel.id,
        backend: 'local',
        status: 'failed',
        summary: '板端会话中断的真实 run',
        mock: false,
        taskId: 'walk',
        metrics: { contractValid: true, observationSize: 61, actionSize: 14 },
        createdAt: '2026-09-12T00:00:00.000Z',
      },
      {
        id: 'mock-run-1',
        modelId: selectedModel.id,
        backend: 'local',
        status: 'completed',
        summary: 'protocol fixture',
        mock: true,
        metrics: { contractValid: true, observationSize: 61, actionSize: 14 },
        createdAt: '2026-09-10T00:00:00.000Z',
      },
    ],
    deployments: [],
    devices: [],
    computeResources: [],
    integrations: {
      simulator: {
        browser: { available: true, entryUrl: '/mujoco/microduck/' },
        boardAgent: { available: false, reason: 'not configured' },
        robogo: { available: false, reason: 'not configured' },
        local: {
          available: true,
          reachable: true,
          healthy: true,
          mock: true,
          message: 'mock protocol worker',
        },
      },
      robogo: {
        state: 'unavailable',
        clusterQueried: false,
        devMachineQueried: false,
        message: 'not configured',
      },
      storage: { mode: 'local-server', writable: true, message: 'ready' },
    },
    supportedPlatforms: [],
  };
}

function canvasContext() {
  const gradient = { addColorStop: () => undefined };
  return new Proxy(
    {},
    {
      get: (_target, property) => {
        if (property === 'measureText') return () => ({ width: 10 });
        if (property === 'createLinearGradient') return () => gradient;
        return () => undefined;
      },
      set: () => true,
    },
  );
}

function boardSessions() {
  return [
    {
      sessionId: 'sess-11111111-2222-3333-4444-555555555555',
      startedAt: '2026-09-13T08:30:00.000Z',
      stoppedAt: '2026-09-13T08:32:30.000Z',
      stopReason: 'operator-stop',
      lastInferenceAt: '2026-09-13T08:32:29.900Z',
      inferenceCount: 1500,
      published: 1500,
      inferMs: 1.4,
      durationSec: 150.2,
      mock: false,
      adapterId: 'rdk-x5-originbot-real',
      controlHz: 10,
      deviceId: 'device-1',
      model: {
        sha256: 'ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12',
        provider: 'onnxruntime',
        inputDim: 61,
        outputDim: 14,
        bytes: 204800,
      },
      attested: true,
      chunks: 3,
      events: 2,
    },
    {
      sessionId: 'sess-99999999-8888-7777-6666-555555555555',
      startedAt: '2026-09-13T09:00:00.000Z',
      stoppedAt: '2026-09-13T09:00:03.100Z',
      stopReason: 'fault:imu-timeout',
      inferenceCount: 31,
      published: 31,
      inferMs: 2.1,
      durationSec: 3.1,
      mock: true,
      adapterId: 'rdk-x5-originbot-real',
      controlHz: 10,
      deviceId: 'device-1',
      attested: false,
      chunks: 1,
      events: 2,
    },
  ];
}

interface FetchCall {
  url: string;
  init?: RequestInit;
}

interface BootOptions {
  sessions?: unknown;
  sessionsStatus?: number;
  sessionsError?: unknown;
  sessionsPayload?: unknown;
  /** Held open to observe the inline loading state before the GET settles. */
  sessionsGate?: Promise<void>;
}

async function boot(options: BootOptions = {}) {
  const dom = new JSDOM(html, {
    url: 'http://127.0.0.1:3000/sim2real/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  openWindows.push(dom.window);
  const { window } = dom;
  const errors: string[] = [];
  window.addEventListener('error', (event) => errors.push(event.error?.message || event.message));
  Object.defineProperty(window.HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: () => canvasContext(),
  });
  Object.defineProperty(window.Element.prototype, 'scrollIntoView', {
    configurable: true,
    value: () => undefined,
  });
  const dialogPrototype = window.HTMLDialogElement?.prototype;
  if (dialogPrototype) {
    Object.defineProperties(dialogPrototype, {
      showModal: {
        configurable: true,
        value() {
          this.setAttribute('open', '');
        },
      },
      close: {
        configurable: true,
        value() {
          this.removeAttribute('open');
          this.dispatchEvent(new window.Event('close'));
        },
      },
    });
  }
  const calls: FetchCall[] = [];
  Object.assign(window, {
    confirm: vi.fn(() => true),
    fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      let payload: unknown = { ok: true };
      let status = 200;
      if (url.includes('/board-sessions')) {
        if (options.sessionsGate) await options.sessionsGate;
        status = options.sessionsStatus ?? 200;
        payload =
          options.sessionsError !== undefined
            ? options.sessionsError
            : (options.sessionsPayload ?? {
                ok: true,
                runId: RUN_ID,
                sessions: options.sessions ?? boardSessions(),
                count: 2,
              });
      } else if (url.includes('/retraining-advice')) {
        payload = {
          ok: true,
          advice: {
            verdict: 'insufficient-evidence',
            checkedAt: '2026-09-13T09:05:00.000Z',
            runId: RUN_ID,
            taskId: 'walk',
            boardSamples: 0,
            signals: [],
            summary: '板端证据不足。',
            note: '建议为只读分析：绝不自动发起重训。',
          },
        };
      } else if (url.includes('/overview')) payload = overview();
      else if (url.includes('/workspace-summary')) {
        payload = { ok: true, counts: { models: 1, runs: 3, deployments: 0, devices: 0 } };
      } else if (url.endsWith('/projects')) payload = { ok: true, projects: [] };
      else if (url.endsWith('/datasets')) payload = { ok: true, datasets: [] };
      else if (url.includes('/models/model-1')) {
        payload = { ok: true, model: model(), compatibility: [] };
      }
      return new Response(JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }),
    matchMedia: () => ({ matches: false, addListener() {}, removeListener() {} }),
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    Notification: class {
      static permission = 'denied';
    },
    open: vi.fn(),
    scrollTo: vi.fn(),
    structuredClone: globalThis.structuredClone,
  });
  window.requestAnimationFrame = (callback) => {
    callback(Date.now());
    return 1;
  };
  window.cancelAnimationFrame = () => undefined;
  window.eval(telemetrySource);
  window.eval(appSource);

  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (window.document.querySelector('#main-content')?.getAttribute('aria-busy') === 'false')
      break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return { window, errors, calls };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 25));

/** Open the run detail dialog from the records view and load board sessions. */
async function openBoardSessionsPanel(
  window: InstanceType<typeof JSDOM>['window'],
  recordId = RUN_ID,
) {
  window.document
    .querySelector<HTMLButtonElement>('.sidebar [data-view-target="records"]')
    ?.click();
  const row = window.document.querySelector<HTMLButtonElement>(`[data-record-id="${recordId}"]`);
  expect(row, 'records view must list the run').toBeTruthy();
  row?.click();
  const card = window.document.querySelector<HTMLElement>('#run-board-sessions');
  const load = card?.querySelector<HTMLButtonElement>('#run-board-sessions-load');
  expect(load, 'run detail must expose the board sessions entry').toBeTruthy();
  load?.click();
  await flush();
  const body = card?.querySelector<HTMLElement>('#run-board-sessions-body');
  expect(body, 'sessions panel must render an inline state surface').toBeTruthy();
  return { card: card as HTMLElement, body: body as HTMLElement };
}

describe('Sim2Real board sessions panel (read-only structured board-run evidence)', () => {
  it('renders sessions with audit fields, attest badges, and the model fingerprint', async () => {
    const { window, errors, calls } = await boot();
    const { body } = await openBoardSessionsPanel(window);

    expect(body.textContent).toContain('共 2 个会话');
    expect(body.textContent).toContain('sess-11111111-2222-3333-4444-555555555555');
    expect(body.textContent).toContain('操作员停止');
    expect(body.textContent).toContain('1500');
    expect(body.textContent).toContain('1.40 ms');
    expect(body.textContent).toContain('150.2 s');
    expect(body.textContent).toContain('10 Hz');
    expect(body.textContent).toContain('device-1');

    const cards = [...body.querySelectorAll('.run-board-session')];
    expect(cards).toHaveLength(2);
    expect(cards[0]?.querySelector('.run-board-session-attest')?.textContent).toBe('attested');
    expect(cards[0]?.className).not.toContain('is-review-only');
    // Unattested + mock sessions stay visually review-only.
    expect(cards[1]?.querySelector('.run-board-session-attest')?.textContent).toBe('review-only');
    expect(cards[1]?.className).toContain('is-review-only');
    expect(cards[1]?.querySelector('.run-board-session-attest.is-mock')?.textContent).toBe('mock');
    expect(cards[1]?.textContent).toContain('故障：imu-timeout');

    const expectedStart = new Date('2026-09-13T08:30:00.000Z').toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    expect(cards[0]?.textContent).toContain(expectedStart);

    const modelLine = cards[0]?.querySelector('.run-board-session-model')?.textContent ?? '';
    expect(modelLine).toContain('模型指纹：');
    expect(modelLine).toContain('onnxruntime');
    expect(modelLine).toContain('61→14');
    expect(modelLine).toContain('200KB');
    expect(modelLine).toContain('ab12ab12ab12');

    expect(body.textContent).toContain('未 attested 的会话不满足发布闸门');

    // Reading evidence is read-only: exactly one GET, never a POST.
    const sessionCalls = calls.filter((call) => call.url.includes('/board-sessions'));
    expect(sessionCalls).toHaveLength(1);
    expect(sessionCalls[0]?.url).toContain(SESSIONS_PATH);
    expect(calls.every((call) => String(call.init?.method ?? 'GET').toUpperCase() !== 'POST')).toBe(
      true,
    );
    expect(errors).toEqual([]);
  });

  it('labels an interrupted session honestly instead of fabricating a stop', async () => {
    const sessions = [
      {
        sessionId: 'sess-22222222-3333-4444-5555-666666666666',
        startedAt: '2026-09-13T08:30:00.000Z',
        inferenceCount: 12,
        published: 12,
        deviceId: 'device-1',
        attested: true,
        chunks: 1,
        events: 1,
      },
    ];
    const { window, errors } = await boot({ sessions });
    const { body } = await openBoardSessionsPanel(window);

    expect(body.textContent).toContain('中断（未见停止事件，如进程被杀）');
    expect(body.textContent).not.toContain('操作员停止');
    expect(body.textContent).not.toContain('健康');
    expect(errors).toEqual([]);
  });

  it('renders the empty state as an honest outcome, not an error', async () => {
    const { window, errors } = await boot({
      sessions: [],
      sessionsPayload: { ok: true, runId: RUN_ID, sessions: [], count: 0 },
    });
    const { body } = await openBoardSessionsPanel(window);

    expect(body.textContent).toContain('该 run 暂无上板会话记录');
    expect(body.textContent).toContain('先在 station 页完成一次策略 start→stop');
    expect(body.querySelector('.run-retrain-error')).toBeNull();
    expect(errors).toEqual([]);
  });

  it('keeps injected server strings as text and never builds elements', async () => {
    const sessions = boardSessions();
    sessions[0].stopReason = '<img src=x onerror="window.__xss=1">';
    sessions[0].model = {
      provider: '<script>window.__xss=2</script>',
      sha256: 'ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12',
      inputDim: 61,
      outputDim: 14,
      bytes: 204800,
    };
    const { window, errors } = await boot({ sessions });
    const { body } = await openBoardSessionsPanel(window);

    expect(body.querySelector('img')).toBeNull();
    expect(body.querySelector('script')).toBeNull();
    expect((window as unknown as { __xss?: number }).__xss).toBeUndefined();
    const fields = [...body.querySelectorAll('.run-detail-field')];
    const stopField = fields.find((node) => node.textContent?.includes('结束'));
    expect(stopField?.textContent).toContain('<img src=x onerror="window.__xss=1">');
    const modelLine = body.querySelector('.run-board-session-model')?.textContent ?? '';
    expect(modelLine).toContain('<script>window.__xss=2</script>');
    expect(errors).toEqual([]);
  });

  it('distinguishes a missing run (404) from a generic failure, both retryable', async () => {
    const { window, errors } = await boot({
      sessionsStatus: 404,
      sessionsError: {
        ok: false,
        error: 'SIM2REAL_RUN_NOT_FOUND',
        message: '运行记录不存在，或不属于当前账号。',
      },
    });
    const { body } = await openBoardSessionsPanel(window);

    expect(body.textContent).toContain('运行记录不存在');
    expect(body.querySelector('.run-retrain-error.is-not-found')).not.toBeNull();
    expect(body.querySelector('#run-board-sessions-retry')).not.toBeNull();
    expect(errors).toEqual([]);

    const genericWindow = await boot({
      sessionsStatus: 500,
      sessionsError: { ok: false, error: 'SIM2REAL_INTERNAL', message: '遥测存储暂时不可用' },
    });
    const generic = await openBoardSessionsPanel(genericWindow.window);
    expect(generic.body.textContent).toContain('暂时无法读取上板会话');
    expect(generic.body.textContent).toContain('遥测存储暂时不可用');
    expect(generic.body.querySelector('.run-retrain-error.is-not-found')).toBeNull();
    expect(generic.body.querySelector('#run-board-sessions-retry')).not.toBeNull();
  });

  it('fails closed when the payload has no sessions array', async () => {
    const { window, errors } = await boot({ sessionsPayload: { ok: true, runId: RUN_ID } });
    const { body } = await openBoardSessionsPanel(window);

    expect(body.textContent).toContain('暂时无法读取上板会话');
    expect(body.textContent).toContain('服务端返回缺少 sessions 数组');
    expect(body.querySelector('#run-board-sessions-retry')).not.toBeNull();
    expect(errors).toEqual([]);
  });

  it('shows an inline loading state before the request settles', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { window } = await boot({ sessionsGate: gate });
    const { body } = await openBoardSessionsPanel(window);

    expect(body.textContent).toContain('读取中');
    expect(body.querySelector('.run-board-session')).toBeNull();

    release?.();
    await flush();
    expect(body.textContent).toContain('共 2 个会话');
  });

  it('shows the sessions card for a non-terminal real run where the retrain card stays hidden', async () => {
    const { window } = await boot();
    const { card } = await openBoardSessionsPanel(window, 'run-failed-1');

    expect(card.dataset.runId).toBe('run-failed-1');
    expect(window.document.querySelector('#run-retrain-card')).toBeNull();
    expect(window.document.querySelector('#run-retrain-load')).toBeNull();
  });

  it('does not offer the sessions card for mock protocol runs', async () => {
    const { window } = await boot();
    window.document
      .querySelector<HTMLButtonElement>('.sidebar [data-view-target="records"]')
      ?.click();
    const mockRow = window.document.querySelector<HTMLButtonElement>(
      '[data-record-id="mock-run-1"]',
    );
    expect(mockRow).toBeTruthy();
    mockRow?.click();
    expect(window.document.querySelector('#run-board-sessions')).toBeNull();
    expect(window.document.querySelector('#run-board-sessions-load')).toBeNull();
  });
});
