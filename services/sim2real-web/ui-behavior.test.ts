import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'public');
const [html, telemetrySource, appSource] = await Promise.all([
  readFile(path.join(root, 'index.html'), 'utf8'),
  readFile(path.join(root, 'telemetry-core.js'), 'utf8'),
  readFile(path.join(root, 'app.js'), 'utf8'),
]);
const [inspectorCoreSource, inspectorSource] = await Promise.all([
  readFile(path.join(root, 'run-inspector-core.js'), 'utf8'),
  readFile(path.join(root, 'run-inspector.js'), 'utf8'),
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

function overview(
  runs?: unknown[],
  extras: {
    artifacts?: unknown[];
    evaluations?: unknown[];
    deployments?: unknown[];
    localWorker?: { mock?: boolean; engines?: string[] | null };
  } = {},
) {
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
          ...extras.localWorker,
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
    projectsStatus?: number;
    datasets?: unknown[];
    datasetsStatus?: number;
    summaryGeneratedAt?: string;
    captureHeartbeat?: boolean;
    captureCameraTimeout?: boolean;
    failOverview?: boolean;
    createdProject?: unknown;
    runs?: unknown[];
    artifacts?: unknown[];
    evaluations?: unknown[];
    overviewDeployments?: unknown[];
    localWorker?: { mock?: boolean; engines?: string[] | null };
    stationHealth?: unknown;
    stationHealthStatus?: number;
    stationStream?: () => Response | Promise<Response>;
    devices?: unknown[];
    localBridgeStatus?: unknown;
    pairingCommand?: string;
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
  } = {},
) {
  const dom = new JSDOM(html, {
    url: options.url || 'http://127.0.0.1:3000/sim2real/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  openWindows.push(dom.window);
  const { window } = dom;
  const heartbeatTimers = new Map<number, () => void>();
  const cameraTimers = new Map<number, () => void>();
  if (options.captureHeartbeat || options.captureCameraTimeout) {
    const nativeSetTimeout = window.setTimeout.bind(window);
    const nativeClearTimeout = window.clearTimeout.bind(window);
    let nextHeartbeatId = 1000000;
    window.setTimeout = ((callback, delay, ...args) => {
      const timers =
        options.captureHeartbeat && delay === 30000
          ? heartbeatTimers
          : options.captureCameraTimeout && delay === 10000
            ? cameraTimers
            : null;
      if (timers && typeof callback === 'function') {
        const id = nextHeartbeatId++;
        timers.set(id, () => callback(...args));
        return id;
      }
      return nativeSetTimeout(callback, delay, ...args);
    }) as typeof window.setTimeout;
    window.clearTimeout = (id) => {
      if (!heartbeatTimers.delete(Number(id)) && !cameraTimers.delete(Number(id)))
        nativeClearTimeout(id);
    };
  }
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
        payload = overview(options.runs, {
          artifacts: options.artifacts,
          evaluations: options.evaluations,
          deployments: options.overviewDeployments,
          localWorker: options.localWorker,
        });
        if (options.devices) (payload as { devices: unknown[] }).devices = options.devices;
      } else if (url.includes('/board-station/health') && options.stationHealth !== undefined) {
        const health =
          typeof options.stationHealth === 'function'
            ? await options.stationHealth(url)
            : options.stationHealth;
        return new Response(JSON.stringify(health), {
          status: options.stationHealthStatus || 200,
          headers: { 'content-type': 'application/json' },
        });
      } else if (url.includes('/board-station/status/stream') && options.stationStream) {
        return options.stationStream();
      } else if (url.includes('/local-bridge/status') && options.localBridgeStatus) {
        payload = options.localBridgeStatus;
      } else if (url.includes('/local-bridge/pairing-code') && options.pairingCommand) {
        payload = { ok: true, command: options.pairingCommand };
      } else if (url.includes('/workspace-summary')) {
        payload = {
          ok: true,
          generatedAt: options.summaryGeneratedAt,
          counts: { models: 1, runs: 1, deployments: 0, devices: 0 },
        };
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
      else if (
        (url.endsWith('/projects') && (options.projectsStatus || 200) >= 400) ||
        (url.endsWith('/datasets') && (options.datasetsStatus || 200) >= 400)
      ) {
        return new Response(JSON.stringify({ ok: false, message: '辅助列表暂不可用' }), {
          status: url.endsWith('/projects') ? options.projectsStatus : options.datasetsStatus,
          headers: { 'content-type': 'application/json' },
        });
      } else if (url.endsWith('/projects'))
        payload = { ok: true, projects: options.projects || [] };
      else if (url.endsWith('/datasets')) payload = { ok: true, datasets: options.datasets || [] };
      else if (url.includes('/models/model-1')) {
        payload = { ok: true, model: model(), compatibility: [] };
      } else if (url.includes('/replay') && options.replayFrames) {
        payload = {
          ok: true,
          frames: options.replayFrames,
          replay: { sampleCount: options.replayFrames.length },
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
    TextDecoder: globalThis.TextDecoder,
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
  return {
    window,
    errors,
    requests,
    cameraTimeout() {
      for (const [id, callback] of cameraTimers) {
        cameraTimers.delete(id);
        callback();
      }
    },
    async heartbeat() {
      const pending = [...heartbeatTimers.entries()].at(-1);
      if (!pending) throw new Error('overview heartbeat was not scheduled');
      heartbeatTimers.delete(pending[0]);
      pending[1]();
      await new Promise((resolve) => setTimeout(resolve, 30));
    },
  };
}

describe('Sim2Real workbench DOM behavior', () => {
  it('enables only explicitly registered engines when the CPU worker also reports default', async () => {
    const { window, errors } = await boot({
      localWorker: { mock: false, engines: ['default', 'starter-ppo', 'act', 'diffusion-policy'] },
    });
    const options = Array.from(
      window.document.querySelectorAll<HTMLOptionElement>('#training-engine option'),
    );
    const registered = new Set(['', 'starter-ppo', 'act', 'diffusion-policy']);
    for (const option of options) {
      expect(option.disabled, option.value || 'default').toBe(!registered.has(option.value));
      expect(option.textContent?.includes('worker 未注册'), option.value || 'default').toBe(
        !registered.has(option.value),
      );
    }
    expect(errors).toEqual([]);
  });

  it.each([null, undefined])(
    'preserves engine compatibility when the real worker does not report engines (%s)',
    async (engines) => {
      const { window, errors } = await boot({ localWorker: { mock: false, engines } });
      const options = Array.from(
        window.document.querySelectorAll<HTMLOptionElement>('#training-engine option'),
      );
      expect(options.every((option) => !option.disabled)).toBe(true);
      expect(options.every((option) => !option.textContent?.includes('worker 未注册'))).toBe(true);
      expect(errors).toEqual([]);
    },
  );

  it('preserves loaded project and dataset data during heartbeat polls that skip auxiliary reads', async () => {
    const { window, errors, requests, heartbeat } = await boot({
      captureHeartbeat: true,
      projects: [project()],
      datasets: [{ id: 'dataset-1', name: '真实示教', modelId: 'model-1' }],
      summaryGeneratedAt: '2026-09-10T00:00:00.000Z',
    });
    const note = window.document.querySelector('#project-context-note');
    const saved = window.document.querySelector('#workspace-last-saved');
    const dataset = window.document.querySelector('#workspace-dataset-count');
    const originalNote = note?.textContent;
    const originalSaved = saved?.textContent;
    const originalDataset = dataset?.textContent;
    expect(originalNote).toContain('1 个项目');
    expect(originalDataset).toBe('1 个数据集');
    expect(requests.filter((request) => request.url.endsWith('/projects'))).toHaveLength(1);
    await heartbeat();
    await heartbeat();
    expect(note?.textContent).toBe(originalNote);
    expect(saved?.textContent).toBe(originalSaved);
    expect(dataset?.textContent).toBe(originalDataset);
    expect(window.document.querySelectorAll('#project-select option')).toHaveLength(2);
    expect(requests.filter((request) => request.url.endsWith('/projects'))).toHaveLength(1);
    expect(requests.filter((request) => request.url.endsWith('/datasets'))).toHaveLength(1);
    expect(requests.filter((request) => request.url.includes('/overview?'))).toHaveLength(3);
    expect(errors).toEqual([]);
  });

  it('retains known auxiliary failures until a foreground retry actually checks them again', async () => {
    const options = {
      captureHeartbeat: true,
      projects: [project()],
      projectsStatus: 503,
      datasetsStatus: 503,
    };
    const { window, requests, heartbeat } = await boot(options);
    const note = window.document.querySelector('#project-context-note');
    const banner = window.document.querySelector<HTMLElement>('#workspace-status-banner');
    expect(note?.textContent).toContain('项目列表暂不可用');
    expect(banner?.hidden).toBe(false);
    expect(banner?.dataset.state).toBe('warning');
    await heartbeat();
    expect(note?.textContent).toContain('项目列表暂不可用');
    expect(banner?.hidden).toBe(false);
    expect(banner?.dataset.state).toBe('warning');
    expect(requests.filter((request) => request.url.endsWith('/projects'))).toHaveLength(1);
    options.projectsStatus = 200;
    options.datasetsStatus = 200;
    window.document.querySelector<HTMLButtonElement>('#refresh-button')?.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(note?.textContent).toContain('1 个项目');
    expect(banner?.hidden).toBe(true);
    expect(requests.filter((request) => request.url.endsWith('/projects'))).toHaveLength(2);
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
        return new Proxy(
          {
            createImageData: (width: number, height: number) => ({
              width,
              height,
              data: new Uint8ClampedArray(width * height * 4),
            }),
            putImageData: (image: { data: Uint8ClampedArray }) => drawn.push(image.data),
            clearRect: () => undefined,
          },
          {
            get: (target, property) =>
              Reflect.get(target, property) ?? Reflect.get(canvasContext(), property),
          },
        );
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

    // Index 2 has no frame. Even though the future frame is one index away,
    // it must never be shown as an observation available at this time.
    const seek = window.document.querySelector<HTMLInputElement>('#replay-seek');
    if (seek) {
      seek.value = '2';
      seek.dispatchEvent(new window.Event('input', { bubbles: true }));
    }
    expect(note?.textContent).toContain('最近帧');
    expect(note?.textContent).toContain('非本采样点');
    expect(note?.textContent).toContain('t=0.10s');
    expect(note?.textContent).toContain('0.20s');
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

describe('station device manager before board readiness', () => {
  const bridgeStatus = {
    bridges: [
      {
        bridgeId: 'bridge-fixture',
        online: true,
        devices: [{ bridgeDeviceId: 'board-fixture', name: 'Fixture board' }],
      },
    ],
  };
  const stationUrl = 'http://127.0.0.1:3000/sim2real/#station/devices';
  const pairingPosts = (requests: Array<{ url: string; method: string }>) =>
    requests.filter(
      (request) => request.method === 'POST' && request.url.includes('/local-bridge/pairing-code'),
    );

  it.each([
    { available: false, agent: { mock: false } },
    { state: 'offline', agent: { mock: false } },
  ])('pairs and connects a Bridge card from an initial unavailable board (%j)', async (health) => {
    const { window, requests, errors } = await boot({
      url: stationUrl,
      stationHealth: health,
      localBridgeStatus: bridgeStatus,
      pairingCommand: 'fixture-pair-command',
    });
    const host = window.document.querySelector<HTMLInputElement>('#station-device-host')!;
    host.value = 'fixture.invalid';
    window.document.querySelector<HTMLButtonElement>('#station-device-script-btn')!.click();
    await vi.waitFor(() => expect(pairingPosts(requests)).toHaveLength(1));
    expect(pairingPosts(requests)[0]).toMatchObject({
      body: { host: 'fixture.invalid', sshUser: 'root', sshPort: 22 },
    });
    await vi.waitFor(() =>
      expect(
        window.document.querySelector<HTMLTextAreaElement>('#station-connect-script-text')?.value,
      ).toBe('fixture-pair-command'),
    );
    const card = window.document.querySelector<HTMLButtonElement>(
      '#station-device-list [data-action="bridge-connect"]',
    );
    expect(card).not.toBeNull();
    card!.click();
    await vi.waitFor(() =>
      expect(
        requests.filter(
          (request) =>
            request.method === 'POST' &&
            request.url.includes('/local-bridge/devices/board-fixture/connect'),
        ),
      ).toHaveLength(1),
    );
    expect(
      requests.some(
        (request) => request.method === 'POST' && /\/(drive|policy)\//.test(request.url),
      ),
    ).toBe(false);
    expect(errors).toEqual([]);
  });

  it('binds pairing while the initial health is pending and keeps repeated initialization idempotent', async () => {
    let releaseHealth: ((health: unknown) => void) | undefined;
    const pendingHealth = new Promise((resolve) => {
      releaseHealth = resolve;
    });
    const { window, requests, errors } = await boot({
      url: stationUrl,
      stationHealth: () => pendingHealth,
      localBridgeStatus: bridgeStatus,
      pairingCommand: 'fixture-pair-command',
    });
    window.document.querySelector<HTMLInputElement>('#station-device-host')!.value =
      'fixture.invalid';
    const pair = window.document.querySelector<HTMLButtonElement>('#station-device-script-btn')!;
    pair.click();
    await vi.waitFor(() => expect(pairingPosts(requests)).toHaveLength(1));
    const card = window.document.querySelector<HTMLButtonElement>(
      '#station-device-list [data-action="bridge-connect"]',
    );
    expect(card).not.toBeNull();
    card!.click();
    await vi.waitFor(() =>
      expect(
        requests.filter((request) => request.url.includes('/board-station/health')),
      ).toHaveLength(2),
    );
    releaseHealth?.({ available: false, state: 'offline' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    pair.click();
    await vi.waitFor(() => expect(pairingPosts(requests)).toHaveLength(2));
    expect(errors).toEqual([]);
  });
});

describe('station camera evidence and cancellation', () => {
  const devices = [
    { id: 'board-a', name: 'Board A', status: 'connected' },
    { id: 'board-b', name: 'Board B', status: 'connected' },
  ];
  const health = (mock = false, id = 'board-a') => ({
    ok: true,
    agent: { mock },
    device: { id },
    cameraSupported: true,
  });
  async function openStation(window: InstanceType<typeof JSDOM>['window']) {
    window.document
      .querySelector<HTMLButtonElement>('.sidebar [data-view-target="station"]')
      ?.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    window.document.querySelector<HTMLButtonElement>('#station-tab-telemetry')?.click();
  }
  function decoded(image: HTMLImageElement) {
    Object.defineProperties(image, {
      naturalWidth: { configurable: true, value: 16 },
      naturalHeight: { configurable: true, value: 12 },
    });
  }

  it.each([
    {
      payload: { ok: true, available: false, state: 'offline', agent: { mock: false } },
      status: 200,
    },
    { payload: { ok: false, message: 'not configured' }, status: 503 },
  ])(
    'does not claim a connected mock agent for unavailable health ($status)',
    async ({ payload, status }) => {
      const { window } = await boot({ stationHealth: payload, stationHealthStatus: status });
      await openStation(window);
      expect(window.document.querySelector<HTMLElement>('#station-honesty-note')?.hidden).toBe(
        true,
      );
      window.document.querySelector<HTMLButtonElement>('#station-camera-toggle')?.click();
      expect(window.document.querySelector('#station-camera-state')?.textContent).not.toContain(
        '已连接',
      );
      expect(window.document.querySelector('#station-camera-img')?.hasAttribute('src')).toBe(false);
    },
  );

  it('waits for a decoded first frame and rejects callbacks after stopping', async () => {
    const { window } = await boot({ stationHealth: health(), devices });
    await openStation(window);
    const toggle = window.document.querySelector<HTMLButtonElement>('#station-camera-toggle')!;
    toggle.click();
    const image = window.document.querySelector<HTMLImageElement>('#station-camera-img')!;
    expect(window.document.querySelector('#station-camera-state')?.textContent).toContain(
      '等待首帧',
    );
    expect(image.hidden).toBe(true);
    image.dispatchEvent(new window.Event('load'));
    expect(window.document.querySelector('#station-camera-state')?.textContent).toContain(
      '等待首帧',
    );
    decoded(image);
    image.dispatchEvent(new window.Event('load'));
    expect(window.document.querySelector('#station-camera-state')?.textContent).toContain(
      '首帧已确认',
    );
    expect(image.hidden).toBe(false);
    toggle.click();
    image.dispatchEvent(new window.Event('load'));
    image.dispatchEvent(new window.Event('error'));
    expect(window.document.querySelector('#station-camera-state')?.textContent).toBe('未连接');
    expect(image.hasAttribute('src')).toBe(false);
  });

  it('recognizes a continuous MJPEG first frame without a load event and labels the mock source', async () => {
    const { window } = await boot({ stationHealth: health(true), devices });
    await openStation(window);
    expect(window.document.querySelector<HTMLElement>('#station-honesty-note')?.hidden).toBe(false);
    window.document.querySelector<HTMLButtonElement>('#station-camera-toggle')?.click();
    const image = window.document.querySelector<HTMLImageElement>('#station-camera-img')!;
    decoded(image);
    await new Promise((resolve) => setTimeout(resolve, 280));
    expect(window.document.querySelector('#station-camera-state')?.textContent).toContain(
      '合成演示',
    );
    expect(window.document.querySelector('#station-camera-state')?.textContent).toContain(
      '首帧已确认',
    );
    expect(image.alt).toContain('不是真机');
  });

  it('times out an unconfirmed frame and makes a late decode harmless', async () => {
    const { window, cameraTimeout } = await boot({
      stationHealth: health(),
      captureCameraTimeout: true,
    });
    await openStation(window);
    window.document.querySelector<HTMLButtonElement>('#station-camera-toggle')?.click();
    const image = window.document.querySelector<HTMLImageElement>('#station-camera-img')!;
    cameraTimeout();
    expect(window.document.querySelector('#station-camera-state')?.textContent).toContain('超时');
    expect(image.hasAttribute('src')).toBe(false);
    decoded(image);
    image.dispatchEvent(new window.Event('load'));
    expect(window.document.querySelector('#station-camera-state')?.textContent).toContain('超时');
  });

  it('keeps an old image from overwriting the replacement board stream or its error', async () => {
    const { window } = await boot({
      devices,
      stationHealth: (url: string) =>
        health(false, new URL(url, 'http://localhost').searchParams.get('deviceId') || 'board-a'),
    });
    await openStation(window);
    const toggle = window.document.querySelector<HTMLButtonElement>('#station-camera-toggle')!;
    toggle.click();
    const oldImage = window.document.querySelector<HTMLImageElement>('#station-camera-img')!;
    const select = window.document.querySelector<HTMLSelectElement>('#device-select')!;
    select.value = 'board-b';
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(oldImage.hasAttribute('src')).toBe(false);
    toggle.click();
    const replacement = window.document.querySelector<HTMLImageElement>('#station-camera-img')!;
    expect(replacement).not.toBe(oldImage);
    expect(replacement.src).toContain('deviceId=board-b');
    decoded(oldImage);
    oldImage.dispatchEvent(new window.Event('load'));
    oldImage.dispatchEvent(new window.Event('error'));
    expect(window.document.querySelector('#station-camera-state')?.textContent).toContain(
      '等待首帧',
    );
    replacement.dispatchEvent(new window.Event('error'));
    expect(window.document.querySelector('#station-camera-state')?.textContent).toContain('不可用');
    oldImage.dispatchEvent(new window.Event('load'));
    expect(window.document.querySelector('#station-camera-state')?.textContent).toContain('不可用');
  });

  it('ignores a late health response from the previous board', async () => {
    let releaseHealth!: (value: unknown) => void;
    let calls = 0;
    const { window } = await boot({
      devices,
      stationHealth: () =>
        ++calls === 1
          ? new Promise((resolve) => {
              releaseHealth = resolve;
            })
          : health(false, 'board-b'),
    });
    await openStation(window);
    const select = window.document.querySelector<HTMLSelectElement>('#device-select')!;
    select.value = 'board-b';
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    releaseHealth(health(true, 'board-a'));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(window.document.querySelector('#station-device-name')?.textContent).toBe('Board B');
    expect(window.document.querySelector<HTMLElement>('#station-honesty-note')?.hidden).toBe(true);
    window.document.querySelector<HTMLButtonElement>('#station-camera-toggle')?.click();
    expect(window.document.querySelector<HTMLImageElement>('#station-camera-img')?.src).toContain(
      'deviceId=board-b',
    );
    expect(window.document.querySelector('#station-camera-state')?.textContent).not.toContain(
      '合成演示',
    );
  });

  it('ignores a late offline status stream that could cancel the replacement camera', async () => {
    let releaseStream!: (response: Response) => void;
    let calls = 0;
    const { window } = await boot({
      devices,
      stationHealth: (url: string) =>
        health(false, new URL(url, 'http://localhost').searchParams.get('deviceId') || 'board-a'),
      stationStream: () =>
        ++calls === 1
          ? new Promise((resolve) => {
              releaseStream = resolve;
            })
          : new Response(
              new ReadableStream({
                start(controller) {
                  controller.close();
                },
              }),
            ),
    });
    await openStation(window);
    const select = window.document.querySelector<HTMLSelectElement>('#device-select')!;
    select.value = 'board-b';
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    window.document.querySelector<HTMLButtonElement>('#station-camera-toggle')?.click();
    const image = window.document.querySelector<HTMLImageElement>('#station-camera-img')!;
    releaseStream(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                '{"available":false,"state":"offline","message":"old board offline"}\n',
              ),
            );
            controller.close();
          },
        }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 280));
    expect(image.hasAttribute('src')).toBe(true);
    expect(window.document.querySelector('#station-camera-state')?.textContent).toContain(
      '等待首帧',
    );
  });

  it.each(['replace', 'empty'])(
    'cancels a confirmed camera when a refreshed registry must %s the selected board',
    async (change) => {
      const options = {
        devices: [devices[0]],
        stationHealth: (url: string) => {
          const id = new URL(url, 'http://localhost').searchParams.get('deviceId');
          return id ? health(false, id) : { ok: true, available: false, state: 'offline' };
        },
      };
      const { window, requests } = await boot(options);
      await openStation(window);
      window.document.querySelector<HTMLButtonElement>('#station-camera-toggle')?.click();
      const oldImage = window.document.querySelector<HTMLImageElement>('#station-camera-img')!;
      decoded(oldImage);
      oldImage.dispatchEvent(new window.Event('load'));
      expect(window.document.querySelector('#station-camera-state')?.textContent).toContain(
        '首帧已确认',
      );
      options.devices = change === 'replace' ? [devices[1]] : [];
      window.document.querySelector<HTMLButtonElement>('#refresh-button')?.click();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(oldImage.hasAttribute('src')).toBe(false);
      oldImage.dispatchEvent(new window.Event('load'));
      expect(window.document.querySelector('#station-camera-state')?.textContent).toBe('未连接');
      if (change === 'replace') {
        expect(
          requests.some((request) =>
            request.url.includes('/board-station/health?deviceId=board-b'),
          ),
        ).toBe(true);
        window.document.querySelector<HTMLButtonElement>('#station-camera-toggle')?.click();
        expect(
          window.document.querySelector<HTMLImageElement>('#station-camera-img')?.src,
        ).toContain('deviceId=board-b');
      } else {
        expect(window.document.querySelector<HTMLElement>('#station-honesty-note')?.hidden).toBe(
          true,
        );
        window.document.querySelector<HTMLButtonElement>('#station-camera-toggle')?.click();
        expect(window.document.querySelector('#station-camera-img')?.hasAttribute('src')).toBe(
          false,
        );
      }
    },
  );

  it('cancels a confirmed camera when selecting a registered Local Bridge board', async () => {
    const { window, requests } = await boot({
      devices: [devices[0], { ...devices[1], bridgeDeviceId: 'bridge-b' }],
      stationHealth: (url: string) =>
        health(false, new URL(url, 'http://localhost').searchParams.get('deviceId') || 'board-a'),
      localBridgeStatus: {
        bridges: [
          {
            bridgeId: 'bridge-1',
            online: true,
            devices: [{ bridgeDeviceId: 'bridge-b', name: 'Board B' }],
          },
        ],
      },
    });
    await openStation(window);
    window.document.querySelector<HTMLButtonElement>('#station-camera-toggle')?.click();
    const oldImage = window.document.querySelector<HTMLImageElement>('#station-camera-img')!;
    decoded(oldImage);
    oldImage.dispatchEvent(new window.Event('load'));
    const select = window.document.querySelector<HTMLButtonElement>(
      '#station-device-list [data-action="bridge-select"]',
    )!;
    expect(select).not.toBeNull();
    select.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(oldImage.hasAttribute('src')).toBe(false);
    oldImage.dispatchEvent(new window.Event('load'));
    expect(window.document.querySelector('#station-camera-state')?.textContent).toBe('未连接');
    expect(
      requests.some((request) => request.url.includes('/board-station/health?deviceId=board-b')),
    ).toBe(true);
  });

  it.each(['pagehide', 'navigate'])(
    'cancels an image and rejects late decode on %s',
    async (action) => {
      const { window } = await boot({ stationHealth: health(), devices });
      await openStation(window);
      window.document.querySelector<HTMLButtonElement>('#station-camera-toggle')?.click();
      const image = window.document.querySelector<HTMLImageElement>('#station-camera-img')!;
      if (action === 'pagehide') window.dispatchEvent(new window.Event('pagehide'));
      else
        window.document
          .querySelector<HTMLButtonElement>('.sidebar [data-view-target="overview"]')
          ?.click();
      await new Promise((resolve) => setTimeout(resolve, 5));
      decoded(image);
      image.dispatchEvent(new window.Event('load'));
      expect(image.hasAttribute('src')).toBe(false);
      expect(window.document.querySelector('#station-camera-state')?.textContent).toBe('未连接');
    },
  );
});

describe('atomic capability evidence workflows', () => {
  it('keeps telemetry import outside the mutually hidden comparison wrapper', async () => {
    const { window } = await boot({ runs: [] });
    const panel = window.document.querySelector('.telemetry-panel');
    expect(panel?.closest('.evaluation-evidence')).toBeNull();
    expect(panel?.hasAttribute('open')).toBe(true);
    expect(window.document.querySelector('#run-inspector')).not.toBeNull();
  });

  it('uses the loaded Run frames for all telemetry charts and the shared scrubber', async () => {
    const frames = [
      { t: 1, observation: [1], action: [0], reward: 2 },
      { t: 1.1, observation: [2], action: [1], reward: 3, done: true },
      { t: 1.8, observation: [3], action: [2], reward: 4 },
    ];
    const { window, errors } = await boot({ replayFrames: frames });
    window.document.querySelector<HTMLButtonElement>('#replay-load-button')?.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(window.document.querySelector<HTMLElement>('#telemetry-visuals')?.hidden).toBe(false);
    expect(window.document.querySelector<HTMLInputElement>('#telemetry-scrub-input')?.max).toBe(
      '2',
    );
    expect(window.document.querySelector('#telemetry-summary')?.textContent).toContain('3');
    expect(errors).toEqual([]);
  });

  it('takes the operator to the simulator when starting a policy trial', async () => {
    const { window, errors } = await boot({ replayFrames: [{ t: 0, observation: [1] }] });
    window.document.querySelector<HTMLButtonElement>('#replay-load-button')?.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    window.document.querySelector<HTMLButtonElement>('#eval-tab-run')?.click();
    window.document.querySelector<HTMLButtonElement>('#policy-trial-button')?.click();
    expect(window.document.body.dataset.activeView).toBe('simulate');
    expect(errors).toEqual([]);
  });
});

describe('replay cancellation and provenance', () => {
  it('does not mount an old video export or reset the replacement export button', async () => {
    const frames = [
      { t: 0, cameraFrame: { width: 1, height: 1, channels: 3, encoding: 'rgb8', data: 'AAAA' } },
    ];
    const runs = ['a', 'b'].map((id) => ({
      id,
      modelId: 'model-1',
      backend: 'contract',
      status: 'completed',
      createdAt: '2026-10-10',
      metrics: { contractValid: true },
    }));
    const { window, errors } = await boot({ runs, replayFrames: frames });
    const originalFetch = window.fetch;
    const exports = new Map<string, (response: Response) => void>();
    window.fetch = (input, options) =>
      String(input).endsWith('/replay-video') && options?.method === 'POST'
        ? new Promise<Response>((resolve) => {
            exports.set(String(input), resolve);
          })
        : originalFetch(input, options);
    const select = window.document.querySelector<HTMLSelectElement>('#replay-run-select')!;
    const button = window.document.querySelector<HTMLButtonElement>('#replay-video-render')!;
    const load = async (id: string) => {
      select.value = id;
      select.dispatchEvent(new window.Event('change'));
      window.document.querySelector<HTMLButtonElement>('#replay-load-button')?.click();
      await new Promise((resolve) => setTimeout(resolve, 30));
    };
    await load('a');
    button.click();
    await load('b');
    button.click();
    const exported = (id: string) =>
      new Response(
        JSON.stringify({
          ok: true,
          runId: id,
          video: { sha256: 'a'.repeat(64), frameCount: 1, fps: 1, durationSeconds: 1 },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    exports.get([...exports.keys()].find((url) => url.includes('/runs/a/'))!)?.(exported('a'));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(
      window.document.querySelector<HTMLVideoElement>('#replay-video-element')?.getAttribute('src'),
    ).toBeNull();
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe('编码中…');
    exports.get([...exports.keys()].find((url) => url.includes('/runs/b/'))!)?.(exported('b'));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(
      window.document.querySelector<HTMLVideoElement>('#replay-video-element')?.getAttribute('src'),
    ).toContain('/runs/b/replay-video');
    expect(button.disabled).toBe(false);
    expect(errors).toEqual([]);
  });

  it('ignores a late video export failure after clearing its evidence', async () => {
    const { window, errors } = await boot({
      replayFrames: [
        { t: 0, cameraFrame: { width: 1, height: 1, channels: 3, encoding: 'rgb8', data: 'AAAA' } },
      ],
    });
    window.document.querySelector<HTMLButtonElement>('#replay-load-button')?.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const originalFetch = window.fetch;
    let fail!: (error: Error) => void;
    window.fetch = (input, options) =>
      String(input).endsWith('/replay-video') && options?.method === 'POST'
        ? new Promise<Response>((_resolve, reject) => {
            fail = reject;
          })
        : originalFetch(input, options);
    window.document.querySelector<HTMLButtonElement>('#replay-video-render')?.click();
    window.document.querySelector<HTMLButtonElement>('#telemetry-clear-button')?.click();
    const caption = window.document.querySelector('#replay-video-caption')?.textContent;
    const button = window.document.querySelector<HTMLButtonElement>('#replay-video-render')!;
    const buttonState = { disabled: button.disabled, label: button.textContent };
    fail(new Error('cancelled old export failed'));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(window.document.querySelector('#replay-video-caption')?.textContent).toBe(caption);
    expect({ disabled: button.disabled, label: button.textContent }).toEqual(buttonState);
    expect(window.document.querySelector<HTMLElement>('#replay-video-block')?.hidden).toBe(true);
    expect(errors).toEqual([]);
  });

  it('keeps the Inspector elapsed clock between irregular samples while synchronizing legacy frames', async () => {
    const frames = [
      { t: 4, reward: 1 },
      { t: 4.5, reward: 2 },
      { t: 6, reward: 3 },
    ];
    const { window, errors } = await boot({ replayFrames: frames });
    window.eval(inspectorCoreSource);
    window.eval(inspectorSource);
    const inspector = window.document.querySelector('rdk-run-inspector') as any;
    inspector.configure({
      runs: [{ id: 'mock-run-1' }],
      requestJson: async (url: string) =>
        url.endsWith('/replay') ? { frames } : { run: { id: 'mock-run-1', modelId: 'model-1' } },
    });
    await inspector.load('mock-run-1');
    await new Promise((resolve) => setTimeout(resolve, 30));
    inspector.seek(0.75);
    expect(window.document.querySelector('#replay-frame-label')?.textContent).toBe('2 / 3 帧');
    expect(inspector.position.textContent).toBe('0.750s / 2.000s');
    expect(errors).toEqual([]);
  });

  it('ignores an in-flight historical replay after clear', async () => {
    const { window, errors } = await boot({
      replayFrames: [{ t: 0, observation: [1], reward: 1 }],
    });
    window.document.querySelector<HTMLButtonElement>('#replay-load-button')?.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const originalFetch = window.fetch;
    window.fetch = async (...args) => {
      if (String(args[0]).includes('/replay'))
        await new Promise((resolve) => setTimeout(resolve, 50));
      return originalFetch(...args);
    };
    window.document.querySelector<HTMLButtonElement>('#replay-load-button')?.click();
    window.document.querySelector<HTMLButtonElement>('#telemetry-clear-button')?.click();
    await new Promise((resolve) => setTimeout(resolve, 90));
    expect(window.document.querySelector('#replay-frame-label')?.textContent).toBe('0 / 0 帧');
    expect(window.document.querySelector<HTMLElement>('#telemetry-visuals')?.hidden).toBe(true);
    expect(errors).toEqual([]);
  });

  it('plays historical samples at their recorded interval', async () => {
    const { window } = await boot({
      replayFrames: [
        { t: 4, observation: [1] },
        { t: 4.5, observation: [2] },
      ],
    });
    window.document.querySelector<HTMLButtonElement>('#replay-load-button')?.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    window.document.querySelector<HTMLButtonElement>('#replay-play-button')?.click();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(window.document.querySelector('#replay-frame-label')?.textContent).toBe('1 / 2 帧');
    window.document.querySelector<HTMLButtonElement>('#replay-stop-button')?.click();
  });

  it('keeps real success unmeasured when an attested replay only accompanies training metrics', async () => {
    const common = {
      modelId: 'model-1',
      taskId: 'walk',
      status: 'completed',
      mock: false,
      artifact: { sha256: 'a'.repeat(64) },
    };
    const runs = [
      {
        ...common,
        id: 'sim',
        backend: 'local',
        createdAt: '2026-10-09',
        metrics: { contractValid: true, successRate: 0.8, physicsBackend: 'mujoco' },
      },
      {
        ...common,
        id: 'board',
        backend: 'contract',
        createdAt: '2026-10-10',
        metrics: { contractValid: true, successRate: 0.6 },
        evaluation: { replay: { source: 'board-agent', attested: true, sampleCount: 4 } },
      },
    ];
    const { window, errors } = await boot({ runs });
    expect(window.document.querySelector('#eval-sim-label')?.textContent).toBe('80%');
    expect(window.document.querySelector('#eval-real-label')?.textContent).toBe('—');
    expect(window.document.querySelector('#eval-comparison-note')?.textContent).toContain(
      '缺少明确真机成功率测量',
    );
    expect(errors).toEqual([]);
    const other = await boot({
      runs: [{ ...runs[1], artifact: { sha256: 'b'.repeat(64) } }, runs[0]],
    });
    expect(other.window.document.querySelector('#eval-real-label')?.textContent).toBe('—');
  });

  it('does not select a board replay Run as simulation because it retained a training physics backend', async () => {
    const common = {
      modelId: 'model-1',
      taskId: 'walk',
      status: 'completed',
      mock: false,
      artifact: { sha256: 'a'.repeat(64) },
    };
    const { window } = await boot({
      runs: [
        {
          ...common,
          id: 'sim',
          createdAt: '2026-10-09',
          backend: 'local',
          metrics: { contractValid: true, physicsBackend: 'mujoco', successRate: 0.8 },
        },
        {
          ...common,
          id: 'board',
          createdAt: '2026-10-10',
          backend: 'local',
          metrics: { contractValid: true, physicsBackend: 'mujoco', successRate: 0.99 },
          evaluation: { replay: { source: 'board-agent', attested: true, sampleCount: 4 } },
        },
      ],
    });
    expect(window.document.querySelector('#eval-sim-label')?.textContent).toBe('80%');
    expect(window.document.querySelector('#eval-real-label')?.textContent).toBe('—');
  });
});
