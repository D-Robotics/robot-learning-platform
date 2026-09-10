import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The retraining advisor is the read-only half of the telemetry flywheel:
 * GET /runs/:id/retraining-advice reports drift signals and a pre-filled
 * training request, but the workbench must never submit a run from it. These
 * tests boot the real app bundle in jsdom, drive the real DOM, and assert both
 * the rendered honesty semantics (verdicts, null measures, 404) and the
 * negative guarantee that no POST is ever issued.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'public');
const [html, telemetrySource, appSource] = await Promise.all([
  readFile(path.join(root, 'index.html'), 'utf8'),
  readFile(path.join(root, 'telemetry-core.js'), 'utf8'),
  readFile(path.join(root, 'app.js'), 'utf8'),
]);

const RUN_ID = 'run-real-1';
const ADVICE_PATH = `/sim2real/runs/${RUN_ID}/retraining-advice`;

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

/** A completed real run: the only kind that may surface the advice panel. */
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

function recommendedAdvice() {
  return {
    verdict: 'retrain-recommended',
    checkedAt: '2026-09-11T01:02:03.000Z',
    runId: RUN_ID,
    taskId: 'walk',
    boardSamples: 480,
    signals: [
      {
        id: 'action-mae',
        label: '板端动作 MAE（对参考轨迹）',
        value: 0.42,
        threshold: 0.25,
        breached: true,
        evidence: '评测计算于 2026-09-11，参考样本 200 条',
      },
      {
        id: 'done-ratio',
        label: '板端终止占比（done/fall）',
        value: 0.1,
        threshold: 0.5,
        breached: false,
        evidence: '480 条遥测样本，48 条标记终止',
      },
    ],
    summary: '建议重训：板端动作 MAE（对参考轨迹）超过建议阈值。',
    suggestedTraining: {
      taskId: 'walk',
      backend: 'local',
      training: { profile: 'standard', algorithm: 'sac' },
    },
    note: '建议为只读分析：绝不自动发起重训；suggestedTraining 只是填好的请求体，由操作员显式提交。',
  };
}

interface FetchCall {
  url: string;
  init?: RequestInit;
}

