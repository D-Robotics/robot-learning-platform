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

function overview(runs?: unknown[]) {
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
  } = {},
) {
  const dom = new JSDOM(html, {
    url: 'http://127.0.0.1:3000/sim2real/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  openWindows.push(dom.window);
  const { window } = dom;
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
      if (url.includes('/overview')) payload = overview(options.runs);
      else if (url.includes('/workspace-summary')) {
        payload = { ok: true, counts: { models: 1, runs: 1, deployments: 0, devices: 0 } };
      } else if (url.endsWith('/projects') && method === 'POST')
        payload = { ok: true, project: options.createdProject || project() };
      else if (url.endsWith('/projects')) payload = { ok: true, projects: options.projects || [] };
      else if (url.endsWith('/datasets')) payload = { ok: true, datasets: [] };
      else if (url.includes('/models/model-1')) {
        payload = { ok: true, model: model(), compatibility: [] };
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
});
