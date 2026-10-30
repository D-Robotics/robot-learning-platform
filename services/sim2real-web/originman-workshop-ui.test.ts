import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ORIGINMAN_WORKSHOP_MANIFEST } from '../../shared/originman-workshop.js';

const windows: JSDOM[] = [];
afterEach(() => {
  for (const dom of windows.splice(0)) dom.window.close();
});

function page(request: ReturnType<typeof vi.fn>) {
  const dom = new JSDOM(fs.readFileSync('services/sim2real-web/public/index.html', 'utf8'), {
    url: 'http://localhost/?workshop=originman#train',
    runScripts: 'outside-only',
  });
  windows.push(dom);
  dom.window.HTMLCanvasElement.prototype.getContext = (() => ({
    clearRect() {},
    fillText() {},
    beginPath() {},
    lineTo() {},
    moveTo() {},
    stroke() {},
  })) as never;
  dom.window.eval(fs.readFileSync('services/sim2real-web/public/originman-workshop.js', 'utf8'));
  const app = (
    dom.window as unknown as {
      OriginmanWorkshop: { mount: (options: unknown) => { refresh: () => Promise<void> } };
    }
  ).OriginmanWorkshop.mount({
    request,
    apiPath: (p: string) => '/api' + p,
    getOverview: () => ({}),
  });
  return { dom, document: dom.window.document, app };
}
const cfg = { phase: 'train', timesteps: 500000, seed: 7, pushMaxForce: 8.1 };
const model = { id: 'model-originman-test', manifest: ORIGINMAN_WORKSHOP_MANIFEST };

describe('OriginMan classroom browser behavior', () => {
  it('retries an uncertain submit using the same idempotency key and frozen body', async () => {
    const submits: { key: string; body: string }[] = [];
    const request = vi.fn(
      async (
        path: string,
        options?: { method?: string; body?: string; headers?: Record<string, string> },
      ) => {
        if (path.endsWith('/workshops/originman')) return { manifest: ORIGINMAN_WORKSHOP_MANIFEST };
        if (path.endsWith('/models')) return { models: [model] };
        if (path.endsWith('/runs') && options?.method === 'POST') {
          submits.push({ key: options.headers!['Idempotency-Key'], body: options.body! });
          if (submits.length === 1)
            throw Object.assign(new Error('response lost after acceptance'), { status: 503 });
          return { run: { id: 'accepted-run' } };
        }
        return { runs: [] };
      },
    );
    const { dom, document } = page(request);
    await vi.waitFor(() =>
      expect(document.getElementById('originman-status')!.textContent).toContain('可以创建'),
    );
    const form = document.getElementById('originman-workshop-form')!;
    form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() =>
      expect(document.getElementById('originman-train')!.textContent).toContain('重试同一'),
    );
    expect((document.getElementById('originman-steps') as HTMLInputElement).disabled).toBe(true);
    form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(submits).toHaveLength(2));
    expect(submits[1]).toEqual(submits[0]);
  });
  it('evaluates the selected frozen training rather than the currently edited form', async () => {
    const source = {
      id: 'source-run',
      status: 'completed',
      modelId: model.id,
      computeResourceId: 'source-worker',
      training: { engine: 'originman-recovery', originmanWorkshop: cfg },
    };
    let payload: Record<string, any> | undefined;
    const request = vi.fn(async (path: string, options?: { method?: string; body?: string }) => {
      if (path.endsWith('/workshops/originman')) return { manifest: ORIGINMAN_WORKSHOP_MANIFEST };
      if (path.endsWith('/models')) return { models: [model] };
      if (path.endsWith('/logs?after=0')) return { lines: [], total: 0 };
      if (path.endsWith('/runs') && options?.method === 'POST') {
        payload = JSON.parse(options.body!);
        return { run: { id: 'evaluation-run' } };
      }
      return { runs: [source] };
    });
    const { document } = page(request);
    await vi.waitFor(() =>
      expect((document.getElementById('originman-evaluate') as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    (document.getElementById('originman-seed') as HTMLInputElement).value = '27';
    (document.getElementById('originman-force') as HTMLInputElement).value = '7.5';
    (document.getElementById('originman-evaluate') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(payload).toBeDefined());
    expect(payload!.training.originmanWorkshop).toEqual({
      ...cfg,
      phase: 'evaluate',
      sourceRunId: source.id,
    });
    expect(payload!.computeResourceId).toBe('source-worker');
  });
});