interface BootOptions {
  advice?: unknown;
  adviceStatus?: number;
  adviceError?: unknown;
  /** Held open to observe the inline loading state before the GET settles. */
  adviceGate?: Promise<void>;
  /** Result of the operator confirmation dialog (default: accepted). */
  confirmResult?: boolean;
  runStatus?: number;
  runError?: unknown;
  /** Held open to observe the in-flight (disabled) submit button state. */
  runGate?: Promise<void>;
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
  const confirm = vi.fn(() => options.confirmResult ?? true);
  Object.assign(window, {
    confirm,
    fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      let payload: unknown = { ok: true };
      let status = 200;
      if (url.includes('/retraining-advice')) {
        if (options.adviceGate) await options.adviceGate;
        status = options.adviceStatus ?? 200;
        payload =
          options.adviceError !== undefined
            ? options.adviceError
            : { ok: true, advice: options.advice ?? recommendedAdvice() };
      } else if (init?.method === 'POST' && /\/sim2real\/runs$/.test(url)) {
        // The operator-confirmed retrain action is the only writer.
        if (options.runGate) await options.runGate;
        status = options.runStatus ?? 200;
        payload =
          options.runError !== undefined
            ? options.runError
            : { ok: true, run: { id: 'run-retrain-1', status: 'queued', summary: '本地重训' } };
      } else if (url.includes('/overview')) payload = overview();
      else if (url.includes('/workspace-summary')) {
        payload = { ok: true, counts: { models: 1, runs: 2, deployments: 0, devices: 0 } };
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
  return { window, errors, calls, confirm };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 25));

/** Open the run detail dialog from the records view and click the entry. */
async function openAdvicePanel(window: InstanceType<typeof JSDOM>['window']) {
  window.document
    .querySelector<HTMLButtonElement>('.sidebar [data-view-target="records"]')
    ?.click();
  const row = window.document.querySelector<HTMLButtonElement>(`[data-record-id="${RUN_ID}"]`);
  expect(row, 'records view must list the completed real run').toBeTruthy();
  row?.click();
  const card = window.document.querySelector<HTMLElement>('#run-retrain-card');
  const load = card?.querySelector<HTMLButtonElement>('#run-retrain-load');
  expect(load, 'run detail must expose the retraining advice entry').toBeTruthy();
  load?.click();
  await flush();
  const body = card?.querySelector<HTMLElement>('#run-retrain-body');
  expect(body, 'advice panel must render an inline state surface').toBeTruthy();
  return { card: card as HTMLElement, body: body as HTMLElement };
}

describe('Sim2Real retraining advice panel (read-only analysis + explicit operator submit)', () => {
  it('renders retrain-recommended with every signal and a breached highlight', async () => {
    const { window, errors } = await boot({ advice: recommendedAdvice() });
    const { body } = await openAdvicePanel(window);

    expect(body.textContent).toContain('建议重训');
    expect(body.textContent).toContain('建议重训：板端动作 MAE（对参考轨迹）超过建议阈值。');
    expect(body.textContent).toContain('板端样本 480 条');

    const labels = [...body.querySelectorAll('.run-retrain-signal-label')].map(
      (node) => node.textContent,
    );
    expect(labels).toEqual(['板端动作 MAE（对参考轨迹）', '板端终止占比（done/fall）']);

    const breached = body.querySelectorAll('.run-retrain-signal.is-breached');
    expect(breached).toHaveLength(1);
    expect(breached[0]?.textContent).toContain('板端动作 MAE（对参考轨迹）');
    expect(breached[0]?.textContent).toContain('已越限');

    const verdict = body.querySelector('.run-retrain-verdict');
    expect(verdict?.className).toContain('is-retrain-recommended');
    expect(verdict?.textContent).toBe('建议重训');

    // The suggested request body is displayed read-only; the only action is a
    // separate, explicitly-clicked operator button.
    expect(body.textContent).toContain('需人工显式提交');
    expect(body.textContent).toContain('平台不会自动发起训练');
    expect(body.querySelector('.run-retrain-suggested pre')?.textContent).toContain(
      '"profile": "standard"',
    );
    expect(body.querySelector('.run-retrain-suggested pre')?.textContent).toContain(
      '"algorithm": "sac"',
    );
    const submit = body.querySelector<HTMLButtonElement>('#run-retrain-submit');
    expect(submit, 'retrain-recommended must offer the explicit operator action').not.toBeNull();
    expect(submit?.textContent).toBe('按建议发起重训');
    expect(submit?.disabled).toBe(false);

    // The server note is always surfaced.
    expect(body.querySelector('.run-retrain-note')?.textContent).toContain('绝不自动发起重训');

    expect(errors).toEqual([]);
  });

  it('renders insufficient-evidence as an honest neutral outcome, not a success', async () => {
    const advice = {
      verdict: 'insufficient-evidence',
      checkedAt: '2026-09-11T01:02:03.000Z',
      runId: RUN_ID,
      taskId: 'walk',
      boardSamples: 40,
      signals: [
        {
          id: 'action-mae',
          label: '板端动作 MAE（对参考轨迹）',
          value: null,
          threshold: 0.25,
          breached: false,
          evidence: '没有 reference 轨迹可比（未传 referenceSamples 或未评测）',
        },
      ],
      summary:
        '板端证据不足（40/120 条 board-agent 回放样本）。先在板上跑一次策略会话并回传遥测，再谈重训。',
      note: '建议为只读分析：绝不自动发起重训；suggestedTraining 只是填好的请求体，由操作员显式提交。',
    };

    const { window, errors } = await boot({ advice });
    const { body } = await openAdvicePanel(window);

    const verdict = body.querySelector('.run-retrain-verdict');
    expect(verdict?.textContent).toContain('证据不足');
    expect(verdict?.className).toContain('is-insufficient-evidence');
    expect(body.textContent).toContain('板端证据不足（40/120 条 board-agent 回放样本）');
    expect(body.textContent).toContain('证据不足是诚实结论，不是错误');

    // No success/healthy semantics anywhere in the panel body.
    expect(body.textContent).not.toContain('板端行为健康');
    expect(body.textContent).not.toContain('建议重训');
    expect(body.querySelector('.run-retrain-verdict.is-healthy')).toBeNull();
    expect(body.querySelector('.run-retrain-verdict.is-retrain-recommended')).toBeNull();
    // Evidence insufficiency must not fabricate a suggested training request,
    // and must never offer the retrain action.
    expect(body.querySelector('.run-retrain-suggested')).toBeNull();
    expect(body.querySelector('#run-retrain-submit')).toBeNull();

    expect(errors).toEqual([]);
  });

  it('offers no retrain action for a healthy verdict', async () => {
    const advice = {
      verdict: 'healthy',
      checkedAt: '2026-09-11T01:02:03.000Z',
      runId: RUN_ID,
      taskId: 'walk',
      boardSamples: 480,
      signals: [
        {
          id: 'action-mae',
          label: '板端动作 MAE（对参考轨迹）',
          value: 0.12,
          threshold: 0.25,
          breached: false,
          evidence: '评测计算于 2026-09-11，参考样本 200 条',
        },
      ],
      summary: '板端行为健康：全部信号在建议阈值内（阈值是建议性的，不是发布门）。',
      note: '建议为只读分析：绝不自动发起重训；suggestedTraining 只是填好的请求体，由操作员显式提交。',
    };

    const { window, errors, calls } = await boot({ advice });
    const { body } = await openAdvicePanel(window);

    expect(body.textContent).toContain('板端行为健康');
    expect(body.querySelector('.run-retrain-verdict.is-healthy')).not.toBeNull();
    // Healthy advice carries no suggestedTraining, so no POST entry may exist.
    expect(body.querySelector('#run-retrain-submit')).toBeNull();
    expect(body.querySelector('.run-retrain-actions')).toBeNull();
    expect(calls.some((call) => String(call.init?.method ?? 'GET').toUpperCase() === 'POST')).toBe(
      false,
    );
    expect(errors).toEqual([]);
  });

  it('renders a null signal value as incomparable/no-data instead of null or 0', async () => {
    const advice = {
      ...recommendedAdvice(),
      signals: [
        {
          id: 'action-mae',
          label: '板端动作 MAE（对参考轨迹）',
          value: null,
          threshold: 0.25,
          breached: false,
          evidence: '没有 reference 轨迹可比',
        },
      ],
    };
    const { window } = await boot({ advice });
    const { body } = await openAdvicePanel(window);

    const value = body.querySelector('.run-retrain-signal-value');
    expect(value?.textContent).toBe('不可比/无数据 / 阈值 0.250');
    expect(body.textContent).toContain('不可比/无数据');
    expect(body.textContent).not.toContain('null');
    expect(value?.textContent).not.toContain('0.000 / 阈值');
  });

  it('keeps injected server strings as text and never builds elements', async () => {
    const injectedLabel = '<img src=x onerror="window.__xss=1">';
    const injectedEvidence = '<script>window.__xss=2</script>';
    const injectedSummary = '<b>假装是粗体</b>';
    const advice = {
      ...recommendedAdvice(),
      summary: injectedSummary,
      signals: [
        {
          id: 'action-mae',
          label: injectedLabel,
          value: 0.9,
          threshold: 0.25,
          breached: true,
          evidence: injectedEvidence,
        },
      ],
      note: '<i>note</i>',
    };

    const { window, errors } = await boot({ advice });
    const { body } = await openAdvicePanel(window);

    expect(body.querySelector('img')).toBeNull();
    expect(body.querySelector('script')).toBeNull();
    expect(body.querySelector('b')).toBeNull();
    expect(body.querySelector('.run-retrain-signal-label')?.textContent).toBe(injectedLabel);
    expect(body.querySelector('.run-retrain-signal-evidence')?.textContent).toBe(injectedEvidence);
    expect(body.querySelector('.run-retrain-summary')?.textContent).toBe(injectedSummary);
    expect((window as unknown as { __xss?: number }).__xss).toBeUndefined();
    expect(errors).toEqual([]);
  });

  it('never issues a POST while booting, rendering, or loading the advice', async () => {
    const { window, calls } = await boot({ advice: recommendedAdvice() });
    await openAdvicePanel(window);

    // Opening the run detail and fetching the analysis must not submit
    // anything: rendering only wires a click listener onto the button.
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => String(call.init?.method ?? 'GET').toUpperCase() !== 'POST')).toBe(
      true,
    );
    const adviceCalls = calls.filter((call) => call.url.includes('/retraining-advice'));
    expect(adviceCalls).toHaveLength(1);
    expect(adviceCalls[0]?.url).toContain(ADVICE_PATH);
    expect(calls.some((call) => /\/sim2real\/runs\/?$/.test(call.url))).toBe(false);
  });

  it('submits exactly one training run after the operator confirms', async () => {
    const { window, calls, confirm } = await boot({
      advice: recommendedAdvice(),
      confirmResult: true,
    });
    const { body } = await openAdvicePanel(window);
    const before = calls.length;

    body.querySelector<HTMLButtonElement>('#run-retrain-submit')?.click();
    await flush();

    expect(confirm).toHaveBeenCalledTimes(1);
    const confirmText = String(confirm.mock.calls[0]?.[0] ?? '');
    expect(confirmText).toContain('显式动作');
    expect(confirmText).toContain('分析本身不会自动发起任何训练');
    expect(confirmText).toContain('walk');
    expect(confirmText).toContain('standard');

    const runCalls = calls
      .slice(before)
      .filter((call) => String(call.init?.method ?? '').toUpperCase() === 'POST');
    expect(runCalls).toHaveLength(1);
    expect(runCalls[0]?.url).toMatch(/\/sim2real\/runs$/);
    const sent = JSON.parse(String(runCalls[0]?.init?.body));
    expect(sent).toMatchObject({
      modelId: 'model-1',
      backend: 'local',
      taskId: 'walk',
      training: { profile: 'standard', algorithm: 'sac' },
    });
    expect(typeof sent.idempotencyKey).toBe('string');
    expect(sent.idempotencyKey.length).toBeGreaterThan(0);

    expect(body.querySelector('#run-retrain-submit-status')?.textContent).toContain(
      'run-retrain-1',
    );
    const submit = body.querySelector<HTMLButtonElement>('#run-retrain-submit');
    expect(submit?.disabled).toBe(false);
    expect(submit?.textContent).toBe('按建议发起重训');
  });

  it('does not submit anything when the operator cancels the confirmation', async () => {
    const { window, calls, confirm } = await boot({
      advice: recommendedAdvice(),
      confirmResult: false,
    });
    const { body } = await openAdvicePanel(window);
    const before = calls.length;

    body.querySelector<HTMLButtonElement>('#run-retrain-submit')?.click();
    await flush();

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(
      calls.slice(before).some((call) => String(call.init?.method ?? '').toUpperCase() === 'POST'),
    ).toBe(false);
    expect(body.querySelector('#run-retrain-submit-status')?.textContent).toContain('已取消');
    expect(body.querySelector<HTMLButtonElement>('#run-retrain-submit')?.disabled).toBe(false);
  });

  it('disables the button and shows progress while the submission is in flight', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { window } = await boot({
      advice: recommendedAdvice(),
      confirmResult: true,
      runGate: gate,
    });
    const { body } = await openAdvicePanel(window);
    const submit = body.querySelector<HTMLButtonElement>('#run-retrain-submit');

    submit?.click();
    await flush();

    expect(submit?.disabled).toBe(true);
    expect(submit?.textContent).toBe('提交中…');
    expect(body.querySelector('#run-retrain-submit-status')?.textContent).toContain('正在提交');

    release?.();
    await flush();
    expect(submit?.disabled).toBe(false);
    expect(submit?.textContent).toBe('按建议发起重训');
  });

