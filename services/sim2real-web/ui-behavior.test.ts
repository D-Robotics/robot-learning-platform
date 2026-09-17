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
  extras: { artifacts?: unknown[]; evaluations?: unknown[]; deployments?: unknown[] } = {},
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
  } = {},
) {
  const dom = new JSDOM(html, {
    url: 'http://127.0.0.1:3000/sim2real/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  openWindows.push(dom.window);
  const { window } = dom;
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
      if (url.includes('/overview'))
        payload = overview(options.runs, {
          artifacts: options.artifacts,
          evaluations: options.evaluations,
          deployments: options.overviewDeployments,
        });
      else if (url.includes('/workspace-summary')) {
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
  return { window, errors, requests };
}

describe('Sim2Real workbench DOM behavior', () => {
  it('boots the real app bundle and changes one visible workspace view at a time', async () => {
    const { window, errors } = await boot();
    expect(window.document.querySelectorAll('.platform-score-item')).toHaveLength(5);
    expect(window.document.querySelector('#platform-score-total')?.textContent).toMatch(
      /^\d+\.\d$/,
    );
    const trainButton = window.document.querySelector<HTMLButtonElement>(
      '.sidebar [data-view-target="train"]',
    );
    trainButton?.click();

    expect(window.document.body.dataset.activeView).toBe('train');
    expect(trainButton?.getAttribute('aria-current')).toBe('page');
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
