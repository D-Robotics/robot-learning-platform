import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'public');
const [html, telemetrySource, componentSource, firstUseSource, appSource] = await Promise.all([
  readFile(path.join(root, 'index.html'), 'utf8'),
  readFile(path.join(root, 'telemetry-core.js'), 'utf8'),
  readFile(path.join(root, 'ui-components.js'), 'utf8'),
  readFile(path.join(root, 'first-use-core.js'), 'utf8'),
  readFile(path.join(root, 'app.js'), 'utf8'),
]);

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

function model(visualAssetBase?: unknown) {
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
      simulator: {
        backends: ['browser', 'local'],
        policyArtifactId: 'policy',
        ...(visualAssetBase === undefined ? {} : { visualAssetBase }),
      },
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

function overview(
  runs?: unknown[],
  extras: {
    artifacts?: unknown[];
    evaluations?: unknown[];
    deployments?: unknown[];
    visualAssetBase?: unknown;
  } = {},
) {
  const selectedModel = model(extras.visualAssetBase);
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
    runs: runs || [
      {
        id: 'mock-run-1',
        modelId: selectedModel.id,
        backend: 'local',
        status: 'completed',
        summary: 'protocol fixture',
        mock: true,
        metrics: {
          contractValid: true,
          observationSize: 61,
          actionSize: 14,
          successRate: 0.99,
          fallRate: 0,
        },
        createdAt: '2026-09-10T00:00:00.000Z',
      },
    ],
    deployments: extras.deployments || [],
    devices: [],
    computeResources: [],
    artifacts: extras.artifacts || [],
    evaluations: extras.evaluations || [],
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

function project(
  overrides: Partial<{
    id: string;
    name: string;
    slug: string;
    modelIds: string[];
    datasetIds: string[];
  }> = {},
) {
  return {
    id: 'project-1',
    name: 'OriginBot 导航',
    slug: 'originbot-navigation',
    modelIds: ['model-1'],
    datasetIds: [],
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-10T00:00:00.000Z',
    ...overrides,
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

async function boot(
  options: {
    projects?: unknown[];
    failOverview?: boolean;
    createdProject?: unknown;
    runs?: unknown[];
    artifacts?: unknown[];
    evaluations?: unknown[];
    overviewDeployments?: unknown[];
    /** Frames the replay endpoint returns; drives the aligned camera frame tests. */
    replayFrames?: unknown[];
    /** Notices payload served by GET /sim2real/notices. */
    notices?: unknown[];
    /** Controls whether POST /sim2real/feedback succeeds. */
    feedbackFails?: boolean;
    /** Payload served by GET /sim2real/feedback/summary. */
    feedbackSummary?: unknown;
    /** Seeded rdk-duck-lab-workspace-context payload (G13 pre-selection). */
    workspaceContext?: Record<string, unknown>;
    /** Override the document URL so hash deep links (#train/configure) can be tested. */
    url?: string;
    /** Mutable session fixture for same-browser account changes. */
    accountId?: string;
    sessionAuthenticated?: boolean;
    replayGate?: Promise<void>;
    overviewUnauthorized?: boolean;
    visualAssetBase?: unknown;
    productId?: string;
    authRequired?: boolean;
  } = {},
) {
  const dom = new JSDOM(html, {
    url: options.url || 'http://127.0.0.1:3000/sim2real/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  openWindows.push(dom.window);
  const { window } = dom;
  if (options.productId) window.localStorage.setItem('rdk-duck-lab-product', options.productId);
  if (options.workspaceContext) {
    window.localStorage.setItem(
      'rdk-duck-lab-workspace-context',
      JSON.stringify(options.workspaceContext),
    );
  }
  const errors: string[] = [];
  const requests: Array<{ url: string; method: string; body: unknown }> = [];
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
  Object.assign(window, {
    fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = String(init?.method || 'GET').toUpperCase();
      let body: unknown = undefined;
      if (typeof init?.body === 'string') {
        try {
          body = JSON.parse(init.body);
        } catch {
          body = init.body;
        }
      }
      requests.push({ url, method, body });
      let payload: unknown;
      if (url.includes('/overview') && (options.overviewUnauthorized || options.authRequired))
        return new Response(
          JSON.stringify({ ok: false, error: 'SIM2REAL_AUTH_REQUIRED', message: '请先登录' }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        );
      if (url.includes('/overview') && options.failOverview) {
        return new Response(
          JSON.stringify({
            ok: false,
            error: 'SIM2REAL_GATEWAY_DOWN',
            message: 'gateway unavailable',
          }),
          {
            status: 503,
            headers: { 'content-type': 'application/json' },
          },
        );
      }
      if (url.includes('/overview')) {
        payload = {
          ...overview(options.runs, {
            artifacts: options.artifacts,
            evaluations: options.evaluations,
            deployments: options.overviewDeployments,
            visualAssetBase: options.visualAssetBase,
          }),
          identity: options.accountId
            ? { accountId: options.accountId, displayName: options.accountId }
            : null,
        };
      } else if (url.includes('/auth/session'))
        payload = {
          ok: true,
          ...(options.accountId || options.sessionAuthenticated !== undefined
            ? {
                authenticated: options.sessionAuthenticated ?? Boolean(options.accountId),
                accountId: options.accountId,
              }
            : {}),
        };
      else if (url.endsWith('/sso/logout')) {
        options.accountId = undefined;
        options.sessionAuthenticated = false;
        payload = { ok: true };
      } else if (url.includes('/workspace-summary')) {
        payload = { ok: true, counts: { models: 1, runs: 1, deployments: 0, devices: 0 } };
      } else if (url.includes('/lineage?')) {
        payload = {
          ok: true,
          lineage: {
            project: null,
            datasets: [{ id: 'dataset-1', name: 'walk traces', version: 'v3' }],
            run: { id: 'real-run-1', status: 'completed' },
            runs: [{ id: 'real-run-1', status: 'completed' }],
            artifacts: [
              {
                id: 'artifact-1',
                artifactId: 'walk-policy',
                name: 'Walk policy',
                status: 'published',
              },
            ],
            evaluations: [{ id: 'evaluation-1', status: 'passed', attested: true }],
            deployments: [],
          },
        };
      } else if (url.endsWith('/projects') && method === 'POST')
        payload = { ok: true, project: options.createdProject || project() };
      else if (url.endsWith('/projects')) payload = { ok: true, projects: options.projects || [] };
      else if (url.endsWith('/datasets')) payload = { ok: true, datasets: [] };
      else if (url.includes('/models/model-1')) {
        payload = { ok: true, model: model(options.visualAssetBase), compatibility: [] };
      } else if (url.includes('/replay') && options.replayFrames) {
        const frames = options.replayFrames;
        if (options.replayGate) await options.replayGate;
        payload = {
          ok: true,
          frames,
          replay: { sampleCount: frames.length },
        };
      } else if (url.includes('/sim2real/notices')) {
        payload = { ok: true, notices: options.notices || [] };
      } else if (url.includes('/sim2real/feedback/summary')) {
        payload = {
          ok: true,
          summary:
            options.feedbackSummary !== undefined
              ? options.feedbackSummary
              : {
                  total: 3,
                  accurate: 2,
                  inaccurate: 1,
                  windowDays: 30,
                  bySurface: [
                    { surface: 'retraining-advice', total: 2, accurate: 2 },
                    { surface: 'agent-reply', total: 1, accurate: 0 },
                  ],
                },
        };
      } else if (url.includes('/sim2real/feedback') && method === 'POST') {
        if (options.feedbackFails) {
          return new Response(
            JSON.stringify({ ok: false, error: 'SIM2REAL_STORAGE_WRITER_CONFLICT' }),
            { status: 503, headers: { 'content-type': 'application/json' } },
          );
        }
        payload = {
          ok: true,
          feedback: {
            id: 'feedback-1',
            surface: (body as { surface?: string })?.surface || 'run-record',
            verdict: (body as { verdict?: string })?.verdict || 'accurate',
            createdAt: new Date().toISOString(),
          },
        };
      } else payload = { ok: true };
      return new Response(JSON.stringify(payload), {
        status: 200,
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
  window.eval(componentSource);
  window.eval(firstUseSource);
  window.eval(appSource + '\nwindow.__workbenchState = state;');

  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (window.document.querySelector('#main-content')?.getAttribute('aria-busy') === 'false')
      break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return { window, errors, requests };
}

describe('Sim2Real workbench DOM behavior', () => {
  function mountPrivateRecording(window: InstanceType<typeof JSDOM>['window']) {
    const select = window.document.querySelector<HTMLSelectElement>('#task-select')!;
    select.value = 'balance-stilts';
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
    const iframe = window.document.querySelector<HTMLIFrameElement>('#simulator-frame')!,
      source = iframe.contentWindow!;
    const sample = {
      t: 0.02,
      taskId: 'balance-stilts',
      observation: Array(61).fill(0),
      action: Array(14).fill(0),
      qpos: [1],
      qvel: [0],
      replay: { taskId: 'balance-stilts', qpos: [1], qvel: [0] },
    };
    const data = {
      type: 'rdk-task-recording-ready',
      format: 'rdk-task-trajectory-v1',
      taskId: 'balance-stilts',
      text: [
        {
          type: 'header',
          format: 'rdk-task-trajectory-v1',
          taskId: 'balance-stilts',
          contractId: 'microduck-policy-v1',
        },
        sample,
      ]
        .map((row) => JSON.stringify(row))
        .join('\n'),
    };
    const stop = vi.fn();
    Object.assign(source, {
      __rdkTaskRecorder: { recording: true, stop, getText: () => data.text },
    });
    window.dispatchEvent(
      new window.MessageEvent('message', {
        data,
        source: source as never,
        origin: window.location.origin,
      }),
    );
    return { iframe, source, data, sample, stop };
  }

  it('clears account A simulation evidence and replaces frames before account B can use the workspace', async () => {
    const fixture = {
      accountId: 'account-a',
      projects: [project({ id: 'project-a', name: 'Private A project' })],
      workspaceContext: {
        projectId: 'project-a',
        deviceId: 'private-device-a',
        trainingProfile: 'high-vram',
      },
    };
    const { window, errors } = await boot(fixture);
    const previous = mountPrivateRecording(window);
    window.document
      .querySelector<HTMLButtonElement>('.sidebar [data-view-target="evaluate"]')
      ?.click();
    const oldReplay = window.document.querySelector<HTMLIFrameElement>('#replay-scene-frame')!,
      replaySource = oldReplay.contentWindow;
    expect(window.document.querySelector('#replay-frame-detail')?.textContent).toContain('61D');
    fixture.accountId = 'account-b';
    fixture.projects = [];
    window.document.querySelector<HTMLButtonElement>('#refresh-button')?.click();
    await vi.waitFor(() =>
      expect(window.document.querySelector('#account-menu-name')?.textContent).toBe('account-b'),
    );
    expect(previous.iframe.isConnected).toBe(false);
    expect(oldReplay.isConnected).toBe(false);
    expect(previous.stop).toHaveBeenCalledWith({ notify: false });
    expect(window.eval('currentTelemetry()')).toBeNull();
    expect(window.document.querySelector('option[value="local-recording"]')).toBeNull();
    expect(window.document.querySelector('#replay-frame-detail')?.textContent).not.toContain('61D');
    const stored = JSON.parse(
      window.localStorage.getItem('rdk-duck-lab-workspace-context') || '{}',
    );
    expect(stored.projectId).toBe('');
    expect(stored.deviceId).toBe('');
    expect(stored.trainingProfile).toBe('high-vram');
    for (const source of [previous.source, replaySource])
      window.dispatchEvent(
        new window.MessageEvent('message', {
          source: source as never,
          origin: window.location.origin,
          data: previous.data,
        }),
      );
    window.dispatchEvent(
      new window.MessageEvent('message', {
        source: previous.source as never,
        origin: window.location.origin,
        data: { type: 'rdk-simulator-task-state', taskId: 'balance-stilts', phase: 'ready' },
      }),
    );
    expect(window.document.querySelector('option[value="local-recording"]')).toBeNull();
    expect(
      window.document.querySelector('#simulator-live-label')?.classList.contains('is-ready'),
    ).toBe(false);
    expect(errors).toEqual([]);
  });

  it('logout immediately stops recording and policy and ignores a late acknowledgement from the former owner', async () => {
    const { window, errors } = await boot({ accountId: 'account-a' });
    const main = window.document.querySelector<HTMLIFrameElement>('#simulator-frame')!,
      source = main.contentWindow!,
      messages = vi.spyOn(source, 'postMessage');
    window.document.querySelector<HTMLButtonElement>('#policy-trial-button')?.click();
    const trial = messages.mock.calls.find(([message]) => message.type === 'rdk-policy-run')?.[0];
    expect(trial).toBeTruthy();
    const previous = mountPrivateRecording(window);
    window.document.querySelector<HTMLButtonElement>('#account-pill-logout')?.click();
    expect(previous.iframe.isConnected).toBe(false);
    expect(previous.stop).toHaveBeenCalledWith({ notify: false });
    window.dispatchEvent(
      new window.MessageEvent('message', {
        source: source as never,
        origin: window.location.origin,
        data: {
          type: 'rdk-policy-status',
          trialId: trial.trialId,
          taskId: trial.taskId,
          phase: 'running',
          message: 'OLD ACCOUNT POLICY',
        },
      }),
    );
    await vi.waitFor(() =>
      expect(window.document.querySelector('#account-menu-wrap')?.hasAttribute('hidden')).toBe(
        true,
      ),
    );
    expect(window.document.querySelector('#policy-trial-status')?.textContent).not.toContain(
      'OLD ACCOUNT POLICY',
    );
    expect(window.eval('currentTelemetry()')).toBeNull();
    expect(window.document.querySelector('option[value="local-recording"]')).toBeNull();
    expect(errors).toEqual([]);
  });

  it('retains anonymous local recordings during ordinary refresh but never mounts a former account replay response', async () => {
    const anonymous = await boot({ sessionAuthenticated: false });
    mountPrivateRecording(anonymous.window);
    anonymous.window.document.querySelector<HTMLButtonElement>('#refresh-button')?.click();
    await vi.waitFor(() =>
      expect(
        anonymous.window.document.querySelector('#main-content')?.getAttribute('aria-busy'),
      ).toBe('false'),
    );
    expect(
      anonymous.window.document.querySelector('option[value="local-recording"]'),
    ).not.toBeNull();
    let complete: () => void = () => {};
    const fixture = {
      accountId: 'account-a',
      replayFrames: [
        {
          t: 0,
          observation: Array(61).fill(0),
          action: Array(14).fill(0),
          taskId: 'balance-stilts',
          replay: { taskId: 'balance-stilts', qpos: [1], qvel: [0] },
        },
      ],
      replayGate: new Promise<void>((resolve) => {
        complete = resolve;
      }),
    };
    const { window } = await boot(fixture);
    window.document.querySelector<HTMLButtonElement>('#replay-load-button')?.click();
    await new Promise((resolve) => setTimeout(resolve, 10));
    fixture.accountId = 'account-b';
    window.document.querySelector<HTMLButtonElement>('#refresh-button')?.click();
    await vi.waitFor(() =>
      expect(window.document.querySelector('#account-menu-name')?.textContent).toBe('account-b'),
    );
    complete();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(window.document.querySelector('#replay-frame-label')?.textContent).toBe('0 / 0 帧');
    expect(window.document.querySelector('#replay-scene-frame')?.getAttribute('src')).toBeNull();
  });

  it.each(['session-switch', 'session-expiry', 'overview-401'])(
    'clears previously owned simulation data on %s',
    async (change) => {
      const fixture = {
        accountId: 'account-a',
        sessionAuthenticated: true,
        overviewUnauthorized: false,
      };
      const { window, errors } = await boot(fixture);
      const previous = mountPrivateRecording(window);
      if (change === 'session-switch') fixture.accountId = 'account-b';
      if (change === 'session-expiry') fixture.sessionAuthenticated = false;
      if (change === 'overview-401') {
        fixture.overviewUnauthorized = true;
        window.document.querySelector<HTMLButtonElement>('#refresh-button')?.click();
      } else await window.eval('refreshSessionMenu()');
      await vi.waitFor(() => expect(previous.iframe.isConnected).toBe(false));
      expect(window.eval('currentTelemetry()')).toBeNull();
      expect(window.document.querySelector('option[value="local-recording"]')).toBeNull();
      expect(previous.stop).toHaveBeenCalledWith({ notify: false });
      expect(errors).toEqual([]);
    },
  );
  it('shows the actual MicroDuck installation path when public guest health reports missing resources', async () => {
    const { window } = await boot({ authRequired: true });
    window.eval(
      '__workbenchState.publicHealth={microduck:{state:"missing"}}; renderIntegrations(); renderNextAction();',
    );
    expect(
      window.document.querySelector('#next-action-button')?.getAttribute('data-start-action'),
    ).toBe('simulator-help');
    window.document.querySelector<HTMLButtonElement>('#next-action-button')?.click();
    await vi.waitFor(() => expect(window.document.body.dataset.activeView).toBe('simulate'));
    expect(window.document.querySelector('#simulator-gate-title')?.textContent).toContain(
      'MicroDuck',
    );
    expect(
      window.document.querySelector<HTMLAnchorElement>('#simulator-gate-install')?.hidden,
    ).toBe(false);
    expect(window.document.querySelector('#simulator-gate-install')?.getAttribute('href')).toBe(
      '/sim2real/mujoco/microduck/',
    );
  });
  it('requires a user model instead of treating the builtin reference as an import', async () => {
    const { window } = await boot();
    window.document.querySelector<HTMLButtonElement>('#start-intent-model')?.click();
    expect(window.document.querySelector('#onboard-count')?.textContent).toBe('0 / 4');
    expect(
      window.document.querySelector('#next-action-button')?.getAttribute('data-start-action'),
    ).toBe('model-import');
    window.document.querySelector<HTMLButtonElement>('#next-action-button')?.click();
    await vi.waitFor(() => expect(window.document.body.dataset.flowChild).toBe('prepare'));
    expect(window.document.querySelector<HTMLDetailsElement>('#contract-fold')?.open).toBe(true);
    expect(
      window.document.querySelector('#train-tab-contract')?.getAttribute('aria-selected'),
    ).toBe('true');
  });
  it('explains the example switch for a custom robot and keeps advanced evidence folded', async () => {
    const { window, requests, errors } = await boot({ productId: 'custom' });
    expect(window.document.querySelector('#next-action-copy')?.textContent).toContain(
      '切换到 MicroDuck',
    );
    expect(
      window.document.querySelector<HTMLDetailsElement>('#overview-advanced-evidence')?.open,
    ).toBe(false);
    window.document.querySelector<HTMLButtonElement>('#next-action-button')?.click();
    await vi.waitFor(() =>
      expect(window.document.querySelector<HTMLSelectElement>('#product-select')?.value).toBe(
        'microduck',
      ),
    );
    await vi.waitFor(() => expect(window.document.body.dataset.activeView).toBe('simulate'));
    expect(requests.filter((entry) => entry.method === 'POST')).toHaveLength(0);
    expect(errors).toEqual([]);
  });

  it('changes the goal without changing the selected robot or executing device/model actions', async () => {
    const { window, requests } = await boot({ productId: 'custom' });
    window.document.querySelector<HTMLButtonElement>('#start-intent-device')?.click();
    expect(
      window.document.querySelector('#start-intent-device')?.getAttribute('aria-pressed'),
    ).toBe('true');
    expect(window.document.querySelector('#onboard-list')?.textContent).not.toContain('MicroDuck');
    window.document.querySelector<HTMLButtonElement>('#next-action-button')?.click();
    await vi.waitFor(() => expect(window.document.body.dataset.activeView).toBe('station'));
    window.document.querySelector<HTMLButtonElement>('#start-intent-model')?.click();
    window.document.querySelector<HTMLButtonElement>('#next-action-button')?.click();
    await vi.waitFor(() => expect(window.document.body.dataset.flowChild).toBe('prepare'));
    expect(window.document.querySelector<HTMLSelectElement>('#product-select')?.value).toBe(
      'custom',
    );
    expect(window.document.querySelector<HTMLDetailsElement>('#contract-fold')?.open).toBe(true);
    expect(requests.filter((entry) => entry.method === 'POST')).toHaveLength(0);
  });

  it('allows guest experience while sign-in remains the next step for private device data', async () => {
    const { window, requests } = await boot({ authRequired: true });
    expect(
      window.document.querySelector('#next-action-button')?.getAttribute('data-start-action'),
    ).toBe('begin-experience');
    window.document.querySelector<HTMLButtonElement>('#start-intent-device')?.click();
    expect(
      window.document.querySelector('#next-action-button')?.getAttribute('data-start-action'),
    ).toBe('login');
    window.document.querySelector<HTMLButtonElement>('#next-action-button')?.click();
    await vi.waitFor(() =>
      expect(window.document.querySelector<HTMLElement>('#auth-gate-panel')?.hidden).toBe(false),
    );
    expect(requests.filter((entry) => entry.method === 'POST')).toHaveLength(0);
  });

  it('completes experience only after the actual browser recording is played through, with no upload', async () => {
    const { window, requests, errors } = await boot();
    const player = window.document.querySelector('#replay-player')!;
    const originalParent = player.parentNode;
    const originalNext = player.nextSibling;
    const button = window.document.querySelector<HTMLButtonElement>('#next-action-button')!;
    const dialog = window.document.querySelector<HTMLDialogElement>('#experience-review-dialog')!;
    const recording = [0, 0.02, 0.04]
      .map((time) => JSON.stringify({ time, observation: [time, 1], action: [time], reward: time }))
      .join('\n');
    const recordMessage = () =>
      window.dispatchEvent(
        new window.MessageEvent('message', {
          origin: window.location.origin,
          source: window.document.querySelector<HTMLIFrameElement>('#simulator-frame')!
            .contentWindow as never,
          data: {
            type: 'rdk-microduck-recording-ready',
            format: 'microduck-trajectory-v1',
            text: recording,
            sampleCount: 3,
          },
        }),
      );
    recordMessage();
    expect(
      window.document.querySelector('#next-action-button')?.getAttribute('data-start-action'),
    ).toBe('replay-experience');
    expect(window.document.querySelector('#onboard-count')?.textContent).toBe('2 / 4');
    button.focus();
    button.click();
    await vi.waitFor(() => expect(dialog.open).toBe(true));
    expect(window.document.body.dataset.activeView).toBe('overview');
    expect(dialog.querySelector('#replay-player')).toBe(player);
    expect(player.closest('.view-section')).toBeNull();
    expect(window.document.querySelectorAll('#replay-player')).toHaveLength(1);
    expect(window.document.activeElement?.id).toBe('replay-play-button');
    expect(window.document.querySelector<HTMLInputElement>('#replay-seek')?.disabled).toBe(false);
    const seek = window.document.querySelector<HTMLInputElement>('#replay-seek')!;
    expect(seek.max).toBe('2');
    seek.value = seek.max;
    seek.dispatchEvent(new window.Event('input', { bubbles: true }));
    expect(window.document.querySelector('#onboard-count')?.textContent).toBe('2 / 4');
    window.document.querySelector<HTMLButtonElement>('#replay-play-button')?.click();
    await vi.waitFor(() =>
      expect(window.document.querySelector('#onboard-count')?.textContent).toBe('4 / 4'),
    );
    expect(window.document.querySelector('#next-action-title')?.textContent).toContain('已完成');
    expect(requests.filter((entry) => entry.method === 'POST')).toHaveLength(0);
    window.document.querySelector<HTMLButtonElement>('#experience-review-close')?.click();
    expect(dialog.open).toBe(false);
    expect(player.parentNode).toBe(originalParent);
    expect(player.nextSibling).toBe(originalNext);
    expect(window.document.activeElement).toBe(button);
    expect(window.document.querySelector<HTMLElement>('#policy-trial-controls')?.hidden).toBe(
      false,
    );
    button.click();
    await vi.waitFor(() => expect(dialog.open).toBe(true));
    expect(dialog.querySelector('#replay-player')).toBe(player);
    dialog.dispatchEvent(new window.Event('cancel', { cancelable: true }));
    expect(dialog.open).toBe(false);
    expect(player.parentNode).toBe(originalParent);
    expect(window.document.activeElement).toBe(button);
    recordMessage();
    expect(window.document.querySelector('#onboard-count')?.textContent).toBe('2 / 4');
    expect(errors).toEqual([]);
  });

  it('stops unfinished local playback on Escape and restores the original player without completing experience', async () => {
    const { window, requests, errors } = await boot();
    const player = window.document.querySelector('#replay-player')!;
    const originalParent = player.parentNode;
    const originalNext = player.nextSibling;
    const button = window.document.querySelector<HTMLButtonElement>('#next-action-button')!;
    const dialog = window.document.querySelector<HTMLDialogElement>('#experience-review-dialog')!;
    const recording = Array.from({ length: 12 }, (_, index) =>
      JSON.stringify({ time: index * 0.02, observation: [index], action: [index], reward: 0 }),
    ).join('\n');
    window.dispatchEvent(
      new window.MessageEvent('message', {
        origin: window.location.origin,
        source: window.document.querySelector<HTMLIFrameElement>('#simulator-frame')!
          .contentWindow as never,
        data: {
          type: 'rdk-microduck-recording-ready',
          format: 'microduck-trajectory-v1',
          text: recording,
          sampleCount: 12,
        },
      }),
    );
    button.click();
    await vi.waitFor(() => expect(dialog.open).toBe(true));
    window.document.querySelector<HTMLButtonElement>('#replay-play-button')?.click();
    expect(window.eval('__workbenchState.replay.timer')).not.toBeNull();
    dialog.dispatchEvent(new window.Event('cancel', { cancelable: true }));
    expect(dialog.open).toBe(false);
    expect(window.eval('__workbenchState.replay.timer')).toBeNull();
    expect(player.parentNode).toBe(originalParent);
    expect(player.nextSibling).toBe(originalNext);
    expect(window.document.activeElement).toBe(button);
    await new Promise((resolve) => setTimeout(resolve, 260));
    expect(window.document.querySelector('#onboard-count')?.textContent).toBe('2 / 4');
    expect(requests.filter((entry) => entry.method === 'POST')).toHaveLength(0);
    expect(errors).toEqual([]);
  });

  it('closes an open recording review and releases its private evidence when the account changes', async () => {
    const fixture = { accountId: 'account-a' };
    const { window, errors } = await boot(fixture);
    const player = window.document.querySelector('#replay-player')!;
    const originalParent = player.parentNode;
    const source =
      window.document.querySelector<HTMLIFrameElement>('#simulator-frame')!.contentWindow!;
    window.dispatchEvent(
      new window.MessageEvent('message', {
        origin: window.location.origin,
        source: source as never,
        data: {
          type: 'rdk-microduck-recording-ready',
          format: 'microduck-trajectory-v1',
          text: [0, 0.02, 0.04]
            .map((time) => JSON.stringify({ time, observation: [time], action: [time] }))
            .join('\n'),
        },
      }),
    );
    window.document.querySelector<HTMLButtonElement>('#next-action-button')?.click();
    const dialog = window.document.querySelector<HTMLDialogElement>('#experience-review-dialog')!;
    await vi.waitFor(() => expect(dialog.open).toBe(true));
    fixture.accountId = 'account-b';
    await window.eval('loadOverview({ quiet: true })');
    expect(dialog.open).toBe(false);
    expect(player.parentNode).toBe(originalParent);
    expect(window.eval('__workbenchState.reviewedRecording')).toBeNull();
    expect(window.eval('currentTelemetry()')).toBeNull();
    expect(window.eval('__workbenchState.replay.frames.length')).toBe(0);
    expect(errors).toEqual([]);
  });

  it('does not apply another device preflight or compatibility to the selected device', async () => {
    const { window } = await boot();
    window.eval(
      '__workbenchState.startIntent="device"; __workbenchState.overview.devices=[{id:"board-b",status:"connected",boardPlatform:"rdk-s100"}]; __workbenchState.selectedDeviceId="board-b"; __workbenchState.overview.deployments=[{id:"preflight-a",modelId:"model-1",deviceId:"board-a",status:"ready"}]; __workbenchState.compatibility=[{platformId:"rdk-x5",deployable:true}]; renderNextAction(); renderOnboardChecklist();',
    );
    expect(
      window.document.querySelector('#next-action-button')?.getAttribute('data-start-action'),
    ).toBe('model-check');
    expect(
      window.document
        .querySelector('[data-onboard-step="deploy"]')
        ?.classList.contains('is-complete'),
    ).toBe(false);
    expect(
      window.document
        .querySelector('[data-onboard-step="evaluate"]')
        ?.classList.contains('is-complete'),
    ).toBe(false);
  });

  it('keeps auxiliary project state and summary during a silent refresh', async () => {
    const { window } = await boot({ projects: [project()] });
    const before = window.eval('__workbenchState.workspaceSummary');
    expect(before).toBeTruthy();
    await window.eval('loadOverview({ silent: true })');
    expect(window.eval('__workbenchState.workspaceSummary')).toBe(before);
    expect(window.eval('__workbenchState.projectsLoadError')).toBe(false);
    expect(window.document.querySelector('#project-context-note')?.textContent).not.toContain(
      '暂不可用',
    );
  });

  it('keeps the GPU form locked until one submission settles', async () => {
    const { window } = await boot();
    const originalFetch = window.fetch;
    let release!: (response: Response) => void;
    let saves = 0;
    window.fetch = vi.fn((input, init) => {
      if (String(input).endsWith('/compute-resources') && init?.method === 'POST') {
        saves += 1;
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      }
      return originalFetch(input, init);
    });
    const form = window.document.querySelector<HTMLFormElement>('#compute-resource-form')!;
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    expect(saves).toBe(1);
    expect(form.getAttribute('aria-busy')).toBe('true');
    expect(
      window.document.querySelector<HTMLButtonElement>('#compute-resource-save')?.disabled,
    ).toBe(true);
    expect(
      window.document.querySelector<HTMLInputElement>('#compute-resource-name')?.disabled,
    ).toBe(true);
    release(
      new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json' },
      }),
    );
    await vi.waitFor(() => expect(form.getAttribute('aria-busy')).toBe('false'));
    expect(
      window.document.querySelector<HTMLButtonElement>('#compute-resource-save')?.textContent,
    ).toBe('添加 GPU');
    expect(
      window.document.querySelector<HTMLInputElement>('#compute-resource-name')?.disabled,
    ).toBe(false);
  });

  it('shows an error with retry instead of an empty GPU collection after a failed load', async () => {
    const { window } = await boot({ failOverview: true });
    const list = window.document.querySelector('#compute-resource-list')!;
    expect(list.querySelector('.ui-state-error')).toBeTruthy();
    expect(list.textContent).not.toContain('还没有接入 GPU');
    expect(list.querySelector('button')?.textContent).toContain('重新连接');
  });

  it('makes the narrow sidebar modal and restores focus after backdrop dismissal', async () => {
    const { window } = await boot();
    Object.assign(window, { matchMedia: () => ({ matches: true }) });
    const toggle = window.document.querySelector<HTMLButtonElement>('#sidebar-toggle')!;
    toggle.click();
    expect(window.document.querySelector('#main-content')?.hasAttribute('inert')).toBe(true);
    expect(window.document.querySelector('#platform-sidebar')?.getAttribute('aria-modal')).toBe(
      'true',
    );
    window.document.querySelector<HTMLElement>('#sidebar-backdrop')?.click();
    expect(window.document.activeElement).toBe(toggle);
    expect(window.document.querySelector('#main-content')?.hasAttribute('inert')).toBe(false);
  });

  it('keeps GPU action focus when background data has not changed', async () => {
    const { window } = await boot();
    window.eval(
      '__workbenchState.overview.computeResources = [{ id: "gpu-1", name: "GPU", status: "online" }]; renderComputeResources();',
    );
    const edit = window.document.querySelector<HTMLButtonElement>('[data-resource-action="edit"]')!;
    edit.focus();
    window.eval('renderComputeResources()');
    expect(window.document.activeElement).toBe(edit);
    expect(edit.isConnected).toBe(true);
  });

  it('preserves the focused GPU action while checking and after the request settles', async () => {
    const { window } = await boot();
    const resource = { id: 'gpu-1', name: 'GPU', status: 'online' };
    window.eval(
      `__workbenchState.overview.computeResources = ${JSON.stringify([resource])}; renderComputeResources();`,
    );
    const originalFetch = window.fetch;
    let release!: (response: Response) => void;
    window.fetch = vi.fn(async (input, init) => {
      if (String(input).endsWith('/compute-resources/gpu-1/test')) {
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      }
      const response = await originalFetch(input, init);
      if (String(input).includes('/overview')) {
        const payload = await response.json();
        payload.computeResources = [resource];
        return new Response(JSON.stringify(payload), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return response;
    });
    const check = window.document.querySelector<HTMLButtonElement>(
      '[data-resource-action="test"]',
    )!;
    check.focus();
    check.click();
    expect(window.document.activeElement).toBe(check);
    expect(check.getAttribute('aria-disabled')).toBe('true');
    release(
      new Response(JSON.stringify({ connected: true }), {
        headers: { 'content-type': 'application/json' },
      }),
    );
    await vi.waitFor(() => expect(check.getAttribute('aria-disabled')).toBe('false'));
    expect(window.document.activeElement).toBe(check);
  });

  it('queues a fresh foreground load after a pending background snapshot', async () => {
    const { window } = await boot();
    const originalFetch = window.fetch;
    let release!: (response: Response) => void;
    let loads = 0;
    const resource = { id: 'gpu-new', name: '新 GPU', status: 'online' };
    window.fetch = vi.fn(async (input, init) => {
      if (String(input).includes('/overview')) {
        loads += 1;
        if (loads === 1)
          return new Promise<Response>((resolve) => {
            release = resolve;
          });
        const payload = await (await originalFetch(input, init)).json();
        payload.computeResources = [resource];
        return new Response(JSON.stringify(payload), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return originalFetch(input, init);
    });
    const background = window.eval('loadOverview({ silent: true })');
    const foreground = window.eval('loadOverview({ quiet: true })');
    expect(loads).toBe(1);
    release(
      new Response(JSON.stringify(overview()), { headers: { 'content-type': 'application/json' } }),
    );
    await Promise.all([background, foreground]);
    expect(loads).toBe(2);
    expect(window.document.querySelector('#compute-resource-list')?.textContent).toContain(
      '新 GPU',
    );
  });

  it('keeps the account menu open through a data render and skips hidden top-menu items', async () => {
    const { window } = await boot();
    window.eval(
      '__workbenchState.overview.identity = { displayName: "用户", accountId: "user-1" }; renderIntegrations();',
    );
    window.document.querySelector<HTMLButtonElement>('#account-avatar')?.click();
    const logout = window.document.querySelector<HTMLButtonElement>('#account-pill-logout')!;
    logout.focus();
    window.eval('renderIntegrations()');
    expect(window.document.querySelector<HTMLElement>('#account-menu')?.hidden).toBe(false);
    expect(window.document.activeElement).toBe(logout);
    const trigger = window.document.querySelector<HTMLButtonElement>('#top-menu-button')!;
    trigger.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(window.document.activeElement?.id).toBe('refresh-button');
    window.document.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    expect(window.document.activeElement).toBe(trigger);
  });

  it('boots the real app bundle and changes one visible workspace view at a time', async () => {
    const { window, errors } = await boot();
    // Scoped to the scorecard grid: the research-loop panel reuses the same
    // item class and renders its own (asynchronous) card count.
    expect(
      window.document.querySelectorAll('#platform-scorecard-grid .platform-score-item'),
    ).toHaveLength(5);
    expect(window.document.querySelector('#platform-score-total')?.textContent).toMatch(
      /^\d+\.\d$/,
    );
    const trainButton = window.document.querySelector<HTMLButtonElement>(
      '.sidebar [data-view-target="train"]',
    );
    trainButton?.click();

    expect(window.document.body.dataset.activeView).toBe('train');
    // Grouped IA (2026-09): sidebar sub-entries are alternate entry points and
    // intentionally carry no aria-current; this click switches the view but
    // does NOT (yet) drive setFlowChild/openTrainStep — the train-step
    // activation gap is tracked separately for the navigation refactor.
    expect(
      window.document.querySelector<HTMLElement>('[data-view-section="overview"]')?.hidden,
    ).toBe(true);
    expect(window.document.querySelector<HTMLElement>('[data-view-section="train"]')?.hidden).toBe(
      false,
    );
    expect(
      window.document.querySelector<HTMLElement>('[data-view-section="overview"]')?.hidden,
    ).toBe(true);
    expect(errors).toEqual([]);
  });

  it('shows the nearest aligned camera frame and says when it is not the sampled one', async () => {
    // The board spools frames sparsely (one every RDK_SIM2REAL_FRAME_STRIDE
    // samples), so most replay positions have no frame of their own. The player
    // must still show a picture, and must say which frame it is showing: a
    // nearby image presented as the current sample would be a quiet factual
    // error about what the policy actually observed.
    const cameraFrame = {
      encoding: 'rgb8',
      width: 2,
      height: 2,
      channels: 3,
      // 12 bytes: four RGB pixels.
      data: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]).toString('base64'),
    };
    const frames = [
      { t: 0.1, observation: [1], cameraFrame },
      { t: 0.2, observation: [2] },
      { t: 0.3, observation: [3] },
      { t: 0.8, observation: [4], cameraFrame },
      { t: 0.9, observation: [5] },
    ];
    const { window, errors } = await boot({ replayFrames: frames });

    const drawn: Uint8ClampedArray[] = [];
    Object.defineProperty(window.HTMLCanvasElement.prototype, 'getContext', {
      configurable: true,
      value() {
        return {
          createImageData: (width: number, height: number) => ({
            width,
            height,
            data: new Uint8ClampedArray(width * height * 4),
          }),
          putImageData: (image: { data: Uint8ClampedArray }) => drawn.push(image.data),
          clearRect: () => undefined,
        };
      },
    });

    window.document.querySelector<HTMLButtonElement>('#replay-load-button')?.click();
    await new Promise((resolve) => setTimeout(resolve, 30));

    const figure = window.document.querySelector<HTMLElement>('#replay-camera');
    const note = window.document.querySelector<HTMLElement>('#replay-camera-note');
    // Index 0 is itself a framed sample: it must read as the sample's own frame.
    expect(figure?.hidden).toBe(false);
    expect(note?.textContent).toContain('本采样点');
    expect(note?.textContent).toContain('2×2');
    expect(drawn.length).toBeGreaterThan(0);
    // The decoder must map the flat RGB payload onto RGBA, not copy it verbatim.
    const firstDraw = drawn[drawn.length - 1];
    expect(Array.from(firstDraw.slice(0, 4))).toEqual([1, 2, 3, 255]);
    expect(Array.from(firstDraw.slice(4, 8))).toEqual([4, 5, 6, 255]);

    // Index 2 has no frame; index 0 is nearer (2 back) than index 3 (1 forward),
    // so the forward one wins and the note must not claim it is the sample.
    const seek = window.document.querySelector<HTMLInputElement>('#replay-seek');
    if (seek) {
      seek.value = '2';
      seek.dispatchEvent(new window.Event('input', { bubbles: true }));
    }
    expect(note?.textContent).toContain('最近帧');
    expect(note?.textContent).toContain('非本采样点');
    expect(note?.textContent).toContain('t=0.80s');
    expect(note?.textContent).toContain('0.50s');
    expect(errors).toEqual([]);

    // Index 1 is one step from either side, and the at-or-before frame wins the
    // tie so scrubbing backwards stays stable.
    if (seek) {
      seek.value = '1';
      seek.dispatchEvent(new window.Event('input', { bubbles: true }));
    }
    expect(note?.textContent).toContain('t=0.10s');
    expect(errors).toEqual([]);
  });

  it('stays neutral for a run whose samples carry no camera frame at all', async () => {
    // Every vector-only run looks like this, so it is the common case. It must
    // not show an empty canvas, which could be read as a real observation.
    const { window, errors } = await boot({
      replayFrames: [
        { t: 0.1, observation: [1] },
        { t: 0.2, observation: [2] },
      ],
    });

    window.document.querySelector<HTMLButtonElement>('#replay-load-button')?.click();
    await new Promise((resolve) => setTimeout(resolve, 30));

    const figure = window.document.querySelector<HTMLElement>('#replay-camera');
    const note = window.document.querySelector<HTMLElement>('#replay-camera-note');
    expect(figure?.hidden).toBe(true);
    expect(note?.textContent).toContain('没有对齐的相机帧');
    expect(errors).toEqual([]);
  });

  it('keeps product-specific contract guidance aligned with the selected product line', async () => {
    const { window, errors } = await boot();
    const templateButton = window.document.querySelector<HTMLButtonElement>('#template-button');
    const contractTip = window.document.querySelector('#contract-panel-tip');
    expect(templateButton?.textContent).toContain('MicroDuck');
    expect(contractTip?.textContent).toContain('MicroDuck');

    const productSelect = window.document.querySelector<HTMLSelectElement>('#product-select');
    if (productSelect) {
      productSelect.value = 'originbot';
      productSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(templateButton?.textContent).toContain('OriginBot');
    expect(contractTip?.textContent).toContain('OriginBot');
    expect(errors).toEqual([]);
  });

  it('shows OriginBot connection failures and recovery from the active scene', async () => {
    const { window, errors } = await boot();
    const doc = window.document;
    const productSelect = doc.querySelector<HTMLSelectElement>('#product-select')!;
    productSelect.value = 'originbot';
    productSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
    const frame = doc.querySelector<HTMLIFrameElement>('#simulator-frame')!;
    const notify = (phase: string) =>
      window.dispatchEvent(
        new window.MessageEvent('message', {
          origin: window.location.origin,
          source: frame.contentWindow as never,
          data: {
            type: 'rdk-simulator-task-state',
            taskId: 'goal-navigation',
            phase,
            controlHz: 20,
          },
        }),
      );
    notify('failed');
    expect(doc.getElementById('simulator-live-text')?.textContent).toBe('场景连接失败');
    expect(doc.getElementById('simulator-live-label')?.classList.contains('is-ready')).toBe(false);
    notify('ready');
    expect(doc.getElementById('simulator-live-text')?.textContent).toBe('任务场景已就绪');
    expect(doc.getElementById('simulator-live-label')?.classList.contains('is-ready')).toBe(true);
    expect(errors).toEqual([]);
  });

  it('opens and operates the command palette with the documented keyboard flow', async () => {
    const { window, errors } = await boot();
    window.document.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }),
    );
    const dialog = window.document.querySelector<HTMLDialogElement>('#command-palette');
    const input = window.document.querySelector<HTMLInputElement>('#command-palette-input');
    expect(dialog?.hasAttribute('open')).toBe(true);
    expect(input?.value).toBe('');

    if (input) {
      input.value = '评测中心';
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
      input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(window.document.body.dataset.activeView).toBe('evaluate');
    expect(dialog?.hasAttribute('open')).toBe(false);
    expect(errors).toEqual([]);
  });

  it('labels protocol-only runs and suppresses their fake performance metrics', async () => {
    const { window, errors } = await boot();
    window.document
      .querySelector<HTMLButtonElement>('.sidebar [data-view-target="evaluate"]')
      ?.click();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const quality = window.document.querySelector<HTMLElement>('#eval-run-quality');
    expect(quality?.hidden).toBe(false);
    expect(quality?.textContent).toContain('Mock 协议演示 · 非真实 RL');
    expect(window.document.querySelector('#eval-success')?.textContent).toBe('—');
    expect(window.document.querySelector('#eval-fall')?.textContent).toBe('—');
    expect(errors).toEqual([]);
  });

  it('surfaces the engine-reported physics backend on the run card, chip and detail dialog', async () => {
    const selectedModel = model();
    const { window, errors } = await boot({
      runs: [
        {
          id: 'mjx-run-1',
          modelId: selectedModel.id,
          backend: 'local',
          status: 'completed',
          summary: 'mjx smoke run',
          mock: false,
          metrics: {
            contractValid: true,
            observationSize: 61,
            actionSize: 14,
            physicsBackend: 'mjx',
            engine: 'mjx-ppo',
          },
          createdAt: '2026-09-14T00:00:00.000Z',
        },
        {
          id: 'starter-run-1',
          modelId: selectedModel.id,
          backend: 'local',
          status: 'completed',
          summary: 'starter smoke run',
          mock: false,
          metrics: {
            contractValid: true,
            observationSize: 61,
            actionSize: 14,
          },
          createdAt: '2026-09-13T00:00:00.000Z',
        },
      ],
    });
    // train view hosts the run-progress card (the chip) and the history rows
    window.document
      .querySelector<HTMLButtonElement>('.sidebar [data-view-target="train"]')
      ?.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const meta = window.document.querySelector('#run-progress-meta');
    expect(meta?.textContent).toContain('物理 · MuJoCo MJX');
    const physicsChip = meta?.querySelector('.physics-chip');
    expect(physicsChip?.textContent).toContain('物理 · MuJoCo MJX');

    // only the engine-labeled run carries a row chip; the starter run and the
    // model artifact row stay clean
    const rows = Array.from(window.document.querySelectorAll('.history-row'));
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const chips = rows.map((r) => r.querySelector('.history-physics')?.textContent || null);
    expect(chips.filter((chip) => chip != null)).toEqual(['物理 · MJX']);

    // typing the backend token filters the ledger to the engine's runs
    const search = window.document.querySelector<HTMLInputElement>('#record-search');
    search?.dispatchEvent(new window.Event('input', { bubbles: true }));
    if (search) search.value = 'mjx';
    search?.dispatchEvent(new window.Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const filtered = Array.from(window.document.querySelectorAll('.history-row'));
    expect(filtered).toHaveLength(1);
    expect(filtered[0].textContent).toContain('mjx smoke run');

    const row = filtered[0] as HTMLButtonElement;
    // the row itself tells engines apart without opening the dialog
    const rowPhysics = row.querySelector('.history-physics');
    expect(rowPhysics?.textContent).toContain('物理 · MJX');
    row.click();
    const dialog = window.document.querySelector<HTMLDialogElement>('#run-detail-dialog');
    expect(dialog?.hasAttribute('open')).toBe(true);
    const body = window.document.querySelector('#run-detail-body');
    // detail grid fields
    expect(body?.textContent).toContain('物理后端');
    expect(body?.textContent).toContain('MuJoCo MJX（接触动力学）');
    expect(body?.textContent).toContain('训练引擎');
    expect(body?.textContent).toContain('mjx-ppo');
    // first-class metric cards
    const cards = body?.querySelectorAll('.run-metric-card') || [];
    const labels = Array.from(cards).map((card) => card.querySelector('span')?.textContent);
    expect(labels).toContain('物理后端');
    expect(labels).toContain('训练引擎');
    expect(errors).toEqual([]);
  });

  it('keeps the ONNX download link under the configured /sim2real mount', async () => {
    const selectedModel = model();
    const { window, errors } = await boot({
      runs: [
        {
          id: 'real-onnx-run',
          modelId: selectedModel.id,
          backend: 'local',
          status: 'completed',
          summary: 'real ONNX run',
          mock: false,
          artifact: {
            artifactId: 'policy-onnx',
            artifactRef: 'artifact://tests/policy.onnx',
            format: 'onnx',
            sizeBytes: 12,
            sha256: 'a'.repeat(64),
          },
          createdAt: '2026-09-14T00:00:00.000Z',
        },
      ],
    });
    window.document
      .querySelector<HTMLButtonElement>('.sidebar [data-view-target="train"]')
      ?.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const row = window.document.querySelector<HTMLButtonElement>('.history-row');
    expect(row).toBeTruthy();
    row?.click();
    const link = window.document.querySelector<HTMLAnchorElement>(
      '#run-detail-body a[download="policy.onnx"]',
    );
    expect(link?.getAttribute('href')).toBe(
      '/sim2real/api/sim2real/runs/real-onnx-run/policy.onnx',
    );
    expect(errors).toEqual([]);
  });

  it('restores a flow child from a hash deep link and keeps history entries clean', async () => {
    const { window, errors } = await boot({
      url: 'http://127.0.0.1:3000/sim2real/#train/configure',
    });
    const doc = window.document;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(doc.body.dataset.activeView).toBe('train');
    expect(doc.body.dataset.flowChild).toBe('configure');
    expect(doc.getElementById('flow-context')?.hidden).toBe(false);
    expect(doc.getElementById('flow-context-title')?.textContent).toBe('训练配置');
    expect(doc.getElementById('train-module-config')?.hasAttribute('open')).toBe(true);

    doc.querySelector<HTMLButtonElement>('[data-flow-child="submit"]')?.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(window.location.hash).toBe('#train/submit');
    const trainSection = doc.querySelector('[data-view-section="train"]');
    expect(trainSection?.getAttribute('data-active-train-module')).toBe('run');
    expect(doc.getElementById('train-module-config')?.hasAttribute('open')).toBe(false);
    // Sibling children of one view must rewrite the current entry in place,
    // not stack extra history entries.
    expect(window.history.length).toBe(1);

    doc.querySelector<HTMLButtonElement>('[data-flow-child="replays"]')?.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(window.location.hash).toBe('#records/replays');
    expect(window.history.length).toBe(2);
    window.history.back();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(window.location.hash).toBe('#train/submit');
    expect(doc.body.dataset.activeView).toBe('train');
    expect(doc.body.dataset.flowChild).toBe('submit');
    expect(errors).toEqual([]);
  });

  it('评测与部署视图按子模块显隐，页签与侧栏子项走同一条 flow-child 通道', async () => {
    const { window, errors } = await boot({
      url: 'http://127.0.0.1:3000/sim2real/#deploy/feedback',
    });
    const doc = window.document;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(doc.body.dataset.activeView).toBe('deploy');
    expect(doc.body.dataset.flowChild).toBe('feedback');
    const deploySection = doc.querySelector('[data-view-section="deploy"]');
    expect(deploySection?.getAttribute('data-active-deploy-module')).toBe('feedback');
    expect(doc.getElementById('flow-context-title')?.textContent).toBe('运行反馈与回滚');
    expect(doc.getElementById('feedback-panel')?.hasAttribute('open')).toBe(true);

    const preflightTab = doc.querySelector<HTMLButtonElement>(
      '#view-deploy [data-flow-child="preflight"], [data-view-section="deploy"] [data-flow-child="preflight"]',
    );
    preflightTab?.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(window.location.hash).toBe('#deploy/preflight');
    expect(deploySection?.getAttribute('data-active-deploy-module')).toBe('preflight');
    expect(preflightTab?.classList.contains('is-active')).toBe(true);
    expect(
      doc
        .querySelector('[data-view-section="deploy"] [data-flow-child="feedback"]')
        ?.classList.contains('is-active'),
    ).toBe(false);

    doc.querySelector('[data-flow-child="comparison"]')?.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(window.location.hash).toBe('#evaluate/comparison');
    const evaluateSection = doc.querySelector('[data-view-section="evaluate"]');
    expect(evaluateSection?.getAttribute('data-active-eval-module')).toBe('comparison');
    expect(doc.getElementById('flow-context-title')?.textContent).toBe('结果对比');

    window.location.hash = '#evaluate';
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(evaluateSection?.getAttribute('data-active-eval-module')).toBe('comparison');
    expect(errors).toEqual([]);
  });

  it('renders the promotion flow chain from first-class artifact and evaluation evidence', async () => {
    const selectedModel = model();
    const run = {
      id: 'real-run-1',
      modelId: selectedModel.id,
      backend: 'local',
      status: 'completed',
      summary: 'real training run',
      mock: false,
      metrics: { engine: 'mjx-ppo' },
      createdAt: '2026-09-14T00:00:00.000Z',
    };
    const artifact = {
      id: 'artifact-1',
      artifactId: 'walk-policy',
      version: 'v1',
      name: 'Walk policy',
      role: 'policy',
      kind: 'source',
      format: 'onnx',
      runtime: 'cpu-onnx',
      ref: 'artifact://walk-policy/v1',
      sha256: 'c'.repeat(64),
      sizeBytes: 73728,
      modelId: selectedModel.id,
      runId: run.id,
      datasetIds: [],
      evaluationIds: ['evaluation-1'],
      status: 'published',
      createdAt: '2026-09-14T00:00:00.000Z',
      updatedAt: '2026-09-14T00:00:00.000Z',
      publishedAt: '2026-09-14T01:00:00.000Z',
    };
    const evaluation = {
      id: 'evaluation-1',
      runId: run.id,
      modelId: selectedModel.id,
      artifactId: 'artifact-1',
      datasetIds: [],
      status: 'passed',
      summary: 'quality gate passed',
      source: 'runner',
      attested: true,
      taskEvaluation: { taskId: 'originbot-physics-navigation', qualityGate: { passed: true } },
      createdAt: '2026-09-14T00:00:00.000Z',
      updatedAt: '2026-09-14T00:00:00.000Z',
      completedAt: '2026-09-14T00:30:00.000Z',
    };
    const { window, errors, requests } = await boot({
      runs: [run],
      artifacts: [artifact],
      evaluations: [evaluation],
    });

    // The chain renders one link per producing run, ordered by the artifact
    // name and lifecycle state, with run/evaluation/deployment evidence chips.
    const chain = window.document.querySelectorAll('#promotion-chain .promotion-item');
    expect(chain.length).toBe(1);
    const item = chain[0];
    expect(item.classList.contains('is-artifact')).toBe(true);
    expect(item.classList.contains('is-published')).toBe(true);
    expect(item.textContent).toContain('Walk policy');
    expect(item.textContent).toContain('已发布');
    expect(item.textContent).toContain('mjx-ppo');
    expect(item.textContent).toContain('质量门');
    expect(item.textContent).toContain('通过');
    expect(item.textContent).toContain('KB');

    // Stage summary reflects the published state end to end.
    const publishedStage = window.document.querySelector('[data-promotion-stage="published"]');
    expect(publishedStage?.classList.contains('is-ready')).toBe(true);
    expect(window.document.querySelector('#promotion-flow-caption')?.textContent).toContain(
      '已发布',
    );

    // A published artifact offers revoke, never publish; the revoke call must
    // hit the real registry route prefix (/sim2real/artifacts), not a guessed
    // workspace path.
    const actions = Array.from(item.querySelectorAll('[data-promotion-action]'));
    expect(actions.map((button) => button.dataset.promotionAction)).toEqual(['revoke']);
    const revokeButton = actions[0] as HTMLButtonElement;
    revokeButton.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const confirmApprove =
      window.document.querySelector<HTMLButtonElement>('#confirm-action-approve');
    confirmApprove?.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const revokeRequest = requests.find(
      (request) => request.method === 'POST' && request.url.includes('/sim2real/artifacts/'),
    );
    expect(revokeRequest?.url).toBe('/sim2real/api/sim2real/artifacts/artifact-1/revoke');
    expect(revokeRequest?.body).toMatchObject({
      reason: expect.stringContaining('撤销'),
    });

    // The lineage toggle fetches the run-scoped graph and renders its hops.
    const lineageButton = item.querySelector<HTMLButtonElement>('[data-lineage-toggle]');
    expect(lineageButton).not.toBeNull();
    lineageButton?.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const lineageRequest = requests.find(
      (request) => request.url.includes('/sim2real/lineage?') && request.method === 'GET',
    );
    expect(lineageRequest?.url).toContain('runId=real-run-1');
    const panel = item.querySelector('.promotion-lineage');
    expect(panel?.hidden).toBe(false);
    expect(panel?.textContent).toContain('数据集');
    expect(panel?.textContent).toContain('walk traces · v3');
    expect(panel?.textContent).toContain('制品');
    expect(panel?.textContent).toContain('Walk policy · 已发布');
    expect(panel?.textContent).toContain('评测');
    expect(panel?.textContent).toContain('evaluation-1 · passed · attested');
    // Second click collapses the panel without a second request.
    const requestsBefore = requests.length;
    lineageButton?.click();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(panel?.hidden).toBe(true);
    expect(requests.length).toBe(requestsBefore);

    // Clicking the link opens the record detail dialog on the artifact.
    (item as HTMLElement).click();
    const dialog = window.document.querySelector<HTMLDialogElement>('#run-detail-dialog');
    expect(dialog?.hasAttribute('open')).toBe(true);
    expect(window.document.querySelector('#run-detail-body')?.textContent).toContain(
      'c'.repeat(64).slice(0, 12),
    );
    expect(errors).toEqual([]);
  });

  it('keeps the promotion chain empty state honest when no registry evidence exists', async () => {
    const { window, errors } = await boot();
    const chain = window.document.querySelector('#promotion-chain');
    expect(chain?.textContent).toContain('还没有可展示的晋级链');
    const stages = Array.from(
      window.document.querySelectorAll('.promotion-stage'),
    ) as HTMLElement[];
    expect(stages.every((stage) => stage.classList.contains('is-locked'))).toBe(true);
    expect(errors).toEqual([]);
  });

  it('keeps project, robot, task and model context aligned and sends project lineage on Run', async () => {
    const { window, errors, requests } = await boot({ projects: [project()] });
    const projectSelect = window.document.querySelector<HTMLSelectElement>('#project-select');
    expect(projectSelect?.options).toHaveLength(2);
    expect(projectSelect?.options[1]?.textContent).toBe('OriginBot 导航');

    if (projectSelect) {
      projectSelect.value = 'project-1';
      projectSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
    }
    expect(window.document.querySelector('#context-live-project')?.textContent).toBe(
      'OriginBot 导航',
    );
    expect(window.document.querySelector('#context-live-task')?.textContent).toBe('行走');
    expect(window.document.querySelector<HTMLSelectElement>('#model-select')?.value).toBe(
      'model-1',
    );

    window.document.querySelector<HTMLButtonElement>('#local-run-button')?.click();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const runRequest = requests.find(
      (request) => request.url.endsWith('/sim2real/runs') && request.method === 'POST',
    );
    expect(runRequest?.body).toMatchObject({ modelId: 'model-1', projectId: 'project-1' });
    expect(errors).toEqual([]);
  });

  it('switches the visible simulator to the selected engine task and restores the duck sandbox', async () => {
    const { window, errors } = await boot();
    const select = window.document.querySelector<HTMLSelectElement>('#task-select')!;
    const iframe = window.document.querySelector<HTMLIFrameElement>('#simulator-frame')!;
    for (const taskId of ['balance-stilts', 'balance-basketball', 'football-2v2', 'swing-pump']) {
      select.value = taskId;
      select.dispatchEvent(new window.Event('change', { bubbles: true }));
      const src = new URL(iframe.src);
      expect(src.pathname).toBe('/sim2real/task-sim/');
      expect(src.searchParams.get('taskId')).toBe(taskId);
      expect(src.searchParams.get('duckAssetBase')).toBe('/sim2real/mujoco/microduck/robot/mjlab/');
      expect(window.document.querySelector('#task-context-note')?.textContent).not.toContain(
        '画面不随',
      );
    }
    select.value = 'walk';
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
    expect(new URL(iframe.src).pathname).toBe('/mujoco/microduck/');
    expect(errors).toEqual([]);
  });

  it('passes the selected model visual directory to the engine scene while preserving its task API', async () => {
    const { window, errors } = await boot({ visualAssetBase: '/sim2real/visual-models/my-duck/' });
    const select = window.document.querySelector<HTMLSelectElement>('#task-select')!;
    select.value = 'balance-stilts';
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
    const source = new URL(
      window.document.querySelector<HTMLIFrameElement>('#simulator-frame')!.src,
    );
    expect(source.searchParams.get('duckAssetBase')).toBe('/sim2real/visual-models/my-duck/');
    expect(source.searchParams.get('taskId')).toBe('balance-stilts');
    expect(source.searchParams.get('mujocoBase')).toBe('/sim2real/mujoco');
    expect(errors).toEqual([]);
  });

  it.each(['https://other.example/duck/', '/models/../duck/', '/models/%2e%2e/duck/'])(
    'falls back to reviewed assets for an unsafe raw visual directory: %s',
    async (visualAssetBase) => {
      const { window, errors } = await boot({ visualAssetBase });
      const select = window.document.querySelector<HTMLSelectElement>('#task-select')!;
      select.value = 'balance-stilts';
      select.dispatchEvent(new window.Event('change', { bubbles: true }));
      const source = new URL(
        window.document.querySelector<HTMLIFrameElement>('#simulator-frame')!.src,
      );
      expect(source.searchParams.get('duckAssetBase')).toBe(
        '/sim2real/mujoco/microduck/robot/mjlab/',
      );
      expect(source.searchParams.get('mujocoBase')).toBe('/sim2real/mujoco');
      expect(errors).toEqual([]);
    },
  );

  it('accepts a recording only from the active simulator and makes it locally replayable', async () => {
    const { window } = await boot();
    const iframe = window.document.querySelector<HTMLIFrameElement>('#simulator-frame')!;
    const text = [
      {
        type: 'header',
        format: 'rdk-task-trajectory-v1',
        taskId: 'balance-stilts',
        source: 'engine-task-simulation',
        contractId: 'microduck-policy-v1',
      },
      {
        t: 0,
        taskId: 'balance-stilts',
        observation: Array(61).fill(0),
        action: Array(14).fill(0),
        qpos: [1, 0, 0, 0],
        qvel: [0, 0, 0],
        replay: { taskId: 'balance-stilts', qpos: [1, 0, 0, 0], qvel: [0, 0, 0] },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join('\n');
    const data = {
      type: 'rdk-task-recording-ready',
      format: 'rdk-task-trajectory-v1',
      taskId: 'balance-stilts',
      text,
    };
    window.dispatchEvent(
      new window.MessageEvent('message', { data, origin: window.location.origin, source: null }),
    );
    expect(
      window.document
        .querySelector<HTMLSelectElement>('#replay-run-select')
        ?.querySelector('option[value="local-recording"]'),
    ).toBeNull();
    const select = window.document.querySelector<HTMLSelectElement>('#task-select')!;
    select.value = 'balance-stilts';
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
    window.dispatchEvent(
      new window.MessageEvent('message', {
        data,
        origin: window.location.origin,
        source: iframe.contentWindow as never,
      }),
    );
    expect(window.document.querySelector<HTMLSelectElement>('#replay-run-select')?.value).toBe(
      'local-recording',
    );
    expect(window.document.querySelector<HTMLButtonElement>('#replay-play-button')?.disabled).toBe(
      false,
    );
    expect(window.document.querySelector('#replay-frame-detail')?.textContent).toContain('61D');
  });

  it('restores an earlier task recording after switching tasks without waiting for the hidden scene', async () => {
    const { window, errors } = await boot();
    const select = window.document.querySelector<HTMLSelectElement>('#task-select')!;
    const mainFrame = window.document.querySelector<HTMLIFrameElement>('#simulator-frame')!;
    const chooseTask = (taskId: string) => {
      select.value = taskId;
      select.dispatchEvent(new window.Event('change', { bubbles: true }));
    };
    chooseTask('balance-stilts');
    const sample = {
      t: 0.02,
      taskId: 'balance-stilts',
      observation: Array(61).fill(0),
      action: Array(14).fill(0),
      replay: { taskId: 'balance-stilts', qpos: [1, 0, 0, 0], qvel: [0, 0, 0] },
    };
    const text = [
      { type: 'header', taskId: sample.taskId, source: 'engine-task-simulation' },
      sample,
    ]
      .map((row) => JSON.stringify(row))
      .join('\n');
    window.dispatchEvent(
      new window.MessageEvent('message', {
        origin: window.location.origin,
        source: mainFrame.contentWindow as never,
        data: {
          type: 'rdk-task-recording-ready',
          format: 'rdk-task-trajectory-v1',
          taskId: sample.taskId,
          text,
        },
      }),
    );
    chooseTask('balance-basketball');
    window.document
      .querySelector<HTMLButtonElement>('.sidebar [data-view-target="records"]')
      ?.click();
    const openRecording = Array.from(
      window.document.querySelectorAll<HTMLButtonElement>('#history-list button'),
    ).find((button) => button.textContent === '回放本次录制');
    expect(openRecording).toBeTruthy();
    openRecording?.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const replayFrame = window.document.querySelector<HTMLIFrameElement>('#replay-scene-frame')!;
    expect(new URL(replayFrame.src).searchParams.get('taskId')).toBe(sample.taskId);
    expect(mainFrame.dataset.taskId).toBe('balance-basketball');
    const replayMessages = vi.spyOn(replayFrame.contentWindow!, 'postMessage');
    const ready = {
      type: 'rdk-simulator-task-state',
      taskId: sample.taskId,
      phase: 'ready',
      controlHz: 50,
    };
    // The hidden scene may still be loading or acknowledging its own task.
    // Only the replay scene's readiness can release the waiting replay frame.
    window.dispatchEvent(
      new window.MessageEvent('message', {
        data: ready,
        origin: window.location.origin,
        source: mainFrame.contentWindow as never,
      }),
    );
    expect(replayMessages.mock.calls.some(([message]) => message.type === 'rdk-replay-frame')).toBe(
      false,
    );
    window.dispatchEvent(
      new window.MessageEvent('message', {
        data: ready,
        origin: window.location.origin,
        source: replayFrame.contentWindow as never,
      }),
    );
    expect(
      replayMessages.mock.calls.find(([message]) => message.type === 'rdk-replay-frame')?.[0],
    ).toMatchObject({
      taskId: sample.taskId,
      frame: { replay: sample.replay },
      index: 0,
    });
    expect(mainFrame.dataset.taskId).toBe(sample.taskId);
    expect(window.document.querySelector<HTMLButtonElement>('#replay-play-button')?.disabled).toBe(
      false,
    );
    expect(window.document.querySelector('#replay-status')?.textContent).toContain('已加载 1 帧');
    expect(errors).toEqual([]);
  });

  it('runs and stops policy trials in the visible replay scene and accepts its status acknowledgements', async () => {
    const run = {
      id: 'balance-policy-run',
      modelId: 'model-1',
      backend: 'local',
      status: 'completed',
      taskId: 'balance-stilts',
      mock: false,
      createdAt: '2026-09-16T00:00:00.000Z',
      metrics: {},
    };
    const sample = {
      t: 0.02,
      taskId: run.taskId,
      observation: Array(61).fill(0),
      action: Array(14).fill(0),
      replay: { taskId: run.taskId, qpos: [1, 0, 0, 0], qvel: [0, 0, 0] },
    };
    const { window, errors } = await boot({ runs: [run], replayFrames: [sample] });
    window.document
      .querySelector<HTMLButtonElement>('.sidebar [data-view-target="evaluate"]')
      ?.click();
    window.document.querySelector<HTMLButtonElement>('#replay-load-button')?.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const mainFrame = window.document.querySelector<HTMLIFrameElement>('#simulator-frame')!;
    const replayFrame = window.document.querySelector<HTMLIFrameElement>('#replay-scene-frame')!;
    expect(replayFrame.hidden).toBe(false);
    const replayMessages = vi.spyOn(replayFrame.contentWindow!, 'postMessage');
    window.dispatchEvent(
      new window.MessageEvent('message', {
        origin: window.location.origin,
        source: replayFrame.contentWindow as never,
        data: {
          type: 'rdk-simulator-task-state',
          taskId: run.taskId,
          phase: 'ready',
          controlHz: 50,
        },
      }),
    );
    const mainMessages = vi.spyOn(mainFrame.contentWindow!, 'postMessage');
    const start = window.document.querySelector<HTMLButtonElement>('#policy-trial-button')!;
    const stop = window.document.querySelector<HTMLButtonElement>('#policy-trial-stop')!;
    start.click();
    expect(
      replayMessages.mock.calls.some(
        ([message]) => message.type === 'rdk-simulator-active' && message.active === true,
      ),
    ).toBe(true);
    const command = replayMessages.mock.calls.find(
      ([message]) => message.type === 'rdk-policy-run',
    )?.[0];
    expect(command).toMatchObject({ runId: run.id, taskId: run.taskId });
    expect(mainMessages.mock.calls.some(([message]) => message.type === 'rdk-policy-run')).toBe(
      false,
    );
    const acknowledgement = {
      type: 'rdk-policy-status',
      trialId: command.trialId,
      taskId: run.taskId,
      phase: 'running',
      message: '当前回放场景策略正在运行',
    };
    window.dispatchEvent(
      new window.MessageEvent('message', {
        data: acknowledgement,
        origin: window.location.origin,
        source: mainFrame.contentWindow as never,
      }),
    );
    expect(window.document.querySelector('#policy-trial-status')?.textContent).not.toContain(
      acknowledgement.message,
    );
    window.dispatchEvent(
      new window.MessageEvent('message', {
        data: { ...acknowledgement, trialId: 'older-trial' },
        origin: window.location.origin,
        source: replayFrame.contentWindow as never,
      }),
    );
    expect(window.document.querySelector('#policy-trial-status')?.textContent).not.toContain(
      acknowledgement.message,
    );
    window.dispatchEvent(
      new window.MessageEvent('message', {
        data: acknowledgement,
        origin: window.location.origin,
        source: replayFrame.contentWindow as never,
      }),
    );
    expect(window.document.querySelector('#policy-trial-status')?.textContent).toBe(
      acknowledgement.message,
    );
    expect(start.disabled).toBe(true);
    expect(stop.disabled).toBe(false);
    stop.click();
    expect(replayMessages.mock.calls.some(([message]) => message.type === 'rdk-policy-stop')).toBe(
      true,
    );
    expect(mainMessages.mock.calls.some(([message]) => message.type === 'rdk-policy-stop')).toBe(
      false,
    );
    expect(start.disabled).toBe(false);
    expect(stop.disabled).toBe(true);
    mainMessages.mockClear();
    replayMessages.mockClear();
    window.document
      .querySelector<HTMLButtonElement>('.sidebar [data-view-target="simulate"]')
      ?.click();
    expect(
      mainMessages.mock.calls.some(
        ([message]) => message.type === 'rdk-simulator-active' && message.active === true,
      ),
    ).toBe(true);
    expect(
      replayMessages.mock.calls.some(
        ([message]) => message.type === 'rdk-simulator-active' && message.active === false,
      ),
    ).toBe(true);
    mainMessages.mockClear();
    replayMessages.mockClear();
    window.document
      .querySelector<HTMLButtonElement>('.sidebar [data-view-target="evaluate"]')
      ?.click();
    expect(
      mainMessages.mock.calls.some(
        ([message]) => message.type === 'rdk-simulator-active' && message.active === false,
      ),
    ).toBe(true);
    expect(
      replayMessages.mock.calls.some(
        ([message]) => message.type === 'rdk-simulator-active' && message.active === true,
      ),
    ).toBe(true);
    expect(errors).toEqual([]);
  });

  it('shows a recoverable connection error instead of a blank workspace', async () => {
    const { window, errors } = await boot({ failOverview: true });
    const banner = window.document.querySelector<HTMLElement>('#workspace-status-banner');
    expect(banner?.hidden).toBe(false);
    expect(banner?.dataset.state).toBe('error');
    expect(window.document.querySelector('#workspace-status-title')?.textContent).toBe(
      '工作区连接失败',
    );
    expect(
      window.document.querySelector<HTMLButtonElement>('#workspace-status-retry')?.hidden,
    ).toBe(false);
    expect(errors).toEqual([]);
  });

  it('keeps an empty project empty and gives the operator a next action', async () => {
    const { window, errors } = await boot({ projects: [project({ modelIds: [] })] });
    const projectSelect = window.document.querySelector<HTMLSelectElement>('#project-select');
    if (projectSelect) {
      projectSelect.value = 'project-1';
      projectSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
    }
    expect(window.document.querySelector<HTMLSelectElement>('#model-select')?.options).toHaveLength(
      1,
    );
    expect(
      window.document.querySelector<HTMLSelectElement>('#model-select')?.options[0]?.textContent,
    ).toContain('暂无模型');
    expect(window.document.querySelector('#workspace-recent-list')?.textContent).toContain(
      '项目还没有活动',
    );
    expect(window.document.querySelector('#run-action-hint')?.textContent).toContain('模型契约');
    expect(errors).toEqual([]);
  });

  it('creates a project from the current model context and selects it immediately', async () => {
    const created = project({ id: 'project-created', name: '新实验', slug: 'new-experiment' });
    const { window, errors, requests } = await boot({ createdProject: created });
    window.document.querySelector<HTMLButtonElement>('#project-create-button')?.click();
    const dialog = window.document.querySelector<HTMLDialogElement>('#project-dialog');
    expect(dialog?.hasAttribute('open')).toBe(true);
    const name = window.document.querySelector<HTMLInputElement>('#project-name-input');
    if (name) {
      name.value = '新实验';
      name.dispatchEvent(new window.Event('input', { bubbles: true }));
    }
    window.document.querySelector<HTMLFormElement>('#project-form')?.requestSubmit();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const createRequest = requests.find(
      (request) => request.url.endsWith('/sim2real/projects') && request.method === 'POST',
    );
    expect(createRequest?.body).toMatchObject({ name: '新实验' });
    expect((createRequest?.body as { slug?: string } | undefined)?.slug).toMatch(/^project-/);
    expect(window.document.querySelector('#context-live-project')?.textContent).toBe('新实验');
    expect(window.document.querySelector<HTMLSelectElement>('#project-select')?.value).toBe(
      'project-created',
    );
    expect(dialog?.hasAttribute('open')).toBe(false);
    expect(errors).toEqual([]);
  });

  it('rejects oversized telemetry and manifest files before reading their contents', async () => {
    const { window, errors } = await boot();
    const telemetryInput = window.document.querySelector<HTMLInputElement>('#telemetry-file-input');
    const manifestInput = window.document.querySelector<HTMLInputElement>('#manifest-file-input');
    if (!telemetryInput || !manifestInput) throw new Error('file import controls are missing');

    const telemetryFile = {
      name: 'oversized.jsonl',
      size: 32 * 1024 * 1024 + 1,
      text: vi.fn(async () => {
        throw new Error('file.text() must not be called for an oversized import');
      }),
    };
    Object.defineProperty(telemetryInput, 'files', {
      configurable: true,
      value: [telemetryFile],
    });
    telemetryInput.dispatchEvent(new window.Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(telemetryFile.text).not.toHaveBeenCalled();
    expect(window.document.querySelector('#toast-region')?.textContent).toContain(
      '遥测文件超过 33554432 字节上限',
    );

    const manifestFile = {
      name: 'oversized.json',
      size: 2 * 1024 * 1024 + 1,
      text: vi.fn(async () => {
        throw new Error('file.text() must not be called for an oversized import');
      }),
    };
    Object.defineProperty(manifestInput, 'files', {
      configurable: true,
      value: [manifestFile],
    });
    manifestInput.dispatchEvent(new window.Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(manifestFile.text).not.toHaveBeenCalled();
    expect(window.document.querySelector('#toast-region')?.textContent).toContain(
      'manifest 文件超过 2097152 字节上限，请精简 JSON 后再导入',
    );
    expect(errors).toEqual([]);
  });

  it('renders the workspace notices strip with version and degraded rows, dismissible per notice', async () => {
    const { window, errors } = await boot({
      notices: [
        {
          id: 'platform-version:0.9.9-test',
          kind: 'info',
          title: '当前平台版本 0.9.9-test',
          at: '2026-09-17T00:00:00.000Z',
        },
        {
          id: 'platform-degraded',
          kind: 'degraded',
          title: '平台存在降级项',
          detail: '当前降级：storage-not-configured。相关功能可能不可用或使用替代数据。',
          at: '2026-09-17T00:00:00.000Z',
        },
      ],
    });
    const strip = window.document.querySelector('#workspace-notices');
    expect(strip?.getAttribute('hidden')).toBe(null);
    const rows = [...(strip?.querySelectorAll('.workspace-notice') || [])];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.className).toContain('kind-info');
    expect(rows[0]?.textContent).toContain('当前平台版本 0.9.9-test');
    expect(rows[1]?.className).toContain('kind-degraded');
    expect(rows[1]?.textContent).toContain('storage-not-configured');

    // First paint records the version; no reload CTA may appear for it.
    expect(rows[0]?.querySelector('.workspace-notice-reload')).toBeNull();

    rows[1]?.querySelector<HTMLButtonElement>('.workspace-notice-dismiss')?.click();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const remaining = [...(strip?.querySelectorAll('.workspace-notice') || [])];
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.textContent).toContain('当前平台版本');
    expect(errors).toEqual([]);
  });

  it('upgrades a version change into a reload CTA instead of a forced refresh', async () => {
    const { window, errors } = await boot({
      notices: [
        {
          id: 'platform-version:0.9.9-test',
          kind: 'info',
          title: '当前平台版本 0.9.9-test',
          at: '2026-09-17T00:00:00.000Z',
        },
      ],
    });
    // The server upgraded mid-session: flip the mocked /notices payload to a
    // new version, then re-run the same fetch the overview cycle performs.
    const fetchMock = window.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      const payload = url.includes('/sim2real/notices')
        ? {
            ok: true,
            notices: [
              {
                id: 'platform-version:1.0.0',
                kind: 'info',
                title: '当前平台版本 1.0.0',
                at: '2026-09-17T00:00:00.000Z',
              },
            ],
          }
        : { ok: true };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    // Force past the 60s cooldown the same way a long session would.
    window.dispatchEvent(new window.Event('sim2real-refetch-notices'));
    const flushed = await new Promise((resolve) => setTimeout(resolve, 50));
    const row = window.document.querySelector('#workspace-notices .workspace-notice');
    expect(row?.className).toContain('is-changed');
    expect(row?.textContent).toContain('平台已更新到 1.0.0');
    const reload = row?.querySelector<HTMLButtonElement>('.workspace-notice-reload');
    expect(reload, 'reload CTA must exist').toBeTruthy();
    expect(flushed).toBeUndefined();
    expect(errors).toEqual([]);
  });

  it('keeps the notices strip hidden when the server reports nothing', async () => {
    const { window, errors } = await boot({ notices: [] });
    expect(window.document.querySelector('#workspace-notices')?.hidden).toBe(true);
    expect(errors).toEqual([]);
  });

  it('submits granular feedback from the retraining advice panel and reports inline', async () => {
    const realRun = {
      id: 'run-gate-1',
      modelId: 'model-1',
      backend: 'local',
      status: 'completed',
      summary: 'gate fixture',
      mock: false,
      taskId: 'walk',
      metrics: { contractValid: true, observationSize: 61, actionSize: 14, successRate: 0.9 },
      taskEvaluation: {
        qualityGate: {
          passed: false,
          errors: ['envelope nominal: policy fell in all episodes'],
          criteria: { minSuccessRate: 0.7, maxCollisionRate: 0.1, gateOn: 'ciLowerBound' },
        },
      },
      createdAt: '2026-09-16T00:00:00.000Z',
    };
    const { window, errors, requests } = await boot({ runs: [realRun] });

    // The eval banner must surface the qualified/unqualified verdict from
    // the server-side gate, not invent one client-side.
    window.document
      .querySelector<HTMLButtonElement>('.sidebar [data-view-target="evaluate"]')
      ?.click();
    const badge = window.document.querySelector('#eval-run-quality') as HTMLElement;
    expect(badge?.hidden).toBe(false);
    expect(badge?.textContent).toContain('质量门未通过 · Unqualified');
    expect(badge?.className).toContain('state-error');
    expect(badge?.title).toContain('envelope nominal');
    expect(window.document.querySelector('#eval-run-status')?.textContent).toContain(
      '质量门未通过',
    );

    // Run-detail dialog: feedback anchored to this run record.
    window.document
      .querySelector<HTMLButtonElement>('.sidebar [data-view-target="records"]')
      ?.click();
    window.document.querySelector<HTMLButtonElement>('[data-record-id="run-gate-1"]')?.click();
    const mount = window.document.querySelector('#run-record-feedback');
    expect(mount, 'run detail must mount the feedback control').toBeTruthy();
    const inaccurate = mount?.querySelector<HTMLButtonElement>('.feedback-vote-inaccurate');
    expect(inaccurate).toBeTruthy();
    inaccurate?.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const posted = requests.find(
      (call) => call.url.includes('/sim2real/feedback') && call.method === 'POST',
    );
    expect(posted).toBeTruthy();
    expect(posted?.body).toMatchObject({ surface: 'run-record', verdict: 'inaccurate' });
    const control = mount?.querySelector('.feedback-control') as HTMLElement;
    expect(control?.className).toContain('is-submitted');
    expect(mount?.querySelector('.feedback-control-status')?.textContent).toContain('已记录');
    expect(errors).toEqual([]);
  });

  it('keeps the granular feedback retryable inline when the POST fails', async () => {
    const realRun = {
      id: 'run-gate-2',
      modelId: 'model-1',
      backend: 'local',
      status: 'completed',
      summary: 'gate fixture 2',
      mock: false,
      taskId: 'walk',
      metrics: { contractValid: true, observationSize: 61, actionSize: 14, successRate: 0.9 },
      createdAt: '2026-09-16T00:00:00.000Z',
    };
    const { window, errors } = await boot({ runs: [realRun], feedbackFails: true });
    window.document
      .querySelector<HTMLButtonElement>('.sidebar [data-view-target="records"]')
      ?.click();
    window.document.querySelector<HTMLButtonElement>('[data-record-id="run-gate-2"]')?.click();
    const mount = window.document.querySelector('#run-record-feedback');
    const accurate = mount?.querySelector<HTMLButtonElement>('.feedback-vote-accurate');
    accurate?.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const control = mount?.querySelector('.feedback-control') as HTMLElement;
    expect(control?.className).not.toContain('is-submitted');
    expect(mount?.querySelector('.feedback-control-status')?.textContent).toContain('重试');
    // Buttons re-enabled so the retry is one click, not a retype.
    expect(accurate?.disabled).toBe(false);
    expect(errors).toEqual([]);
  });

  it('lazy-loads the feedback reliance summary on first expand (Bakusevych #38)', async () => {
    const { window, errors, requests } = await boot();

    const panel = window.document.querySelector<HTMLDetailsElement>('#feedback-summary-panel');
    expect(panel, 'overview must mount the feedback summary panel').toBeTruthy();
    const mount = window.document.querySelector('#feedback-summary');
    expect(mount?.textContent).toContain('打开后加载汇总…');
    // Collapsed panel must not have cost a summary request yet.
    expect(requests.some((call) => call.url.includes('/sim2real/feedback/summary'))).toBe(false);

    panel?.setAttribute('open', '');
    await new Promise((resolve) => setTimeout(resolve, 50));

    const fetched = requests.filter((call) => call.url.includes('/sim2real/feedback/summary'));
    expect(fetched).toHaveLength(1);
    const head = mount?.querySelector('.feedback-summary-head');
    expect(head?.textContent).toContain('近 30 天反馈汇总');
    expect(head?.textContent).toContain('3 条 · 准确 67%');
    const share = head?.querySelector('.feedback-summary-share');
    expect(share?.className).not.toContain('is-positive');
    const rows = Array.from(mount?.querySelectorAll('.feedback-summary-row') || []);
    expect(
      rows.map((row) => row.querySelector('.feedback-summary-row-label')?.textContent),
    ).toEqual(['重训建议', 'Agent 回复']);
    expect(rows[0]?.querySelector('.feedback-summary-row-value')?.textContent).toBe('2/2 准确');
    expect(rows[1]?.querySelector('.feedback-summary-row-value')?.textContent).toBe('0/1 准确');
    // Reliance statement: counts only, and the telemetry-only contract is spelled out.
    expect(mount?.querySelector('.feedback-summary-note')?.textContent).toContain(
      '不参与发布或晋级闸门',
    );
    // No identifiers beyond aggregates: the render surface has no note text.
    expect(JSON.stringify(mount?.textContent)).not.toContain('owner');
    expect(errors).toEqual([]);
  });

  it('renders an honest empty state when no feedback has been recorded yet', async () => {
    const { window, errors } = await boot({
      feedbackSummary: { total: 0, accurate: 0, inaccurate: 0, windowDays: 30, bySurface: [] },
    });
    const panel = window.document.querySelector<HTMLDetailsElement>('#feedback-summary-panel');
    panel?.setAttribute('open', '');
    await new Promise((resolve) => setTimeout(resolve, 50));
    const mount = window.document.querySelector('#feedback-summary');
    expect(mount?.querySelector('.feedback-summary-empty')?.textContent).toContain(
      '还没有已记录的反馈',
    );
    expect(mount?.querySelectorAll('.feedback-summary-row')).toHaveLength(0);
    expect(errors).toEqual([]);
  });

  it('pre-selects the remembered training profile and labels it (Amershi G13)', async () => {
    const { window, errors } = await boot({
      workspaceContext: { trainingProfile: 'high-vram' },
    });
    const select = window.document.querySelector<HTMLSelectElement>('#training-profile');
    expect(select?.value).toBe('high-vram');
    const note = window.document.querySelector('[data-training-profile-note]');
    // Pre-selection is labeled, never silent.
    expect(note?.hidden).toBe(false);
    expect(note?.textContent).toContain('已按你上次的选择预选');

    select?.dispatchEvent(new window.Event('change', { bubbles: true }));
    const selectAfter = window.document.querySelector<HTMLSelectElement>('#training-profile');
    const nextValue = selectAfter?.value || 'standard';
    const stored = JSON.parse(
      window.localStorage.getItem('rdk-duck-lab-workspace-context') || '{}',
    ) as Record<string, unknown>;
    expect(stored.trainingProfile).toBe(nextValue);
    expect(errors).toEqual([]);
  });

  it('falls back to defaults when no training profile preference exists', async () => {
    const { window, errors } = await boot();
    const select = window.document.querySelector<HTMLSelectElement>('#training-profile');
    expect(select?.value).toBe('standard');
    expect(window.document.querySelector('[data-training-profile-note]')?.hidden).toBe(true);
    expect(errors).toEqual([]);
  });
});