  it('shows an inline retryable error and re-enables the button when the POST fails', async () => {
    const { window, errors } = await boot({
      advice: recommendedAdvice(),
      confirmResult: true,
      runStatus: 500,
      runError: { ok: false, error: 'SIM2REAL_RUN_CREATE_FAILED', message: '本地 worker 暂不可用' },
    });
    const { body } = await openAdvicePanel(window);
    const submit = body.querySelector<HTMLButtonElement>('#run-retrain-submit');

    submit?.click();
    await flush();

    const status = body.querySelector('#run-retrain-submit-status');
    expect(status?.textContent).toContain('提交失败');
    expect(status?.textContent).toContain('本地 worker 暂不可用');
    expect(submit?.disabled).toBe(false);
    expect(submit?.textContent).toBe('按建议发起重训');
    expect(errors).toEqual([]);
  });

  it('aborts without a POST and reports inline when no model id is resolvable', async () => {
    const { window, calls, confirm } = await boot({
      advice: recommendedAdvice(),
      confirmResult: true,
    });
    const { body } = await openAdvicePanel(window);
    const before = calls.length;

    const internals = window as unknown as {
      submitRetrainingFromAdvice?: (record: unknown, advice: unknown) => Promise<void>;
      selectedModel?: () => unknown;
    };
    expect(typeof internals.submitRetrainingFromAdvice).toBe('function');
    // Fail-closed branch: neither the record nor the selected model names one.
    internals.selectedModel = () => null;
    await internals.submitRetrainingFromAdvice?.({ id: RUN_ID, modelId: '' }, recommendedAdvice());
    await flush();

    expect(confirm).not.toHaveBeenCalled();
    expect(
      calls.slice(before).some((call) => String(call.init?.method ?? '').toUpperCase() === 'POST'),
    ).toBe(false);
    expect(body.querySelector('#run-retrain-submit-status')?.textContent).toContain('缺少模型 ID');
  });

