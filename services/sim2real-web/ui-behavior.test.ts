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

async function boot() {
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
  Object.assign(window, {
    fetch: vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      let payload: unknown;
      if (url.includes('/overview')) payload = overview();
      else if (url.includes('/workspace-summary')) {
        payload = { ok: true, counts: { models: 1, runs: 1, deployments: 0, devices: 0 } };
      } else if (url.endsWith('/projects')) payload = { ok: true, projects: [] };
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
    if (window.document.querySelector('#main-content')?.getAttribute('aria-busy') === 'false') break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return { window, errors };
}

describe('Sim2Real workbench DOM behavior', () => {
  it('boots the real app bundle and changes one visible workspace view at a time', async () => {
    const { window, errors } = await boot();
    const trainButton = window.document.querySelector<HTMLButtonElement>(
      '.sidebar [data-view-target="train"]',
    );
    trainButton?.click();

    expect(window.document.body.dataset.activeView).toBe('train');
    expect(trainButton?.getAttribute('aria-current')).toBe('page');
    expect(
      window.document.querySelector<HTMLElement>('[data-view-section="train"]')?.hidden,
    ).toBe(false);
    expect(
      window.document.querySelector<HTMLElement>('[data-view-section="overview"]')?.hidden,
    ).toBe(true);
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
      input.dispatchEvent(
        new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
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
});