  it('shows an inline loading state before the advice request settles', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { window } = await boot({ advice: recommendedAdvice(), adviceGate: gate });
    const { body } = await openAdvicePanel(window);

    expect(body.textContent).toContain('分析中');
    expect(body.querySelector('.run-retrain-verdict')).toBeNull();

    release?.();
    await flush();
    expect(body.textContent).toContain('建议重训');
  });

  it('distinguishes a missing run (404) from a generic failure', async () => {
    const { window, errors } = await boot({
      adviceStatus: 404,
      adviceError: {
        ok: false,
        error: 'SIM2REAL_RUN_NOT_FOUND',
        message: '运行记录不存在，或不属于当前账号。',
      },
    });
    const { body } = await openAdvicePanel(window);

    expect(body.textContent).toContain('运行记录不存在');
    expect(body.querySelector('.run-retrain-error.is-not-found')).not.toBeNull();
    expect(body.textContent).not.toContain('板端行为健康');
    expect(body.textContent).not.toContain('不可比/无数据');
    expect(body.querySelector('#run-retrain-retry')).not.toBeNull();
    expect(errors).toEqual([]);
  });

  it('shows an inline retryable error for a non-404 failure', async () => {
    const { window, errors } = await boot({
      adviceStatus: 500,
      adviceError: { ok: false, error: 'SIM2REAL_INTERNAL', message: '遥测存储暂时不可用' },
    });
    const { body } = await openAdvicePanel(window);

    expect(body.textContent).toContain('暂时无法获取重训建议');
    expect(body.textContent).toContain('遥测存储暂时不可用');
    expect(body.textContent).not.toContain('运行记录不存在');
    expect(body.querySelector('.run-retrain-error.is-not-found')).toBeNull();
    expect(body.querySelector('#run-retrain-retry')).not.toBeNull();
    expect(errors).toEqual([]);
  });

  it('does not offer the advice panel for mock protocol runs', async () => {
    const { window } = await boot({ advice: recommendedAdvice() });
    window.document
      .querySelector<HTMLButtonElement>('.sidebar [data-view-target="records"]')
      ?.click();
    // Mock runs still open a detail dialog, but without an advice entry.
    const mockRow = window.document.querySelector<HTMLButtonElement>(
      '[data-record-id="mock-run-1"]',
    );
    expect(mockRow).toBeTruthy();
    mockRow?.click();
    expect(window.document.querySelector('#run-retrain-card')).toBeNull();
    expect(window.document.querySelector('#run-retrain-load')).toBeNull();
  });
});
